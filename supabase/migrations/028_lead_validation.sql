-- 028: lead email validation with provenance.
--
-- Additive only. The historical `leads.validation_status` CHECK
-- (valid|invalid|risky|unknown) is retained and campaign 022 / dispatch 024
-- keep requiring `valid`. This migration adds *provenance* so an import or a
-- syntax pass can never be mistaken for a verified mailbox, and it protects
-- `validation_status` from browser-side spoofing.
--
-- Design contract:
--   * one durable operation row is reserved BEFORE any paid provider call;
--   * the operation UUID is the idempotency key (replaying never re-charges);
--   * lead row and operation are locked so concurrent operations and email
--     edits serialize;
--   * the finalize RPC is the only path that writes a provider claim, and it
--     requires an exact normalized address match on the provider receipt;
--   * imported reports are labeled `verified_import` and require owner
--     attestation plus a bounded report timestamp;
--   * an `unknown` result is held (one attempt, no automatic retry);
--   * suppressed / bounced leads are never revived to `valid`;
--   * changing a lead email resets validation_status and drops its evidence.
BEGIN;

-- ---------------------------------------------------------------------------
-- Provenance ledger
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.lead_validation_evidence (
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lead_id           uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  email             text NOT NULL,
  validation_status text NOT NULL CHECK (validation_status IN ('valid','invalid','risky','unknown')),
  substatus         text CHECK (substatus IS NULL OR length(substatus) BETWEEN 1 AND 100),
  verification_level text NOT NULL CHECK (verification_level IN ('verified_provider','verified_import','unverified_unknown','unverified_legacy')),
  source            text NOT NULL CHECK (length(source) BETWEEN 1 AND 100),
  reference         text CHECK (reference IS NULL OR length(reference) BETWEEN 1 AND 300),
  checked_at        timestamptz,
  actor_id          uuid,
  operation_id      uuid,
  attested          boolean NOT NULL DEFAULT false,
  note              text CHECK (note IS NULL OR length(note) <= 1000),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, lead_id),
  CHECK (email = lower(btrim(email)) AND length(email) <= 254)
);

CREATE TABLE IF NOT EXISTS public.lead_validation_operations (
  id                uuid PRIMARY KEY,
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lead_id           uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  actor_id          uuid NOT NULL,
  source            text NOT NULL CHECK (source IN ('zerobounce','imported_report')),
  email             text NOT NULL CHECK (email = lower(btrim(email)) AND length(email) <= 254),
  state             text NOT NULL CHECK (state IN ('reserved','completed','held_unknown','failed')),
  outcome           text CHECK (outcome IS NULL OR length(outcome) <= 100),
  validation_status text CHECK (validation_status IS NULL OR validation_status IN ('valid','invalid','risky','unknown')),
  -- Additive audit payload: the individual provider/report facts for this
  -- attempt, kept even when the lead's evidence row preserves a prior verdict.
  receipt           jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz
);

-- Idempotent upgrade for a database that already ran an earlier 028 draft.
ALTER TABLE public.lead_validation_operations ADD COLUMN IF NOT EXISTS receipt jsonb;

CREATE INDEX IF NOT EXISTS idx_lead_validation_operations_lead
  ON public.lead_validation_operations(organization_id, lead_id, created_at DESC);
-- Serializes the once-per-address hold across duplicate lead rows.
CREATE INDEX IF NOT EXISTS idx_lead_validation_operations_address
  ON public.lead_validation_operations(organization_id, email, state);

ALTER TABLE public.lead_validation_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_validation_operations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lead_validation_evidence_service_access ON public.lead_validation_evidence;
CREATE POLICY lead_validation_evidence_service_access ON public.lead_validation_evidence TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS lead_validation_operations_service_access ON public.lead_validation_operations;
CREATE POLICY lead_validation_operations_service_access ON public.lead_validation_operations TO service_role USING (true) WITH CHECK (true);

-- Browser roles get no direct access; reads go through the dashboard API and
-- service-role repository.
REVOKE ALL ON TABLE public.lead_validation_evidence FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.lead_validation_operations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.lead_validation_evidence TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.lead_validation_operations TO service_role;

-- ---------------------------------------------------------------------------
-- Protect validation_status from direct browser writes
--
-- The existing leads grants allow authenticated/anon to INSERT/UPDATE the
-- whole row. Re-grant every column except validation_status so existing
-- browser paths (leads PATCH, list assignment, status changes) keep working,
-- while only the service-role RPCs can write a validated claim.
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE ON TABLE public.leads FROM PUBLIC, anon, authenticated;
GRANT INSERT (
  id, organization_id, list_id, email, first_name, last_name, company, title,
  phone, linkedin_url, custom_fields, status, created_at, updated_at
) ON TABLE public.leads TO authenticated;
GRANT UPDATE (
  list_id, email, first_name, last_name, company, title, phone,
  linkedin_url, custom_fields, status, updated_at
) ON TABLE public.leads TO authenticated;

-- Changing the email invalidates any prior claim: clear the status and drop
-- evidence. Runs as the migration owner so the cleanup is not blocked by the
-- column-level grant above.
CREATE OR REPLACE FUNCTION public.lead_validation_reset_on_email_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    NEW.validation_status := NULL;
    DELETE FROM public.lead_validation_evidence
      WHERE organization_id = NEW.organization_id AND lead_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS leads_validation_reset_on_email_change ON public.leads;
CREATE TRIGGER leads_validation_reset_on_email_change
  BEFORE UPDATE OF email ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.lead_validation_reset_on_email_change();
REVOKE ALL ON FUNCTION public.lead_validation_reset_on_email_change() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.lead_validation_normalize_email(p_email text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(btrim(p_email));
$$;

-- Higher rank = stronger retained claim, used to stop an import downgrading a
-- known verdict. `unknown` is the weakest so a fresh valid import can upgrade
-- an ordinary unknown/no-evidence lead, while invalid/risky stay protected.
CREATE OR REPLACE FUNCTION public.lead_validation_rank(p_status text)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_status
    WHEN 'unknown' THEN 0 WHEN 'valid' THEN 1 WHEN 'risky' THEN 2 WHEN 'invalid' THEN 3
    ELSE 0 END;
$$;

CREATE OR REPLACE FUNCTION public.lead_validation_provider_status(p_status text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_status
    WHEN 'valid' THEN 'valid'
    WHEN 'invalid' THEN 'invalid'
    WHEN 'catch-all' THEN 'risky'
    WHEN 'spamtrap' THEN 'invalid'
    WHEN 'abuse' THEN 'invalid'
    WHEN 'do_not_mail' THEN 'invalid'
    ELSE 'unknown' END;
$$;

REVOKE ALL ON FUNCTION public.lead_validation_normalize_email(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lead_validation_rank(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lead_validation_provider_status(text) FROM PUBLIC, anon, authenticated;

-- True when the email is already suppressed (migration 023). Guarded with
-- to_regclass so the RPCs remain usable in a fixture without 023.
CREATE OR REPLACE FUNCTION public.lead_validation_is_suppressed(p_org uuid, p_email text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF to_regclass('public.outreach_suppressions') IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.outreach_suppressions
    WHERE organization_id = p_org AND normalized_email = p_email
  );
END $$;
REVOKE ALL ON FUNCTION public.lead_validation_is_suppressed(uuid,text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RPC 1: reserve an operation durably BEFORE the paid provider call.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lead_validation_reserve_operation(
  p_operation_id uuid, p_actor uuid, p_org uuid, p_lead uuid, p_source text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_role text; v_email text; v_norm text;
  v_op public.lead_validation_operations%ROWTYPE;
  v_unresolved public.lead_validation_operations%ROWTYPE;
BEGIN
  IF p_operation_id IS NULL OR p_actor IS NULL OR p_org IS NULL OR p_lead IS NULL THEN
    RAISE EXCEPTION 'lead_validation:invalid_input';
  END IF;
  IF p_source NOT IN ('zerobounce','imported_report') THEN
    RAISE EXCEPTION 'lead_validation:invalid_source';
  END IF;

  SELECT role INTO v_role FROM public.users
    WHERE id = p_actor AND organization_id = p_org FOR SHARE;
  IF v_role IS NULL OR v_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'lead_validation:forbidden';
  END IF;

  -- Shared per-organization dispatch lock (same key the 024 dispatcher uses).
  -- This serializes reservations for the same address across duplicate lead
  -- rows, so two different lead ids cannot each start a paid attempt.
  PERFORM pg_advisory_xact_lock(hashtextextended('email-dispatch:' || p_org::text, 0));

  -- Lock the lead first; this is the serialization point for both concurrent
  -- validations and a concurrent email change.
  SELECT email INTO v_email FROM public.leads
    WHERE id = p_lead AND organization_id = p_org FOR UPDATE;
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'lead_validation:lead_not_found';
  END IF;
  v_norm := public.lead_validation_normalize_email(v_email);
  IF v_norm !~ '^[^[:space:]@]+@[^[:space:]@]+$' THEN
    RAISE EXCEPTION 'lead_validation:invalid_email';
  END IF;

  SELECT * INTO v_op FROM public.lead_validation_operations WHERE id = p_operation_id FOR UPDATE;
  IF FOUND THEN
    IF v_op.organization_id <> p_org OR v_op.lead_id <> p_lead OR v_op.actor_id <> p_actor
       OR v_op.source <> p_source OR v_op.email <> v_norm THEN
      RAISE EXCEPTION 'lead_validation:operation_conflict';
    END IF;
    RETURN jsonb_build_object('operationId', v_op.id, 'email', v_op.email, 'state', v_op.state,
      'validationStatus', v_op.validation_status, 'replayed', true);
  END IF;

  -- A brand-new operation UUID must not bypass an unresolved earlier attempt
  -- for the same organization + normalized address, including when the same
  -- address sits on a duplicate lead row. The caller must resume the
  -- outstanding operation (or reconcile it) instead of paying again.
  SELECT * INTO v_unresolved FROM public.lead_validation_operations
    WHERE organization_id = p_org AND email = v_norm
      AND state IN ('reserved','held_unknown')
    ORDER BY created_at DESC
    LIMIT 1
    FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION 'lead_validation:unresolved_operation';
  END IF;

  INSERT INTO public.lead_validation_operations(id, organization_id, lead_id, actor_id, source, email, state)
    VALUES (p_operation_id, p_org, p_lead, p_actor, p_source, v_norm, 'reserved');
  RETURN jsonb_build_object('operationId', p_operation_id, 'email', v_norm, 'state', 'reserved',
    'validationStatus', NULL, 'replayed', false);
END $$;
REVOKE ALL ON FUNCTION public.lead_validation_reserve_operation(uuid,uuid,uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lead_validation_reserve_operation(uuid,uuid,uuid,uuid,text) TO service_role;

-- ---------------------------------------------------------------------------
-- RPC 2: finalize a ZeroBounce operation atomically.
-- Only an exact matching receipt can claim `verified_provider`.
-- `unknown` is held: one attempt, no automatic retry.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lead_validation_finalize_provider(
  p_operation_id uuid, p_actor uuid, p_org uuid, p_lead uuid, p_provider text,
  p_provider_email text, p_status text, p_substatus text, p_reference text, p_checked_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_role text; v_email text; v_norm text; v_op public.lead_validation_operations%ROWTYPE;
  v_claim_status text; v_claim_level text; v_effective text; v_suppressed boolean;
  v_prior_status text; v_prior_level text;
  v_receipt_matched boolean; v_receipt jsonb;
BEGIN
  SELECT role INTO v_role FROM public.users
    WHERE id = p_actor AND organization_id = p_org FOR SHARE;
  IF v_role IS NULL OR v_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'lead_validation:forbidden';
  END IF;

  SELECT email INTO v_email FROM public.leads
    WHERE id = p_lead AND organization_id = p_org FOR UPDATE;
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'lead_validation:lead_not_found';
  END IF;
  v_norm := public.lead_validation_normalize_email(v_email);

  SELECT * INTO v_op FROM public.lead_validation_operations WHERE id = p_operation_id FOR UPDATE;
  IF NOT FOUND OR v_op.source <> 'zerobounce' OR v_op.organization_id <> p_org
     OR v_op.lead_id <> p_lead OR v_op.actor_id <> p_actor THEN
    RAISE EXCEPTION 'lead_validation:operation_conflict';
  END IF;
  -- Same-lead/email CAS: the email the operation was reserved against must
  -- still be the lead's current email. The operation is failed and the result
  -- returned (not raised) so the audit record commits.
  IF v_op.email <> v_norm THEN
    UPDATE public.lead_validation_operations
      SET state='failed', outcome='email_changed', updated_at=now(), completed_at=now()
      WHERE id = p_operation_id;
    RETURN jsonb_build_object('operationId', p_operation_id, 'state', 'failed',
      'validationStatus', NULL, 'outcome', 'email_changed', 'replayed', false);
  END IF;
  IF v_op.state <> 'reserved' THEN
    -- Replay of a completed/held operation: never a second provider charge.
    RETURN jsonb_build_object('operationId', v_op.id, 'state', v_op.state,
      'validationStatus', v_op.validation_status, 'outcome', v_op.outcome, 'replayed', true);
  END IF;

  v_receipt_matched := p_provider = 'zerobounce' AND p_provider_email IS NOT NULL
    AND public.lead_validation_normalize_email(p_provider_email) = v_norm;

  IF v_receipt_matched THEN
    v_claim_status := public.lead_validation_provider_status(p_status);
    v_claim_level  := CASE WHEN v_claim_status = 'unknown' THEN 'unverified_unknown' ELSE 'verified_provider' END;
  ELSE
    -- The receipt does not match the lead address we asked about; it cannot
    -- support any claim, so it is recorded as an unverified unknown.
    v_claim_status := 'unknown';
    v_claim_level  := 'unverified_unknown';
  END IF;

  SELECT public.lead_validation_is_suppressed(p_org, v_norm) INTO v_suppressed;
  v_effective := v_claim_status;
  -- A suppressed/bounced lead is never revived by a fresh `valid`.
  IF v_suppressed AND v_claim_status = 'valid' THEN
    v_effective := 'invalid';
    v_claim_status := 'invalid';
    v_claim_level := 'unverified_unknown';
    v_receipt_matched := false;
  END IF;

  v_receipt := jsonb_strip_nulls(jsonb_build_object(
    'provider', p_provider,
    'providerStatus', p_status,
    'providerEmailMatched', v_receipt_matched,
    'claimStatus', v_claim_status,
    'substatus', NULLIF(left(coalesce(p_substatus,''),100),''),
    'checkedAt', p_checked_at,
    'reference', NULLIF(left(coalesce(p_reference,''),300),''),
    'suppressed', v_suppressed
  ));

  SELECT validation_status, verification_level INTO v_prior_status, v_prior_level
    FROM public.lead_validation_evidence
    WHERE organization_id = p_org AND lead_id = p_lead;

  -- A failed/unknown attempt (timeout, invalid response, address mismatch)
  -- must never destroy or relabel a prior measured/historical fact. Keep the
  -- prior evidence and status; record the attempt on the operation row so the
  -- history stays truthful.
  IF v_claim_status = 'unknown' AND v_prior_status IS NOT NULL THEN
    UPDATE public.lead_validation_operations
      SET state='held_unknown', outcome='unknown_hold', validation_status=v_prior_status,
          receipt=v_receipt, updated_at=now(), completed_at=now()
      WHERE id = p_operation_id;
    RETURN jsonb_build_object('operationId', p_operation_id, 'state', 'held_unknown',
      'validationStatus', v_prior_status, 'outcome', 'unknown_hold', 'replayed', false,
      'preservedPrior', true);
  END IF;

  UPDATE public.leads SET validation_status = v_effective
    WHERE id = p_lead AND organization_id = p_org;

  INSERT INTO public.lead_validation_evidence(
    organization_id, lead_id, email, validation_status, substatus, verification_level,
    source, reference, checked_at, actor_id, operation_id, attested, updated_at
  ) VALUES (
    p_org, p_lead, v_norm, v_claim_status, NULLIF(left(coalesce(p_substatus,''),100),''), v_claim_level,
    'zerobounce', NULLIF(left(coalesce(p_reference,''),300),''), coalesce(p_checked_at, now()),
    p_actor, p_operation_id, false, now()
  )
  ON CONFLICT (organization_id, lead_id) DO UPDATE SET
    email = excluded.email,
    validation_status = excluded.validation_status,
    substatus = excluded.substatus,
    verification_level = excluded.verification_level,
    source = excluded.source,
    reference = excluded.reference,
    checked_at = excluded.checked_at,
    actor_id = excluded.actor_id,
    operation_id = excluded.operation_id,
    attested = false,
    updated_at = now();

  IF v_claim_status = 'unknown' THEN
    UPDATE public.lead_validation_operations
      SET state='held_unknown', outcome='unknown_hold', validation_status='unknown',
          receipt=v_receipt, updated_at=now(), completed_at=now()
      WHERE id = p_operation_id;
    RETURN jsonb_build_object('operationId', p_operation_id, 'state', 'held_unknown',
      'validationStatus', 'unknown', 'outcome', 'unknown_hold', 'replayed', false);
  END IF;

  UPDATE public.lead_validation_operations
    SET state='completed', outcome=coalesce(NULLIF(left(coalesce(p_substatus,''),100),''), p_status),
        validation_status = v_claim_status, receipt=v_receipt, updated_at=now(), completed_at=now()
    WHERE id = p_operation_id;
  RETURN jsonb_build_object('operationId', p_operation_id, 'state', 'completed',
    'validationStatus', v_claim_status, 'outcome', coalesce(p_substatus, p_status), 'replayed', false);
END $$;
REVOKE ALL ON FUNCTION public.lead_validation_finalize_provider(uuid,uuid,uuid,uuid,text,text,text,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lead_validation_finalize_provider(uuid,uuid,uuid,uuid,text,text,text,text,text,timestamptz) TO service_role;

-- ---------------------------------------------------------------------------
-- RPC 3: import an explicitly attributed external validation report.
-- Requires owner/admin attestation and a bounded report timestamp. Imported
-- rows are labeled `verified_import`; they can never downgrade a stronger
-- invalid/risky/unknown claim, and they never claim a ZeroBounce receipt.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lead_validation_import_report(
  p_operation_id uuid, p_actor uuid, p_org uuid, p_lead uuid, p_status text,
  p_source text, p_reference text, p_reported_at timestamptz, p_attested boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_role text; v_email text; v_norm text; v_op public.lead_validation_operations%ROWTYPE;
  v_existing_status text; v_existing_level text; v_lead_status text; v_effective text;
  v_suppressed boolean; v_preserve_prior boolean; v_receipt jsonb;
BEGIN
  IF p_attested IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'lead_validation:attestation_required';
  END IF;
  IF p_status NOT IN ('valid','invalid','risky','unknown') THEN
    RAISE EXCEPTION 'lead_validation:invalid_status';
  END IF;
  IF p_source IS NULL OR length(btrim(p_source)) NOT BETWEEN 1 AND 100
     OR p_reference IS NULL OR length(btrim(p_reference)) NOT BETWEEN 1 AND 300
     OR p_reported_at IS NULL THEN
    RAISE EXCEPTION 'lead_validation:invalid_report';
  END IF;
  -- PM policy: an imported report must be dated within 30 days and cannot be
  -- more than 5 minutes in the future.
  IF p_reported_at > now() + interval '5 minutes'
     OR p_reported_at < now() - interval '30 days' THEN
    RAISE EXCEPTION 'lead_validation:stale_report';
  END IF;

  SELECT role INTO v_role FROM public.users
    WHERE id = p_actor AND organization_id = p_org FOR SHARE;
  IF v_role IS NULL OR v_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'lead_validation:forbidden';
  END IF;

  SELECT email, validation_status INTO v_email, v_lead_status FROM public.leads
    WHERE id = p_lead AND organization_id = p_org FOR UPDATE;
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'lead_validation:lead_not_found';
  END IF;
  v_norm := public.lead_validation_normalize_email(v_email);

  SELECT * INTO v_op FROM public.lead_validation_operations WHERE id = p_operation_id FOR UPDATE;
  IF FOUND THEN
    IF v_op.organization_id <> p_org OR v_op.lead_id <> p_lead OR v_op.actor_id <> p_actor
       OR v_op.source <> 'imported_report' OR v_op.email <> v_norm THEN
      RAISE EXCEPTION 'lead_validation:operation_conflict';
    END IF;
    RETURN jsonb_build_object('operationId', v_op.id, 'state', v_op.state,
      'validationStatus', v_op.validation_status, 'replayed', true);
  END IF;

  SELECT validation_status, verification_level INTO v_existing_status, v_existing_level
    FROM public.lead_validation_evidence WHERE organization_id = p_org AND lead_id = p_lead;
  -- A legacy/historical status with no evidence row still counts as a claim.
  IF v_existing_status IS NULL THEN
    v_existing_status := v_lead_status;
  END IF;

  -- Preserve a prior claim of equal or greater rank: an import must not
  -- downgrade invalid/risky back to valid, and an equal-rank import must not
  -- relabel an existing provider/measured receipt as an import. A fresh valid
  -- import still upgrades an ordinary unknown/no-evidence lead because unknown
  -- ranks below valid.
  v_preserve_prior := v_existing_status IS NOT NULL
    AND public.lead_validation_rank(v_existing_status) >= public.lead_validation_rank(p_status);

  IF v_existing_status IS NOT NULL
     AND public.lead_validation_rank(v_existing_status) > public.lead_validation_rank(p_status) THEN
    v_effective := v_existing_status;
  ELSE
    v_effective := p_status;
  END IF;

  SELECT public.lead_validation_is_suppressed(p_org, v_norm) INTO v_suppressed;
  IF v_suppressed AND v_effective = 'valid' THEN
    v_effective := 'invalid';
  END IF;

  v_receipt := jsonb_strip_nulls(jsonb_build_object(
    'provider', 'imported_report',
    'reportedStatus', p_status,
    'effectiveStatus', v_effective,
    'source', left(btrim(p_source),100),
    'reference', left(btrim(p_reference),300),
    'reportedAt', p_reported_at,
    'attested', true,
    'suppressed', v_suppressed,
    'preservedPrior', v_preserve_prior
  ));

  UPDATE public.leads SET validation_status = v_effective
    WHERE id = p_lead AND organization_id = p_org;

  -- Only write the evidence row when the import is the effective source of the
  -- status. When a prior verdict is preserved we keep its provenance untouched
  -- and record the import facts in the operation receipt instead.
  IF v_effective = p_status AND NOT v_preserve_prior THEN
    INSERT INTO public.lead_validation_evidence(
      organization_id, lead_id, email, validation_status, substatus, verification_level,
      source, reference, checked_at, actor_id, operation_id, attested, note, updated_at
    ) VALUES (
      p_org, p_lead, v_norm, v_effective, NULL, 'verified_import',
      left(btrim(p_source),100), left(btrim(p_reference),300), p_reported_at, p_actor,
      p_operation_id, true, 'Imported external validation report', now()
    )
    ON CONFLICT (organization_id, lead_id) DO UPDATE SET
      email = excluded.email,
      validation_status = excluded.validation_status,
      substatus = NULL,
      verification_level = excluded.verification_level,
      source = excluded.source,
      reference = excluded.reference,
      checked_at = excluded.checked_at,
      actor_id = excluded.actor_id,
      operation_id = excluded.operation_id,
      attested = true,
      note = excluded.note,
      updated_at = now();
  END IF;

  INSERT INTO public.lead_validation_operations(
    id, organization_id, lead_id, actor_id, source, email, state, outcome,
    validation_status, receipt, completed_at
  ) VALUES (
    p_operation_id, p_org, p_lead, p_actor, 'imported_report', v_norm, 'completed',
    'imported_report', v_effective, v_receipt, now()
  );

  RETURN jsonb_build_object('operationId', p_operation_id, 'state', 'completed',
    'validationStatus', v_effective, 'outcome', 'imported_report', 'replayed', false);
END $$;
REVOKE ALL ON FUNCTION public.lead_validation_import_report(uuid,uuid,uuid,uuid,text,text,text,timestamptz,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lead_validation_import_report(uuid,uuid,uuid,uuid,text,text,text,timestamptz,boolean) TO service_role;

-- ---------------------------------------------------------------------------
-- Service-only freshness predicate for dispatch (024). The dispatcher calls
-- this dynamically and treats its absence as "block": a lead is only current
-- when the address still matches, the status is valid, the evidence is a
-- provider receipt or an owner-attested import, and the proof is fresh
-- (checked within the last 30 days, no more than 5 minutes in the future).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lead_validation_is_current(
  p_org uuid, p_lead uuid, p_email text, p_now timestamptz
) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_norm text; v_lead_email text; v_lead_status text;
  v_status text; v_level text; v_checked timestamptz; v_attested boolean;
BEGIN
  IF p_org IS NULL OR p_lead IS NULL OR p_email IS NULL OR p_now IS NULL THEN
    RETURN false;
  END IF;
  v_norm := public.lead_validation_normalize_email(p_email);

  SELECT email, validation_status INTO v_lead_email, v_lead_status
    FROM public.leads WHERE id = p_lead AND organization_id = p_org;
  IF v_lead_email IS NULL THEN
    RETURN false;
  END IF;
  -- The proof must be about the lead's *current* normalized address.
  IF public.lead_validation_normalize_email(v_lead_email) <> v_norm
     OR v_lead_status IS DISTINCT FROM 'valid' THEN
    RETURN false;
  END IF;

  SELECT validation_status, verification_level, checked_at, attested
    INTO v_status, v_level, v_checked, v_attested
    FROM public.lead_validation_evidence
    WHERE organization_id = p_org AND lead_id = p_lead AND email = v_norm;
  IF v_level IS NULL OR v_level NOT IN ('verified_provider','verified_import') THEN
    RETURN false;
  END IF;
  IF v_status IS DISTINCT FROM 'valid' THEN
    RETURN false;
  END IF;
  -- An imported proof only counts when the owner attested it.
  IF v_level = 'verified_import' AND v_attested IS DISTINCT FROM true THEN
    RETURN false;
  END IF;
  IF v_checked IS NULL THEN
    RETURN false;
  END IF;
  IF v_checked > p_now + interval '5 minutes' THEN
    RETURN false;
  END IF;
  IF v_checked < p_now - interval '30 days' THEN
    RETURN false;
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.lead_validation_is_current(uuid,uuid,text,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lead_validation_is_current(uuid,uuid,text,timestamptz) TO service_role;

COMMIT;
