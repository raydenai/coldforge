-- 019: Atomic pre-send eligibility (SEC-006, CAM-004, CAM-007)
--
-- Before this migration the pre-send suppression check was a bare SELECT in
-- application code (src/lib/smtp/queue.ts), taken some time before the send.
-- Two defects followed:
--
--   1. Time-of-check/time-of-use. A suppression written between the check and
--      the send was missed.
--   2. No send-level idempotency. A redelivered job could send the same touch
--      twice, which for cold outreach is both a complaint driver and, after an
--      opt-out, a compliance failure.
--
-- HONEST LIMIT: an SMTP handoff cannot enrol in a Postgres transaction. This
-- does NOT give exactly-once delivery. What it gives is:
--   * suppression check and slot claim in ONE transaction, so those two cannot
--     interleave with each other;
--   * a unique idempotency key per planned touch, so a duplicate job is refused
--     rather than sent twice;
--   * a definitive record of intent-to-send that a later reconciliation pass can
--     compare against provider receipts.
-- The achievable model remains at-least-once execution with deterministic
-- idempotency keys. Callers must still re-check suppression immediately before
-- the provider handoff.

CREATE TABLE IF NOT EXISTS send_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Deterministic per planned touch. Shape:
  --   campaign:{campaignId}:lead:{leadId}:step:{stepVersion}:attempt:{logicalAttempt}
  -- Two workers computing the same touch compute the same key.
  idempotency_key TEXT NOT NULL UNIQUE,

  email TEXT NOT NULL,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,

  campaign_id UUID,
  lead_id UUID,

  -- Set once the provider accepts the message.
  dispatched_at TIMESTAMPTZ,
  provider_message_id TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_send_claims_email ON send_claims (email);
CREATE INDEX IF NOT EXISTS idx_send_claims_workspace ON send_claims (workspace_id);
CREATE INDEX IF NOT EXISTS idx_send_claims_undispatched
  ON send_claims (created_at) WHERE dispatched_at IS NULL;

-- Multiple GLOBAL suppressions for one address were possible, because
-- UNIQUE(workspace_id, email) does not constrain rows where workspace_id IS
-- NULL (NULL is never equal to NULL in a unique index). This makes the global
-- case genuinely unique.
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_suppressions_global_unique
  ON email_suppressions (email) WHERE workspace_id IS NULL;

-- Atomic: check suppression and claim the slot in one transaction.
--
-- Returns (allowed, reason):
--   (true,  NULL)         -> claim recorded, caller may proceed
--   (false, '<reason>')   -> suppressed; reason is the suppression reason
--   (false, 'duplicate')  -> this exact touch was already claimed
CREATE OR REPLACE FUNCTION claim_send_slot(
  p_idempotency_key TEXT,
  p_email TEXT,
  p_workspace_id UUID,
  p_campaign_id UUID DEFAULT NULL,
  p_lead_id UUID DEFAULT NULL
)
RETURNS TABLE (allowed BOOLEAN, reason TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email TEXT := lower(btrim(p_email));
  v_reason TEXT;
BEGIN
  IF v_email IS NULL OR v_email = '' THEN
    RETURN QUERY SELECT false, 'invalid_email'::TEXT;
    RETURN;
  END IF;

  SELECT s.reason INTO v_reason
  FROM email_suppressions s
  WHERE s.email = v_email
    AND s.is_active = true
    AND (s.workspace_id IS NULL OR s.workspace_id = p_workspace_id)
    AND (s.expires_at IS NULL OR s.expires_at > NOW())
  LIMIT 1;

  IF v_reason IS NOT NULL THEN
    RETURN QUERY SELECT false, v_reason;
    RETURN;
  END IF;

  BEGIN
    INSERT INTO send_claims (idempotency_key, email, workspace_id, campaign_id, lead_id)
    VALUES (p_idempotency_key, v_email, p_workspace_id, p_campaign_id, p_lead_id);
  EXCEPTION
    WHEN unique_violation THEN
      RETURN QUERY SELECT false, 'duplicate'::TEXT;
      RETURN;
  END;

  RETURN QUERY SELECT true, NULL::TEXT;
END;
$$;

-- Mark a claim dispatched once the provider has accepted the message.
CREATE OR REPLACE FUNCTION mark_send_dispatched(
  p_idempotency_key TEXT,
  p_provider_message_id TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated INTEGER;
BEGIN
  UPDATE send_claims
     SET dispatched_at = NOW(),
         provider_message_id = COALESCE(p_provider_message_id, provider_message_id)
   WHERE idempotency_key = p_idempotency_key
     AND dispatched_at IS NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

-- Release a claim when the send failed and should be retried. Without this a
-- transient SMTP failure would permanently block the touch via the unique key.
CREATE OR REPLACE FUNCTION release_send_claim(p_idempotency_key TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM send_claims
   WHERE idempotency_key = p_idempotency_key
     AND dispatched_at IS NULL;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END;
$$;

ALTER TABLE send_claims ENABLE ROW LEVEL SECURITY;

-- Claims are written by the service role through the functions above, never by
-- end users. Tenants may read their own for operator dashboards.
CREATE POLICY send_claims_tenant_read ON send_claims
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
    )
  );

COMMENT ON TABLE send_claims IS
  'One row per planned touch. Unique idempotency_key prevents duplicate sends. See migration 019 for the atomicity guarantee and its limits.';
