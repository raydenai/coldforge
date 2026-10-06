-- Server-admin fallback for deployments without the historical signup trigger.
BEGIN;
CREATE FUNCTION public.bootstrap_email_identity(p_user_id uuid, p_organization_name text DEFAULT NULL)
RETURNS TABLE(organization_id uuid, role text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE user_email text; display_name text; org_id uuid; user_role text; org_name text;
BEGIN
  -- The caller is a service-only server adapter; identity comes from its verified cookie session.
  -- Lock the auth row even when no public.users row exists yet.
  SELECT email, left(raw_user_meta_data->>'full_name',100) INTO user_email,display_name FROM auth.users WHERE id=p_user_id FOR UPDATE;
  IF NOT FOUND OR user_email IS NULL THEN RAISE EXCEPTION 'authenticated identity not found' USING ERRCODE='22023'; END IF;
  IF p_organization_name IS NOT NULL AND (length(btrim(p_organization_name)) NOT BETWEEN 1 AND 100) THEN RAISE EXCEPTION 'invalid organization name' USING ERRCODE='22023'; END IF;
  SELECT u.organization_id,u.role INTO org_id,user_role FROM public.users u WHERE u.id=p_user_id FOR UPDATE;
  IF org_id IS NOT NULL THEN RETURN QUERY SELECT org_id,user_role; RETURN; END IF;
  org_name := coalesce(nullif(btrim(p_organization_name),''),split_part(user_email,'@',1)||'''s Organization');
  INSERT INTO public.organizations(name,slug,plan,settings) VALUES(org_name,'org-'||p_user_id::text,'starter','{}') RETURNING id INTO org_id;
  INSERT INTO public.users(id,organization_id,email,full_name,role,settings) VALUES(p_user_id,org_id,user_email,display_name,'owner','{}')
  ON CONFLICT(id) DO UPDATE SET organization_id=EXCLUDED.organization_id,role='owner',updated_at=now() WHERE users.organization_id IS NULL;
  -- A concurrent administrator attaching an existing public row must never be overwritten.
  IF NOT FOUND THEN
    DELETE FROM public.organizations WHERE id=org_id;
    SELECT u.organization_id,u.role INTO org_id,user_role FROM public.users u WHERE u.id=p_user_id;
    IF org_id IS NULL THEN RAISE EXCEPTION 'membership changed concurrently'; END IF;
    RETURN QUERY SELECT org_id,user_role; RETURN;
  END IF;
  RETURN QUERY SELECT org_id,'owner'::text;
END $$;
REVOKE ALL ON FUNCTION public.bootstrap_email_identity(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bootstrap_email_identity(uuid,text) TO service_role;
COMMIT;
