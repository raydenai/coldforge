BEGIN;
CREATE TABLE IF NOT EXISTS public.winnr_mailbox_credentials (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES public.winnr_connections(id) ON DELETE CASCADE,
  provider_mailbox_id text NOT NULL CHECK(length(provider_mailbox_id) BETWEEN 1 AND 200),
  connection_version integer NOT NULL CHECK(connection_version>0),
  email text NOT NULL,
  account_id uuid NOT NULL REFERENCES public.email_accounts(id),
  credentials_ciphertext text NOT NULL CHECK(length(credentials_ciphertext) BETWEEN 1 AND 100000),
  synced_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(organization_id,connection_id,provider_mailbox_id),
  UNIQUE(organization_id,connection_id,email)
);
ALTER TABLE public.winnr_mailbox_credentials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS winnr_mailbox_credentials_service_access ON public.winnr_mailbox_credentials;
CREATE POLICY winnr_mailbox_credentials_service_access ON public.winnr_mailbox_credentials TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE public.winnr_mailbox_credentials FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.winnr_mailbox_credentials TO service_role;

CREATE OR REPLACE FUNCTION public.winnr_sync_smtp_credentials(
  p_actor uuid,p_org uuid,p_connection uuid,p_version integer,p_mailboxes jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_role text; v_current integer; r jsonb; v_account uuid; v_output jsonb := '[]'; v_now timestamptz := clock_timestamp();
BEGIN
  SELECT role INTO v_role FROM public.users WHERE id=p_actor AND organization_id=p_org FOR SHARE;
  IF v_role IS NULL OR v_role NOT IN ('owner','admin') THEN RAISE EXCEPTION 'winnr_smtp:forbidden'; END IF;
  SELECT version INTO v_current FROM public.winnr_connections WHERE id=p_connection AND organization_id=p_org FOR UPDATE;
  IF NOT FOUND OR v_current<>p_version THEN RAISE EXCEPTION 'winnr_smtp:stale_connection'; END IF;
  IF jsonb_typeof(p_mailboxes) IS DISTINCT FROM 'array' OR jsonb_array_length(p_mailboxes) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'winnr_smtp:invalid_input'; END IF;
  IF EXISTS(SELECT value->>'providerMailboxId' FROM jsonb_array_elements(p_mailboxes) GROUP BY value->>'providerMailboxId' HAVING count(*)>1)
    OR EXISTS(SELECT value->>'email' FROM jsonb_array_elements(p_mailboxes) GROUP BY value->>'email' HAVING count(*)>1) THEN RAISE EXCEPTION 'winnr_smtp:invalid_input'; END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p_mailboxes) LOOP
    IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR r->>'providerMailboxId' IS NULL OR length(r->>'providerMailboxId') NOT BETWEEN 1 AND 200
      OR r->>'email' IS NULL OR (r->>'email') !~ '^[^[:space:]@]+@[^[:space:]@]+$'
      OR r->>'ciphertext' IS NULL OR length(r->>'ciphertext') NOT BETWEEN 1 AND 100000 THEN RAISE EXCEPTION 'winnr_smtp:invalid_input'; END IF;
    SELECT account_id INTO v_account FROM public.winnr_mailbox_credentials
      WHERE organization_id=p_org AND connection_id=p_connection AND provider_mailbox_id=r->>'providerMailboxId';
    IF v_account IS NOT NULL AND EXISTS(SELECT 1 FROM public.email_accounts WHERE id=v_account AND organization_id=p_org AND email<>r->>'email') THEN RAISE EXCEPTION 'winnr_smtp:identity_changed'; END IF;
    IF v_account IS NULL THEN
      SELECT id INTO v_account FROM public.email_accounts WHERE organization_id=p_org AND email=r->>'email' AND provider='smtp' ORDER BY id LIMIT 1 FOR UPDATE;
    END IF;
    IF v_account IS NULL THEN
      -- Canonical browser-readable account contains only nonsecret metadata.
      INSERT INTO public.email_accounts(organization_id,email,display_name,provider,status)
        VALUES(p_org,r->>'email',coalesce(r->>'displayName',''),'smtp','active') RETURNING id INTO v_account;
    ELSE
      IF NOT EXISTS(SELECT 1 FROM public.email_accounts WHERE id=v_account AND organization_id=p_org AND provider='smtp') THEN RAISE EXCEPTION 'winnr_smtp:invalid_binding'; END IF;
      UPDATE public.email_accounts SET display_name=coalesce(r->>'displayName',''),updated_at=v_now WHERE id=v_account AND organization_id=p_org;
    END IF;
    INSERT INTO public.winnr_mailbox_credentials(organization_id,connection_id,provider_mailbox_id,connection_version,email,account_id,credentials_ciphertext,synced_at)
      VALUES(p_org,p_connection,r->>'providerMailboxId',p_version,r->>'email',v_account,r->>'ciphertext',v_now)
      ON CONFLICT(organization_id,connection_id,provider_mailbox_id) DO UPDATE SET
        connection_version=excluded.connection_version,credentials_ciphertext=excluded.credentials_ciphertext,synced_at=excluded.synced_at;
    v_output := v_output || jsonb_build_array(jsonb_build_object('providerMailboxId',r->>'providerMailboxId','email',r->>'email','accountId',v_account,'syncedAt',v_now));
    v_account := NULL;
  END LOOP;
  RETURN v_output;
END;
$$;
REVOKE ALL ON FUNCTION public.winnr_sync_smtp_credentials(uuid,uuid,uuid,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.winnr_sync_smtp_credentials(uuid,uuid,uuid,integer,jsonb) TO service_role;
COMMIT;
