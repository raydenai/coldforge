-- 021: Durable channel-independent outreach event spine
--
-- One organization-scoped event ledger plus a transactional consumer outbox.
-- The canonical v1 event is:
--
--   { version: 1, organizationId, type, source, sourceEventId, occurredAt,
--     correlationId (nullable), causationId (nullable),
--     subject { leadId?, campaignId?, messageId?, appointmentId? },
--     data (JSON object) }
--
-- Contracts enforced here (not only in application code):
--   * `outreach_append_event` validates the full canonical envelope at the
--     trust boundary (version, body-org equality, JSON string types, ASCII,
--     root/subject key allow-lists, UUID subject ids and the bounded JSON
--     size/depth/key rules) so no admitted row can later poison a claim batch.
--     Numeric leaves must round-trip to a finite JavaScript double, and
--     `occurredAt` must normalize to a UTC year in 1..9999, so every committed
--     row can always be re-normalized when claimed.
--   * `unique (organization_id, source, source_event_id)` deduplicates
--     ingestion. Repeating the identical canonical content is idempotent;
--     reusing the identity with different content or a different consumer set
--     is a conflict.
--   * `outreach_append_event` inserts the event and every named consumer in one
--     statement, so a consumer failure rolls the event back too. The consumer
--     set may be empty for audit-only events, which persist with zero outbox
--     rows and dedupe against the empty set.
--   * Consumers claim work with a fencing UUID lease under
--     `FOR UPDATE SKIP LOCKED`; acknowledgement/failure/unknown require the
--     live token AND its exact expiry, so a stale token can never settle a
--     successor claim.
--   * An expired lease is never replayed: `running` moves to `unknown` and is
--     held. Only an explicit, bounded retryable failure (before any external
--     effect) becomes eligible again.
--
-- The tables and functions are service-only: RLS is enabled, every privilege is
-- revoked from PUBLIC/anon/authenticated, and only `service_role` is granted
-- access. No browser path may read or write either table.
--
-- No provider effect is performed here; this migration owns only durable state.

BEGIN;

-- ---------------------------------------------------------------------------
-- Canonical event ledger.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.outreach_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Canonical schema version. No pre-version-1 events were ever deployed, so
  -- only version 1 is admissible.
  version INTEGER NOT NULL CHECK (version = 1),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (length(type) BETWEEN 1 AND 128),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 128),
  source_event_id TEXT NOT NULL CHECK (length(source_event_id) BETWEEN 1 AND 256),
  occurred_at TIMESTAMPTZ NOT NULL,
  correlation_id TEXT CHECK (correlation_id IS NULL OR length(correlation_id) BETWEEN 1 AND 256),
  causation_id TEXT CHECK (causation_id IS NULL OR length(causation_id) BETWEEN 1 AND 256),
  lead_id UUID,
  campaign_id UUID,
  message_id UUID,
  appointment_id UUID,
  data JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
  -- Server-computed deterministic fingerprint (sha256 hex). Stored for
  -- observability only: duplicate detection compares stored canonical fields
  -- and the consumer set, never trusting this caller-supplied value alone.
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT outreach_events_identity_key UNIQUE (organization_id, source, source_event_id),
  -- Composite key for the outbox tenant cross-check.
  CONSTRAINT outreach_events_id_org_key UNIQUE (id, organization_id)
);

CREATE INDEX IF NOT EXISTS outreach_events_org_occurred_idx
  ON public.outreach_events (organization_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS outreach_events_org_type_idx
  ON public.outreach_events (organization_id, type);
CREATE INDEX IF NOT EXISTS outreach_events_lead_idx
  ON public.outreach_events (organization_id, lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS outreach_events_campaign_idx
  ON public.outreach_events (organization_id, campaign_id) WHERE campaign_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Consumer outbox. One row per (event, named consumer).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.outreach_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  event_id UUID NOT NULL,
  consumer TEXT NOT NULL CHECK (length(consumer) BETWEEN 1 AND 128),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'retryable', 'succeeded', 'failed', 'unknown')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 50),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 1024),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT outreach_outbox_event_consumer_key UNIQUE (event_id, consumer),
  -- Tenant cross-check by FK: an outbox row can never reference another
  -- organization's event.
  CONSTRAINT outreach_outbox_event_org_fkey
    FOREIGN KEY (event_id, organization_id)
    REFERENCES public.outreach_events (id, organization_id) ON DELETE CASCADE,
  -- A running row always carries a lease; every other state carries none, so a
  -- settled row can never be mistaken for an in-flight claim.
  CONSTRAINT outreach_outbox_lease_pair CHECK (
    (status = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'running' AND lease_token IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS outreach_outbox_claim_idx
  ON public.outreach_outbox (organization_id, consumer, status, available_at);

-- ---------------------------------------------------------------------------
-- Atomic append. Identity + content + consumer set all participate in the
-- idempotency decision; the caller's fingerprint is recorded but not trusted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.outreach_append_event(
  p_organization_id UUID,
  p_event JSONB,
  p_consumers TEXT[],
  p_fingerprint TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- Single canonical source of truth shared with `src/lib/outreach/events.ts`.
  c_version CONSTANT INTEGER := 1;
  c_max_data_bytes CONSTANT INTEGER := 16384;
  c_max_data_keys CONSTANT INTEGER := 256;
  c_max_data_depth CONSTANT INTEGER := 6;
  -- IEEE-754 double bounds shared with JavaScript `JSON.parse` semantics. Every
  -- jsonb numeric leaf must survive as a finite double (no overflow to
  -- Infinity, no nonzero underflow to 0) before it can be committed.
  c_max_js_double CONSTANT NUMERIC := 1.7976931348623157e308;
  c_min_js_double CONSTANT NUMERIC := 4.9406564584124654e-324;
  c_uuid_re CONSTANT TEXT := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  c_printable_re CONSTANT TEXT := '^[ -~]+$';
  c_instant_re CONSTANT TEXT := '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$';
  v_version INTEGER;
  v_type TEXT;
  v_source TEXT;
  v_source_event_id TEXT;
  v_occurred_at TIMESTAMPTZ;
  v_correlation TEXT;
  v_causation TEXT;
  v_subject JSONB;
  v_data JSONB;
  v_lead UUID;
  v_campaign UUID;
  v_message UUID;
  v_appointment UUID;
  v_consumer TEXT;
  v_existing public.outreach_events%ROWTYPE;
  v_existing_consumers TEXT[];
  v_requested_consumers TEXT[];
  v_current JSONB;
  v_next JSONB;
  v_level_keys INTEGER;
  v_depth INTEGER;
  v_keys INTEGER;
  v_id UUID;
BEGIN
  IF p_organization_id IS NULL
     OR p_fingerprint IS NULL
     OR length(p_fingerprint) <> 64
     OR p_event IS NULL
     OR jsonb_typeof(p_event) <> 'object' THEN
    RETURN jsonb_build_object('result', 'invalid', 'reason', 'bad_request');
  END IF;

  -- The canonical envelope is an allow-list: no unknown root key may slip in.
  IF EXISTS (
    SELECT 1
    FROM jsonb_object_keys(p_event) AS k
    WHERE k NOT IN (
      'version', 'organizationId', 'type', 'source', 'sourceEventId',
      'occurredAt', 'correlationId', 'causationId', 'subject', 'data'
    )
  ) THEN
    RETURN jsonb_build_object('result', 'invalid', 'reason', 'unknown_event_key');
  END IF;

  -- Version is explicit and required. No pre-version-1 events exist.
  IF jsonb_typeof(p_event->'version') IS DISTINCT FROM 'number' THEN
    RETURN jsonb_build_object('result', 'invalid', 'reason', 'bad_version');
  END IF;
  BEGIN
    v_version := (p_event->>'version')::integer;
  EXCEPTION WHEN others THEN
    RETURN jsonb_build_object('result', 'invalid', 'reason', 'bad_version');
  END;
  IF v_version IS DISTINCT FROM c_version THEN
    RETURN jsonb_build_object('result', 'invalid', 'reason', 'unsupported_version');
  END IF;

  -- The body organization must be a string and must match the RPC argument,
  -- otherwise a caller could persist tenant A's event under tenant B.
  IF jsonb_typeof(p_event->'organizationId') IS DISTINCT FROM 'string' THEN
    RETURN jsonb_build_object('result', 'invalid', 'reason', 'bad_organization');
  END IF;
  IF (p_event->>'organizationId') IS DISTINCT FROM p_organization_id::text THEN
    RETURN jsonb_build_object('result', 'invalid', 'reason', 'organization_mismatch');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = p_organization_id) THEN
    RETURN jsonb_build_object('result', 'invalid', 'reason', 'unknown_organization');
  END IF;

  -- Identity fields must be JSON strings (not coerced numbers/objects), ASCII,
  -- and non-blank, exactly as the TypeScript `boundedId` schema requires.
  IF jsonb_typeof(p_event->'type') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_event->'source') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_event->'sourceEventId') IS DISTINCT FROM 'string' THEN
    RETURN jsonb_build_object('result', 'invalid', 'reason', 'bad_identity');
  END IF;

  v_type := p_event->>'type';
  v_source := p_event->>'source';
  v_source_event_id := p_event->>'sourceEventId';
  v_correlation := NULL;
  v_causation := NULL;

  IF length(v_type) NOT BETWEEN 1 AND 128
     OR v_type !~ c_printable_re OR btrim(v_type) = ''
     OR length(v_source) NOT BETWEEN 1 AND 128
     OR v_source !~ c_printable_re OR btrim(v_source) = ''
     OR length(v_source_event_id) NOT BETWEEN 1 AND 256
     OR v_source_event_id !~ c_printable_re OR btrim(v_source_event_id) = '' THEN
    RETURN jsonb_build_object('result', 'invalid', 'reason', 'bad_identity');
  END IF;

  -- correlationId / causationId: absent or JSON null, otherwise a bounded id.
  IF p_event->'correlationId' IS NOT NULL
     AND jsonb_typeof(p_event->'correlationId') IS DISTINCT FROM 'null' THEN
    IF jsonb_typeof(p_event->'correlationId') IS DISTINCT FROM 'string' THEN
      RETURN jsonb_build_object('result', 'invalid', 'reason', 'bad_correlation');
    END IF;
    v_correlation := p_event->>'correlationId';
    IF length(v_correlation) NOT BETWEEN 1 AND 256
       OR v_correlation !~ c_printable_re OR btrim(v_correlation) = '' THEN
      RETURN jsonb_build_object('result', 'invalid', 'reason', 'bad_correlation');
    END IF;
  END IF;
  IF p_event->'causationId' IS NOT NULL
     AND jsonb_typeof(p_event->'causationId') IS DISTINCT FROM 'null' THEN
    IF jsonb_typeof(p_event->'causationId') IS DISTINCT FROM 'string' THEN
      RETURN jsonb_build_object('result', 'invalid', 'reason', 'bad_causation');
    END IF;
    v_causation := p_event->>'causationId';
    IF length(v_causation) NOT BETWEEN 1 AND 256
       OR v_causation !~ c_printable_re OR btrim(v_causation) = '' THEN
      RETURN jsonb_build_object('result', 'invalid', 'reason', 'bad_causation');
    END IF;
  END IF;

  -- occurredAt: a JSON string with an explicit timezone; the cast rejects
  -- calendar rollover (`2026-02-30`) and the regex rejects local-time shorthand.
  IF jsonb_typeof(p_event->'occurredAt') IS DISTINCT FROM 'string'
     OR (p_event->>'occurredAt') !~ c_instant_re THEN
    RETURN jsonb_build_object('result', 'invalid', 'reason', 'bad_timestamp');
  END IF;
  BEGIN
    v_occurred_at := (p_event->>'occurredAt')::timestamptz;
  EXCEPTION WHEN others THEN
    RETURN jsonb_build_object('result', 'invalid', 'reason', 'bad_timestamp');
  END;
  IF v_occurred_at IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid', 'reason', 'bad_timestamp');
  END IF;
  -- A timezone offset can roll the UTC instant outside the canonical four-digit
  -- year (`9999-12-31T23:59:59-01:00`). Evaluate in UTC so the boundary does not
  -- depend on the session timezone, and reject before insertion.
  IF EXTRACT(YEAR FROM (v_occurred_at AT TIME ZONE 'UTC'))::INTEGER NOT BETWEEN 1 AND 9999 THEN
    RETURN jsonb_build_object('result', 'invalid', 'reason', 'timestamp_out_of_range');
  END IF;

  -- Subject: plain object, allow-listed keys, each value JSON null or a UUID
  -- string (never a coerced number or empty string).
  v_subject := COALESCE(p_event->'subject', '{}'::jsonb);
  IF jsonb_typeof(v_subject) <> 'object' THEN
    RETURN jsonb_build_object('result', 'invalid', 'reason', 'bad_subject');
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(v_subject) AS k
    WHERE k NOT IN ('leadId', 'campaignId', 'messageId', 'appointmentId')
  ) THEN
    RETURN jsonb_build_object('result', 'invalid', 'reason', 'unknown_subject_key');
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_each(v_subject) AS e(key, value)
    WHERE jsonb_typeof(e.value) IS DISTINCT FROM 'null'
      AND (
        jsonb_typeof(e.value) IS DISTINCT FROM 'string'
        OR (e.value #>> '{}') !~* c_uuid_re
      )
  ) THEN
    RETURN jsonb_build_object('result', 'invalid', 'reason', 'bad_subject');
  END IF;

  BEGIN
    IF jsonb_typeof(v_subject->'leadId') = 'string' THEN
      v_lead := (v_subject->>'leadId')::uuid;
    END IF;
    IF jsonb_typeof(v_subject->'campaignId') = 'string' THEN
      v_campaign := (v_subject->>'campaignId')::uuid;
    END IF;
    IF jsonb_typeof(v_subject->'messageId') = 'string' THEN
      v_message := (v_subject->>'messageId')::uuid;
    END IF;
    IF jsonb_typeof(v_subject->'appointmentId') = 'string' THEN
      v_appointment := (v_subject->>'appointmentId')::uuid;
    END IF;
  EXCEPTION WHEN others THEN
    RETURN jsonb_build_object('result', 'invalid', 'reason', 'bad_subject');
  END;

  -- Tenant cross-check at the trust boundary: a subject id that belongs to a
  -- different organization is rejected rather than silently linked.
  IF v_lead IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.leads WHERE id = v_lead AND organization_id = p_organization_id
  ) THEN
    RETURN jsonb_build_object('result', 'invalid', 'reason', 'subject_tenant_mismatch');
  END IF;
  IF v_campaign IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.campaigns WHERE id = v_campaign AND organization_id = p_organization_id
  ) THEN
    RETURN jsonb_build_object('result', 'invalid', 'reason', 'subject_tenant_mismatch');
  END IF;

  -- Data: plain object bounded the same way the TypeScript layer bounds it.
  v_data := COALESCE(p_event->'data', '{}'::jsonb);
  IF jsonb_typeof(v_data) <> 'object' THEN
    RETURN jsonb_build_object('result', 'invalid', 'reason', 'bad_payload');
  END IF;

  -- Canonical JSON bytes, measured on PostgreSQL's canonical jsonb text.
  IF octet_length(v_data::text) > c_max_data_bytes THEN
    RETURN jsonb_build_object('result', 'invalid', 'reason', 'data_too_large');
  END IF;

  -- Bounded breadth-first walk over the canonical JSON tree: reject any
  -- container deeper than the shared limit and cap the total object key count.
  v_current := jsonb_build_array(v_data);
  v_depth := 1;
  v_keys := 0;
  LOOP
    SELECT COALESCE(sum(
      CASE WHEN jsonb_typeof(n.value) = 'object'
           THEN (SELECT count(*) FROM jsonb_object_keys(n.value)) ELSE 0 END
    ), 0)
      INTO v_level_keys
      FROM jsonb_array_elements(v_current) AS n(value);
    v_keys := v_keys + v_level_keys;
    IF v_depth > c_max_data_depth AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_current) AS n(value)
      WHERE jsonb_typeof(n.value) IN ('object', 'array')
    ) THEN
      RETURN jsonb_build_object('result', 'invalid', 'reason', 'data_too_deep');
    END IF;
    IF v_keys > c_max_data_keys THEN
      RETURN jsonb_build_object('result', 'invalid', 'reason', 'data_too_many_keys');
    END IF;

    -- jsonb numerics have arbitrary precision, but a claimed event is parsed by
    -- JavaScript `JSON.parse` and must remain a finite double. Reject overflow
    -- (`1e400` -> Infinity) and nonzero underflow (`1e-400` -> 0) at every level.
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_current) AS n(value)
      WHERE CASE
        WHEN jsonb_typeof(n.value) = 'number' THEN
          abs((n.value #>> '{}')::numeric) > c_max_js_double
          OR ((n.value #>> '{}')::numeric <> 0
              AND abs((n.value #>> '{}')::numeric) < c_min_js_double)
        ELSE false
      END
    ) THEN
      RETURN jsonb_build_object('result', 'invalid', 'reason', 'data_number_out_of_range');
    END IF;

    SELECT COALESCE(jsonb_agg(child.value), '[]'::jsonb)
      INTO v_next
      FROM jsonb_array_elements(v_current) AS n(value)
      CROSS JOIN LATERAL (
        SELECT e.value FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(n.value) = 'array' THEN n.value ELSE '[]'::jsonb END
        ) AS e(value)
        UNION ALL
        SELECT e.value FROM jsonb_each(
          CASE WHEN jsonb_typeof(n.value) = 'object' THEN n.value ELSE '{}'::jsonb END
        ) AS e(key, value)
      ) AS child;

    EXIT WHEN jsonb_array_length(v_next) = 0;
    v_current := v_next;
    v_depth := v_depth + 1;
  END LOOP;

  -- Consumers: an audit-only event may have ZERO consumers. Duplicate or
  -- null/badly-typed names are still rejected; only the cardinality floor is
  -- removed.
  IF p_consumers IS NULL OR cardinality(p_consumers) > 32 THEN
    RETURN jsonb_build_object('result', 'invalid', 'reason', 'bad_consumers');
  END IF;
  FOREACH v_consumer IN ARRAY p_consumers LOOP
    IF v_consumer IS NULL
       OR length(v_consumer) NOT BETWEEN 1 AND 128
       OR v_consumer !~ c_printable_re
       OR btrim(v_consumer) = '' THEN
      RETURN jsonb_build_object('result', 'invalid', 'reason', 'bad_consumer');
    END IF;
  END LOOP;

  INSERT INTO public.outreach_events (
    version, organization_id, type, source, source_event_id, occurred_at,
    correlation_id, causation_id, lead_id, campaign_id, message_id,
    appointment_id, data, fingerprint
  ) VALUES (
    v_version, p_organization_id, v_type, v_source, v_source_event_id, v_occurred_at,
    v_correlation, v_causation, v_lead, v_campaign, v_message,
    v_appointment, v_data, p_fingerprint
  )
  ON CONFLICT (organization_id, source, source_event_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT * INTO v_existing
      FROM public.outreach_events
      WHERE organization_id = p_organization_id
        AND source = v_source
        AND source_event_id = v_source_event_id;

    SELECT COALESCE(array_agg(consumer ORDER BY consumer), ARRAY[]::TEXT[])
      INTO v_existing_consumers
      FROM public.outreach_outbox
      WHERE event_id = v_existing.id;

    SELECT COALESCE(array_agg(c ORDER BY c), ARRAY[]::TEXT[])
      INTO v_requested_consumers
      FROM unnest(p_consumers) AS c;

    IF v_existing.version = v_version
       AND v_existing.type = v_type
       AND v_existing.occurred_at = v_occurred_at
       AND v_existing.correlation_id IS NOT DISTINCT FROM v_correlation
       AND v_existing.causation_id IS NOT DISTINCT FROM v_causation
       AND v_existing.lead_id IS NOT DISTINCT FROM v_lead
       AND v_existing.campaign_id IS NOT DISTINCT FROM v_campaign
       AND v_existing.message_id IS NOT DISTINCT FROM v_message
       AND v_existing.appointment_id IS NOT DISTINCT FROM v_appointment
       AND v_existing.data = v_data
       AND v_existing_consumers = v_requested_consumers
    THEN
      RETURN jsonb_build_object('result', 'duplicate', 'event_id', v_existing.id);
    END IF;
    RETURN jsonb_build_object('result', 'conflict', 'event_id', v_existing.id);
  END IF;

  -- Same statement/transaction as the event insert. A consumer failure (for
  -- example a duplicate name in the array) aborts the whole append. With an
  -- empty consumer set this inserts nothing: the event is durably persisted as
  -- an audit-only record with no outbox rows.
  INSERT INTO public.outreach_outbox (organization_id, event_id, consumer)
    SELECT p_organization_id, v_id, c FROM unnest(p_consumers) AS c;

  RETURN jsonb_build_object('result', 'created', 'event_id', v_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- Expire overdue leases to a held UNKNOWN state. Never replayed
-- automatically: an in-flight external effect must be reconciled by a human.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.outreach_expire_leases(
  p_organization_id UUID
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF p_organization_id IS NULL THEN
    RETURN 0;
  END IF;
  UPDATE public.outreach_outbox
    SET status = 'unknown',
        lease_token = NULL,
        lease_expires_at = NULL,
        last_error = 'lease_expired',
        updated_at = now()
    WHERE organization_id = p_organization_id
      AND status = 'running'
      AND lease_expires_at < now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- Claim available work for one consumer with a fencing lease.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.outreach_claim_outbox(
  p_organization_id UUID,
  p_consumer TEXT,
  p_lease_token UUID,
  p_lease_seconds INTEGER,
  p_limit INTEGER
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET timezone = 'UTC'
AS $$
DECLARE
  v_result JSONB;
BEGIN
  IF p_organization_id IS NULL
     OR p_consumer IS NULL OR length(p_consumer) NOT BETWEEN 1 AND 128
     OR p_lease_token IS NULL
     OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 1 AND 3600
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RETURN jsonb_build_object('result', 'invalid', 'reason', 'bad_request');
  END IF;

  -- Expiry runs before selection so an expired in-flight row becomes unknown
  -- and is excluded; it can never be handed out twice.
  PERFORM public.outreach_expire_leases(p_organization_id);

  WITH candidate AS (
    SELECT o.id
      FROM public.outreach_outbox o
      WHERE o.organization_id = p_organization_id
        AND o.consumer = p_consumer
        AND o.status IN ('pending', 'retryable')
        AND o.available_at <= now()
        AND o.attempts < o.max_attempts
      ORDER BY o.available_at, o.created_at
      FOR UPDATE SKIP LOCKED
      LIMIT p_limit
  ), claimed AS (
    UPDATE public.outreach_outbox o
      SET status = 'running',
          lease_token = p_lease_token,
          lease_expires_at = now() + make_interval(secs => p_lease_seconds),
          attempts = o.attempts + 1,
          updated_at = now()
      FROM candidate c
      WHERE o.id = c.id
      RETURNING o.id, o.event_id, o.attempts, o.lease_expires_at
  )
  SELECT jsonb_build_object(
    'result', 'claimed',
    'jobs', COALESCE(jsonb_agg(jsonb_build_object(
      'outboxId', cl.id,
      'eventId', cl.event_id,
      'attempts', cl.attempts,
      'leaseExpiresAt', cl.lease_expires_at,
      'event', jsonb_build_object(
        'version', e.version,
        'organizationId', e.organization_id,
        'type', e.type,
        'source', e.source,
        'sourceEventId', e.source_event_id,
        'occurredAt', e.occurred_at,
        'correlationId', e.correlation_id,
        'causationId', e.causation_id,
        'subject', jsonb_strip_nulls(jsonb_build_object(
          'leadId', e.lead_id,
          'campaignId', e.campaign_id,
          'messageId', e.message_id,
          'appointmentId', e.appointment_id
        )),
        'data', e.data
      )
    )), '[]'::jsonb)
  )
  INTO v_result
  FROM claimed cl
  JOIN public.outreach_events e
    ON e.id = cl.event_id AND e.organization_id = p_organization_id;

  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Settle a live claim. The token AND its exact expiry must still be current,
-- which is what prevents a stale worker from settling a successor claim.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.outreach_ack_outbox(
  p_organization_id UUID,
  p_outbox_id UUID,
  p_lease_token UUID,
  p_lease_expires_at TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rows INTEGER;
BEGIN
  IF p_organization_id IS NULL OR p_outbox_id IS NULL
     OR p_lease_token IS NULL OR p_lease_expires_at IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid', 'reason', 'bad_request');
  END IF;

  UPDATE public.outreach_outbox
    SET status = 'succeeded',
        lease_token = NULL,
        lease_expires_at = NULL,
        updated_at = now()
    WHERE id = p_outbox_id
      AND organization_id = p_organization_id
      AND status = 'running'
      AND lease_token = p_lease_token
      AND lease_expires_at = p_lease_expires_at
      AND lease_expires_at > now();

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 1 THEN
    RETURN jsonb_build_object('result', 'acked');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.outreach_outbox
    WHERE id = p_outbox_id AND organization_id = p_organization_id
  ) THEN
    RETURN jsonb_build_object('result', 'stale');
  END IF;
  RETURN jsonb_build_object('result', 'not_found');
END;
$$;

-- ---------------------------------------------------------------------------
-- Explicit failure. A retryable failure before any external effect becomes
-- eligible again after bounded exponential backoff; otherwise the row is
-- terminally failed and never automatically retried.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.outreach_fail_outbox(
  p_organization_id UUID,
  p_outbox_id UUID,
  p_lease_token UUID,
  p_lease_expires_at TIMESTAMPTZ,
  p_error_code TEXT,
  p_retryable BOOLEAN
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job public.outreach_outbox%ROWTYPE;
BEGIN
  IF p_organization_id IS NULL OR p_outbox_id IS NULL
     OR p_lease_token IS NULL OR p_lease_expires_at IS NULL
     OR p_retryable IS NULL
     OR (p_error_code IS NOT NULL AND length(p_error_code) > 1024) THEN
    RETURN jsonb_build_object('result', 'invalid', 'reason', 'bad_request');
  END IF;

  SELECT * INTO v_job
    FROM public.outreach_outbox
    WHERE id = p_outbox_id AND organization_id = p_organization_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  IF v_job.status <> 'running'
     OR v_job.lease_token IS DISTINCT FROM p_lease_token
     OR v_job.lease_expires_at IS DISTINCT FROM p_lease_expires_at
     OR v_job.lease_expires_at <= now() THEN
    RETURN jsonb_build_object('result', 'stale');
  END IF;

  IF p_retryable AND v_job.attempts < v_job.max_attempts THEN
    UPDATE public.outreach_outbox
      SET status = 'retryable',
          available_at = now() + make_interval(secs => least(300, power(2, v_job.attempts)::int)),
          lease_token = NULL,
          lease_expires_at = NULL,
          last_error = p_error_code,
          updated_at = now()
      WHERE id = v_job.id;
    RETURN jsonb_build_object('result', 'retryable', 'attempts', v_job.attempts);
  END IF;

  UPDATE public.outreach_outbox
    SET status = 'failed',
        lease_token = NULL,
        lease_expires_at = NULL,
        last_error = p_error_code,
        updated_at = now()
    WHERE id = v_job.id;
  RETURN jsonb_build_object('result', 'failed', 'attempts', v_job.attempts);
END;
$$;

-- ---------------------------------------------------------------------------
-- Explicit unknown. An operator/worker declares that an external effect may
-- have occurred; the row is held and is never automatically eligible again.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.outreach_mark_unknown(
  p_organization_id UUID,
  p_outbox_id UUID,
  p_lease_token UUID,
  p_lease_expires_at TIMESTAMPTZ,
  p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job public.outreach_outbox%ROWTYPE;
BEGIN
  IF p_organization_id IS NULL OR p_outbox_id IS NULL
     OR p_lease_token IS NULL OR p_lease_expires_at IS NULL
     OR (p_reason IS NOT NULL AND length(p_reason) > 1024) THEN
    RETURN jsonb_build_object('result', 'invalid', 'reason', 'bad_request');
  END IF;

  SELECT * INTO v_job
    FROM public.outreach_outbox
    WHERE id = p_outbox_id AND organization_id = p_organization_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  IF v_job.status <> 'running'
     OR v_job.lease_token IS DISTINCT FROM p_lease_token
     OR v_job.lease_expires_at IS DISTINCT FROM p_lease_expires_at
     OR v_job.lease_expires_at <= now() THEN
    RETURN jsonb_build_object('result', 'stale');
  END IF;

  UPDATE public.outreach_outbox
    SET status = 'unknown',
        lease_token = NULL,
        lease_expires_at = NULL,
        last_error = p_reason,
        updated_at = now()
    WHERE id = v_job.id;
  RETURN jsonb_build_object('result', 'unknown');
END;
$$;

-- ---------------------------------------------------------------------------
-- Lock down: service-only tables and functions. No browser role may read or
-- write the ledger or execute a privileged RPC.
-- ---------------------------------------------------------------------------
ALTER TABLE public.outreach_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.outreach_events, public.outreach_outbox FROM PUBLIC;

DO $$
DECLARE
  r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['public', 'anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.outreach_events FROM %I', r);
      EXECUTE format('REVOKE ALL ON TABLE public.outreach_outbox FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.outreach_append_event(UUID, JSONB, TEXT[], TEXT) FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.outreach_claim_outbox(UUID, TEXT, UUID, INTEGER, INTEGER) FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.outreach_ack_outbox(UUID, UUID, UUID, TIMESTAMPTZ) FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.outreach_fail_outbox(UUID, UUID, UUID, TIMESTAMPTZ, TEXT, BOOLEAN) FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.outreach_mark_unknown(UUID, UUID, UUID, TIMESTAMPTZ, TEXT) FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.outreach_expire_leases(UUID) FROM %I', r);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT ALL ON TABLE public.outreach_events TO service_role';
    EXECUTE 'GRANT ALL ON TABLE public.outreach_outbox TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.outreach_append_event(UUID, JSONB, TEXT[], TEXT) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.outreach_claim_outbox(UUID, TEXT, UUID, INTEGER, INTEGER) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.outreach_ack_outbox(UUID, UUID, UUID, TIMESTAMPTZ) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.outreach_fail_outbox(UUID, UUID, UUID, TIMESTAMPTZ, TEXT, BOOLEAN) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.outreach_mark_unknown(UUID, UUID, UUID, TIMESTAMPTZ, TEXT) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.outreach_expire_leases(UUID) TO service_role';
    -- RLS with a service-only policy in case the runtime role lacks BYPASSRLS.
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'outreach_events'
        AND policyname = 'outreach_events_service_all'
    ) THEN
      EXECUTE 'CREATE POLICY outreach_events_service_all ON public.outreach_events FOR ALL TO service_role USING (true) WITH CHECK (true)';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'outreach_outbox'
        AND policyname = 'outreach_outbox_service_all'
    ) THEN
      EXECUTE 'CREATE POLICY outreach_outbox_service_all ON public.outreach_outbox FOR ALL TO service_role USING (true) WITH CHECK (true)';
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.outreach_append_event(UUID, JSONB, TEXT[], TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.outreach_claim_outbox(UUID, TEXT, UUID, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.outreach_ack_outbox(UUID, UUID, UUID, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.outreach_fail_outbox(UUID, UUID, UUID, TIMESTAMPTZ, TEXT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.outreach_mark_unknown(UUID, UUID, UUID, TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.outreach_expire_leases(UUID) FROM PUBLIC;

COMMIT;
