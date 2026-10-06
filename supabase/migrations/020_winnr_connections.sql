-- 020: Winnr organization connection + durable provider-operation ledger (Task 3)
--
-- Two service-role-only tables:
--   * winnr_connections     one encrypted connection per organization, with a
--                            monotonically increasing version for optimistic
--                            concurrency and a globally unique provider account
--                            id so one Winnr account cannot serve two tenants.
--   * winnr_operations      append-only reservation ledger for non-idempotent
--                            provider mutations. Rows survive disconnect
--                            (connection_id becomes NULL) so held/uncertain
--                            operations stay reviewable.
--
-- All locking and version comparison happens in SQL functions below, not in
-- application code, so concurrent connect/disconnect/warm-up requests cannot
-- interleave. RLS is enabled and every table/function privilege is revoked from
-- public/anon/authenticated and granted only to service_role.

BEGIN;

-- Winnr authorization relies on users.role and users.organization_id. The
-- legacy own-profile UPDATE policy must not permit editing those trust fields.
-- Preserve the existing profile editor's four columns, under existing RLS.
REVOKE UPDATE ON public.users FROM PUBLIC, anon, authenticated;
REVOKE UPDATE (id, organization_id, role, email, created_at) ON public.users FROM PUBLIC, anon, authenticated;
GRANT UPDATE (full_name, avatar_url, settings, updated_at) ON public.users TO authenticated;
-- Membership creation is owned by the SECURITY DEFINER signup trigger or an
-- authenticated server-side admin workflow, never an arbitrary browser insert.
REVOKE INSERT ON public.users FROM PUBLIC, anon, authenticated;
REVOKE INSERT (id, organization_id, role, email, full_name, avatar_url, settings, created_at, updated_at)
  ON public.users FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.winnr_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider_account_id TEXT NOT NULL,
  token_ciphertext TEXT NOT NULL,
  account_name TEXT NOT NULL DEFAULT '',
  account_plan TEXT,
  permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  universal_inbox_enabled BOOLEAN NOT NULL DEFAULT false,
  version INTEGER NOT NULL DEFAULT 1,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A Winnr account must map to exactly one ColdForge organization.
CREATE UNIQUE INDEX IF NOT EXISTS winnr_connections_provider_account_id_key
  ON public.winnr_connections (provider_account_id);

CREATE TABLE IF NOT EXISTS public.winnr_operations (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- Nullable on purpose: disconnect sets this NULL and the operation survives.
  connection_id UUID REFERENCES public.winnr_connections(id) ON DELETE SET NULL,
  connection_version INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('enable', 'pause', 'resume')),
  mailbox_ids JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'rejected', 'unknown')),
  request_fingerprint TEXT NOT NULL,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS winnr_operations_org_status_idx
  ON public.winnr_operations (organization_id, status);
CREATE INDEX IF NOT EXISTS winnr_operations_mailbox_idx
  ON public.winnr_operations USING GIN (mailbox_ids);

-- ---------------------------------------------------------------------------
-- Atomic reservation. Serializes on the organization's connection row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.winnr_reserve_operation(
  p_organization_id UUID,
  p_operation_id UUID,
  p_connection_id UUID,
  p_connection_version INTEGER,
  p_action TEXT,
  p_mailbox_ids JSONB,
  p_fingerprint TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_conn public.winnr_connections%ROWTYPE;
  v_existing public.winnr_operations%ROWTYPE;
  v_block public.winnr_operations%ROWTYPE;
  v_mailbox TEXT;
BEGIN
  SELECT * INTO v_conn
    FROM public.winnr_connections
    WHERE organization_id = p_organization_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  IF v_conn.id <> p_connection_id OR v_conn.version <> p_connection_version THEN
    RETURN jsonb_build_object('result', 'stale');
  END IF;

  -- Idempotency: a reused operation id never reaches the provider again.
  SELECT * INTO v_existing FROM public.winnr_operations WHERE id = p_operation_id;
  IF FOUND THEN
    IF v_existing.organization_id <> p_organization_id THEN
      RETURN jsonb_build_object('result', 'operation_id_conflict');
    END IF;
    IF v_existing.request_fingerprint <> p_fingerprint THEN
      RETURN jsonb_build_object('result', 'fingerprint_mismatch');
    END IF;
    RETURN jsonb_build_object('result', 'duplicate', 'operation_status', v_existing.status);
  END IF;

  -- A mailbox with a pending/unknown operation is held regardless of action or id.
  FOR v_mailbox IN SELECT jsonb_array_elements_text(p_mailbox_ids) LOOP
    SELECT * INTO v_block
      FROM public.winnr_operations
      WHERE organization_id = p_organization_id
        AND status IN ('pending', 'unknown')
        AND mailbox_ids ? v_mailbox
      ORDER BY created_at
      LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'result', 'blocked',
        'operation_status', v_block.status,
        'operation_id', v_block.id
      );
    END IF;
  END LOOP;

  INSERT INTO public.winnr_operations (
    id, organization_id, connection_id, connection_version,
    action, mailbox_ids, status, request_fingerprint
  ) VALUES (
    p_operation_id, p_organization_id, v_conn.id, p_connection_version,
    p_action, p_mailbox_ids, 'pending', p_fingerprint
  );

  RETURN jsonb_build_object('result', 'reserved');
END;
$$;

-- ---------------------------------------------------------------------------
-- Settle a held operation. Only a pending row may transition; a lost settle
-- leaves the row pending so the caller can report an uncertain outcome.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.winnr_settle_operation(
  p_organization_id UUID,
  p_operation_id UUID,
  p_status TEXT,
  p_error_code TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rows INTEGER;
BEGIN
  IF p_status NOT IN ('succeeded', 'rejected', 'unknown') THEN
    RETURN false;
  END IF;

  UPDATE public.winnr_operations
    SET status = p_status,
        error_code = p_error_code,
        updated_at = now(),
        settled_at = CASE WHEN p_status = 'unknown' THEN NULL ELSE now() END
    WHERE id = p_operation_id
      AND organization_id = p_organization_id
      AND status = 'pending';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

-- ---------------------------------------------------------------------------
-- Connect / reconnect. Verifies expected identity + version under a row lock.
-- Changing the provider account is allowed only with no pending/unknown work.
-- Existence is implied by the caller's successful `GET /v1/account` proof.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.winnr_save_connection(
  p_organization_id UUID,
  p_provider_account_id TEXT,
  p_token_ciphertext TEXT,
  p_account_name TEXT,
  p_account_plan TEXT,
  p_permissions JSONB,
  p_universal_inbox_enabled BOOLEAN,
  p_expected_connection_id UUID,
  p_expected_version INTEGER
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_conn public.winnr_connections%ROWTYPE;
  v_pending INTEGER;
  v_new_id UUID;
  v_new_version INTEGER;
BEGIN
  SELECT * INTO v_conn
    FROM public.winnr_connections
    WHERE organization_id = p_organization_id
    FOR UPDATE;

  IF FOUND THEN
    IF p_expected_connection_id IS NULL OR p_expected_version IS NULL
       OR v_conn.id <> p_expected_connection_id
       OR v_conn.version <> p_expected_version THEN
      RETURN jsonb_build_object('result', 'stale');
    END IF;

    -- Even token rotation waits until the in-flight/unknown operation settles.
      SELECT count(*) INTO v_pending
        FROM public.winnr_operations
        WHERE organization_id = p_organization_id
          AND status IN ('pending', 'unknown');
      IF v_pending > 0 THEN
        RETURN jsonb_build_object('result', 'blocked');
      END IF;
    UPDATE public.winnr_connections
      SET provider_account_id = p_provider_account_id,
          token_ciphertext = p_token_ciphertext,
          account_name = p_account_name,
          account_plan = p_account_plan,
          permissions = p_permissions,
          universal_inbox_enabled = p_universal_inbox_enabled,
          version = v_conn.version + 1,
          verified_at = now(),
          updated_at = now()
      WHERE id = v_conn.id;

    RETURN jsonb_build_object('result', 'saved', 'connection_id', v_conn.id, 'version', v_conn.version + 1);
  END IF;

  IF p_expected_connection_id IS NOT NULL OR p_expected_version IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'stale');
  END IF;

  BEGIN
    INSERT INTO public.winnr_connections (
      organization_id, provider_account_id, token_ciphertext,
      account_name, account_plan, permissions, universal_inbox_enabled
    ) VALUES (
      p_organization_id, p_provider_account_id, p_token_ciphertext,
      p_account_name, p_account_plan, p_permissions, p_universal_inbox_enabled
    )
    RETURNING id, version INTO v_new_id, v_new_version;
  EXCEPTION WHEN unique_violation THEN
    -- Either another org owns this Winnr account, or a concurrent connect won.
    RETURN jsonb_build_object('result', 'account_taken');
  END;

  RETURN jsonb_build_object('result', 'saved', 'connection_id', v_new_id, 'version', v_new_version);
END;
$$;

-- ---------------------------------------------------------------------------
-- Disconnect. Removes only the local encrypted connection. Pending/unknown
-- operations block it, and the operation rows are preserved.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.winnr_delete_connection(
  p_organization_id UUID,
  p_expected_connection_id UUID,
  p_expected_version INTEGER
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_conn public.winnr_connections%ROWTYPE;
  v_pending INTEGER;
BEGIN
  SELECT * INTO v_conn
    FROM public.winnr_connections
    WHERE organization_id = p_organization_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  IF v_conn.id <> p_expected_connection_id OR v_conn.version <> p_expected_version THEN
    RETURN jsonb_build_object('result', 'stale');
  END IF;

  SELECT count(*) INTO v_pending
    FROM public.winnr_operations
    WHERE organization_id = p_organization_id
      AND status IN ('pending', 'unknown');

  IF v_pending > 0 THEN
    RETURN jsonb_build_object('result', 'blocked');
  END IF;

  DELETE FROM public.winnr_connections WHERE id = v_conn.id;
  RETURN jsonb_build_object('result', 'deleted');
END;
$$;

-- ---------------------------------------------------------------------------
-- Lock down: no browser role may read ciphertext or call privileged functions.
-- ---------------------------------------------------------------------------
ALTER TABLE public.winnr_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.winnr_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.winnr_connections, public.winnr_operations FROM PUBLIC;

DO $$
DECLARE
  r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['public', 'anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.winnr_connections FROM %I', r);
      EXECUTE format('REVOKE ALL ON TABLE public.winnr_operations FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.winnr_reserve_operation(UUID, UUID, UUID, INTEGER, TEXT, JSONB, TEXT) FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.winnr_settle_operation(UUID, UUID, TEXT, TEXT) FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.winnr_save_connection(UUID, TEXT, TEXT, TEXT, TEXT, JSONB, BOOLEAN, UUID, INTEGER) FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.winnr_delete_connection(UUID, UUID, INTEGER) FROM %I', r);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT ALL ON TABLE public.winnr_connections TO service_role';
    EXECUTE 'GRANT ALL ON TABLE public.winnr_operations TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.winnr_reserve_operation(UUID, UUID, UUID, INTEGER, TEXT, JSONB, TEXT) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.winnr_settle_operation(UUID, UUID, TEXT, TEXT) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.winnr_save_connection(UUID, TEXT, TEXT, TEXT, TEXT, JSONB, BOOLEAN, UUID, INTEGER) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.winnr_delete_connection(UUID, UUID, INTEGER) TO service_role';
  END IF;
END;
$$;

-- Explicitly forbid broad execute on the new functions even where the role
-- list above does not apply.
REVOKE ALL ON FUNCTION public.winnr_reserve_operation(UUID, UUID, UUID, INTEGER, TEXT, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.winnr_settle_operation(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.winnr_save_connection(UUID, TEXT, TEXT, TEXT, TEXT, JSONB, BOOLEAN, UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.winnr_delete_connection(UUID, UUID, INTEGER) FROM PUBLIC;

COMMIT;
