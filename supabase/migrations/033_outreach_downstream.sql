-- 033 bounded configured downstream outreach (CRM/calendar, CloseBot bridge, Retell callbacks).
--
-- Additive over the reviewed email-first core. Nothing here sends email: an
-- external freeform message is only ever stored as a proposal that must pass
-- the 029 prepared/shared gate by a separate operator-approved action. This
-- migration owns:
--   * per-organization provider connections with an encrypted credential, an
--     optimistic revision (CAS), an explicit disabled default and a
--     server-recorded read-only capability check;
--   * CRM links, appointments, callback eligibility/callbacks, explicit
--     qualification records and CloseBot bridge records;
--   * a durable downstream effect ledger whose stable logical key is
--     independent of any browser UUID or config version, so an effect is
--     reserved exactly once before each non-idempotent provider call;
--   * two service-only SECURITY DEFINER RPCs. The browser-facing one returns
--     presence-only connection metadata and never the ciphertext.
BEGIN;

-- ---------------------------------------------------------------------------
-- Provider connections. `enabled` is deliberately false by default and a saved
-- configuration is never treated as a verified connection; only an explicit
-- owner/admin recorded read-only check sets `verified_at`.
-- ---------------------------------------------------------------------------
CREATE TABLE public.outreach_provider_connections (
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  provider text NOT NULL CHECK(provider IN('ghl','closebot','retell')),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  enabled boolean NOT NULL DEFAULT false,
  credential_ciphertext text CHECK(credential_ciphertext IS NULL OR length(credential_ciphertext) BETWEEN 1 AND 100000),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  capability jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_check_at timestamptz,
  last_check_ok boolean,
  last_check_detail text,
  verified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  PRIMARY KEY(organization_id,provider)
);

CREATE TABLE public.outreach_crm_links (
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  lead_id uuid NOT NULL REFERENCES public.leads(id),
  provider text NOT NULL CHECK(provider IN('ghl')),
  external_contact_id text,
  external_opportunity_id text,
  location_id text,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,lead_id)
);
CREATE UNIQUE INDEX outreach_crm_links_contact ON public.outreach_crm_links(organization_id,location_id,external_contact_id) WHERE external_contact_id IS NOT NULL;

CREATE TABLE public.outreach_appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  lead_id uuid NOT NULL REFERENCES public.leads(id),
  campaign_id uuid REFERENCES public.campaigns(id),
  thread_id uuid REFERENCES public.threads(id),
  provider text NOT NULL DEFAULT 'ghl' CHECK(provider IN('ghl')),
  calendar_id text NOT NULL CHECK(length(calendar_id) BETWEEN 1 AND 200),
  location_id text CHECK(location_id IS NULL OR length(location_id) BETWEEN 1 AND 200),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  timezone text NOT NULL CHECK(length(timezone) BETWEEN 1 AND 80),
  status text NOT NULL DEFAULT 'reserved' CHECK(status IN('reserved','unknown','scheduled','rescheduled','cancelled','failed')),
  logical_key text NOT NULL CHECK(length(logical_key) BETWEEN 1 AND 300),
  provider_appointment_id text,
  connection_revision bigint,
  provider_receipt jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE(organization_id,logical_key),
  CHECK(ends_at IS NULL OR ends_at>starts_at)
);
CREATE UNIQUE INDEX outreach_appointments_provider ON public.outreach_appointments(organization_id,provider,provider_appointment_id) WHERE provider_appointment_id IS NOT NULL;

CREATE TABLE public.outreach_callback_eligibility (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  lead_id uuid NOT NULL REFERENCES public.leads(id),
  phone_e164 text NOT NULL CHECK(phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  timezone text NOT NULL CHECK(length(timezone) BETWEEN 1 AND 80),
  window_start_hour smallint NOT NULL CHECK(window_start_hour BETWEEN 0 AND 23),
  window_end_hour smallint NOT NULL CHECK(window_end_hour BETWEEN 1 AND 24),
  expires_at timestamptz NOT NULL,
  max_calls smallint NOT NULL DEFAULT 1 CHECK(max_calls BETWEEN 1 AND 10),
  calls_started smallint NOT NULL DEFAULT 0 CHECK(calls_started>=0),
  consent_basis text NOT NULL CHECK(length(consent_basis) BETWEEN 1 AND 500),
  evidence text NOT NULL CHECK(length(evidence) BETWEEN 1 AND 2000),
  revoked_at timestamptz,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  recorded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(window_end_hour>window_start_hour)
);
CREATE UNIQUE INDEX outreach_callback_eligibility_active ON public.outreach_callback_eligibility(organization_id,lead_id,phone_e164) WHERE revoked_at IS NULL;

CREATE TABLE public.outreach_callbacks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  eligibility_id uuid NOT NULL REFERENCES public.outreach_callback_eligibility(id),
  lead_id uuid NOT NULL REFERENCES public.leads(id),
  phone_e164 text NOT NULL,
  timezone text NOT NULL,
  status text NOT NULL DEFAULT 'reserved' CHECK(status IN('reserved','initiated','unknown','completed','failed')),
  logical_key text NOT NULL CHECK(length(logical_key) BETWEEN 1 AND 300),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 5 AND 250),
  provider_call_id text,
  provider_receipt jsonb,
  summary jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE(organization_id,logical_key),
  UNIQUE(organization_id,idempotency_key)
);

CREATE TABLE public.outreach_qualifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  lead_id uuid NOT NULL REFERENCES public.leads(id),
  campaign_id uuid REFERENCES public.campaigns(id),
  thread_id uuid REFERENCES public.threads(id),
  criteria_revision bigint NOT NULL CHECK(criteria_revision>0),
  criteria jsonb NOT NULL,
  outcome text NOT NULL CHECK(outcome IN('qualified','disqualified','unknown')),
  evidence text NOT NULL CHECK(length(evidence) BETWEEN 1 AND 4000),
  attributed_source text NOT NULL CHECK(length(attributed_source) BETWEEN 1 AND 80),
  source_decision_id uuid REFERENCES public.outreach_agent_decisions(id),
  source_event_key text CHECK(source_event_key IS NULL OR length(source_event_key) BETWEEN 1 AND 300),
  payload_fingerprint text CHECK(payload_fingerprint IS NULL OR payload_fingerprint ~ '^[a-f0-9]{64}$'),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX outreach_qualifications_source_event ON public.outreach_qualifications(organization_id,source_event_key) WHERE source_event_key IS NOT NULL;

CREATE TABLE public.outreach_closebot_bridge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  lead_id uuid NOT NULL REFERENCES public.leads(id),
  thread_id uuid REFERENCES public.threads(id),
  source_id text NOT NULL CHECK(length(source_id) BETWEEN 1 AND 200),
  direction text NOT NULL CHECK(direction IN('outbound','inbound')),
  external_message_id text,
  payload_fingerprint text NOT NULL CHECK(payload_fingerprint ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'recorded' CHECK(status IN('recorded','forwarded','succeeded','unknown','failed','taken_over','dismissed')),
  proposal jsonb,
  review jsonb,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,direction,payload_fingerprint)
);

CREATE TABLE public.outreach_downstream_effects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  decision_id uuid NOT NULL REFERENCES public.outreach_agent_decisions(id),
  effect_kind text NOT NULL CHECK(effect_kind IN('ghl_contact','ghl_opportunity','closebot_forward','ghl_note')),
  logical_key text NOT NULL CHECK(length(logical_key) BETWEEN 1 AND 300),
  connection_revision bigint NOT NULL CHECK(connection_revision>0),
  payload_fingerprint text NOT NULL CHECK(payload_fingerprint ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'reserved' CHECK(status IN('reserved','dispatching','succeeded','unknown','failed','skipped')),
  dispatch_token uuid,
  dispatch_lease_expires_at timestamptz,
  provider_receipt jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE(organization_id,logical_key)
);
CREATE INDEX outreach_downstream_effects_dispatch ON public.outreach_downstream_effects(status,dispatch_lease_expires_at);

-- Fair organization selection state for the downstream cron. One row per org
-- advanced only by the claim RPC; a stale worker uses the claim's lease.
CREATE TABLE public.outreach_downstream_scheduler (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id),
  last_claimed_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK(consecutive_failures>=0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Authenticated provider webhook inbox. `event_key` is the provider event/
-- message identity so a duplicate delivery is stored once.
CREATE TABLE public.outreach_downstream_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  provider text NOT NULL CHECK(provider IN('ghl','closebot','retell')),
  event_key text NOT NULL CHECK(length(event_key) BETWEEN 1 AND 300),
  provider_call_id text,
  payload_fingerprint text NOT NULL CHECK(payload_fingerprint ~ '^[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,provider,event_key)
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['outreach_provider_connections','outreach_crm_links','outreach_appointments',
    'outreach_callback_eligibility','outreach_callbacks','outreach_qualifications',
    'outreach_closebot_bridge','outreach_downstream_effects','outreach_downstream_scheduler',
    'outreach_downstream_webhook_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
    EXECUTE format('GRANT SELECT ON public.%I TO service_role',t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Browser-facing owner/admin RPC. Read is presence-only: it never selects the
-- credential ciphertext. Every mutation is revision-checked (CAS).
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.outreach_downstream_mutate(p_actor uuid,p_org uuid,p_action text,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  v_role text; v_now timestamptz:=clock_timestamp(); v_provider text; v_conn public.outreach_provider_connections;
  v_expected bigint; v_criteria jsonb; v_outcome text; v_lead uuid; v_phone text; v_tz text; v_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('email-dispatch:'||p_org::text,0));
  PERFORM public.outreach_downstream_expire_writes(p_org);
  IF p_actor IS NULL OR p_org IS NULL OR p_action IS NULL THEN RAISE EXCEPTION 'downstream:invalid'; END IF;
  SELECT role INTO v_role FROM public.users WHERE id=p_actor AND organization_id=p_org FOR SHARE;
  IF v_role IS NULL OR v_role NOT IN('owner','admin') THEN RAISE EXCEPTION 'downstream:forbidden'; END IF;

  IF p_action='read' THEN
    RETURN jsonb_build_object(
      'connections',coalesce((SELECT jsonb_agg(jsonb_build_object(
        'provider',provider,'revision',revision,'enabled',enabled,'configured',credential_ciphertext IS NOT NULL,
        'config',config,'capability',capability,'lastCheckAt',last_check_at,'lastCheckOk',last_check_ok,
        'lastCheckDetail',last_check_detail,'verifiedAt',verified_at,'updatedAt',updated_at) ORDER BY provider)
        FROM public.outreach_provider_connections WHERE organization_id=p_org),'[]'),
      'crmLinks',coalesce((SELECT jsonb_agg(to_jsonb(x)-'data') FROM (SELECT * FROM public.outreach_crm_links WHERE organization_id=p_org ORDER BY updated_at DESC LIMIT 50)x),'[]'),
      'appointments',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM public.outreach_appointments WHERE organization_id=p_org ORDER BY created_at DESC LIMIT 50)x),'[]'),
      'eligibility',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM public.outreach_callback_eligibility WHERE organization_id=p_org ORDER BY created_at DESC LIMIT 50)x),'[]'),
      'callbacks',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM public.outreach_callbacks WHERE organization_id=p_org ORDER BY created_at DESC LIMIT 50)x),'[]'),
      'qualifications',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM public.outreach_qualifications WHERE organization_id=p_org ORDER BY created_at DESC LIMIT 50)x),'[]'),
      'bridge',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM public.outreach_closebot_bridge WHERE organization_id=p_org ORDER BY created_at DESC LIMIT 50)x),'[]'),
      'effects',coalesce((SELECT jsonb_agg(to_jsonb(x)-'provider_receipt') FROM (SELECT * FROM public.outreach_downstream_effects WHERE organization_id=p_org ORDER BY created_at DESC LIMIT 50)x),'[]'),
      'masterStop',public.outreach_operations_outbound_stopped(p_org),
      'generatedAt',to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  END IF;

  IF p_action IN('saveConnection','setEnabled','recordCheck') THEN
    v_provider:=p_payload->>'provider';
    IF v_provider IS NULL OR v_provider NOT IN('ghl','closebot','retell') THEN RAISE EXCEPTION 'downstream:invalid'; END IF;
  END IF;

  IF p_action='saveConnection' THEN
    v_expected:=coalesce((p_payload->>'expectedRevision')::bigint,0);
    SELECT * INTO v_conn FROM public.outreach_provider_connections WHERE organization_id=p_org AND provider=v_provider FOR UPDATE;
    IF coalesce(v_conn.revision,0) IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'downstream:stale'; END IF;
    IF jsonb_typeof(coalesce(p_payload->'config','{}'))<>'object' THEN RAISE EXCEPTION 'downstream:invalid'; END IF;
    IF p_payload->>'ciphertext' IS NOT NULL AND length(p_payload->>'ciphertext') NOT BETWEEN 1 AND 100000 THEN RAISE EXCEPTION 'downstream:invalid'; END IF;
    INSERT INTO public.outreach_provider_connections(organization_id,provider,credential_ciphertext,config,updated_by)
      VALUES(p_org,v_provider,p_payload->>'ciphertext',coalesce(p_payload->'config','{}'),p_actor)
      ON CONFLICT(organization_id,provider) DO UPDATE SET
        revision=outreach_provider_connections.revision+1,
        credential_ciphertext=coalesce(EXCLUDED.credential_ciphertext,outreach_provider_connections.credential_ciphertext),
        config=EXCLUDED.config,updated_at=v_now,updated_by=p_actor,
        -- Changing configuration invalidates a previously recorded check.
        verified_at=NULL,last_check_ok=NULL,last_check_detail=NULL,capability='{}'::jsonb;
    SELECT * INTO v_conn FROM public.outreach_provider_connections WHERE organization_id=p_org AND provider=v_provider;
    RETURN jsonb_build_object('saved',true,'provider',v_provider,'revision',v_conn.revision,'configured',v_conn.credential_ciphertext IS NOT NULL,'enabled',v_conn.enabled);
  END IF;

  IF p_action='setEnabled' THEN
    v_expected:=coalesce((p_payload->>'expectedRevision')::bigint,0);
    IF jsonb_typeof(p_payload->'enabled')<>'boolean' THEN RAISE EXCEPTION 'downstream:invalid'; END IF;
    UPDATE public.outreach_provider_connections SET enabled=(p_payload->>'enabled')::boolean,revision=revision+1,updated_at=v_now,updated_by=p_actor
      WHERE organization_id=p_org AND provider=v_provider AND revision=v_expected;
    IF NOT FOUND THEN RAISE EXCEPTION 'downstream:stale'; END IF;
    RETURN jsonb_build_object('saved',true);
  END IF;

  IF p_action='recordCheck' THEN
    v_expected:=coalesce((p_payload->>'expectedRevision')::bigint,0);
    IF jsonb_typeof(p_payload->'capability')<>'object' OR jsonb_typeof(p_payload->'ok')<>'boolean' THEN RAISE EXCEPTION 'downstream:invalid'; END IF;
    UPDATE public.outreach_provider_connections SET capability=p_payload->'capability',last_check_at=v_now,last_check_ok=(p_payload->>'ok')::boolean,
      last_check_detail=left(p_payload->>'detail',500),verified_at=CASE WHEN (p_payload->>'ok')::boolean THEN v_now ELSE NULL END,revision=revision+1,updated_at=v_now,updated_by=p_actor
      WHERE organization_id=p_org AND provider=v_provider AND revision=v_expected;
    IF NOT FOUND THEN RAISE EXCEPTION 'downstream:stale'; END IF;
    RETURN jsonb_build_object('saved',true);
  END IF;

  IF p_action='qualify' AND (p_payload->>'campaignId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.campaigns WHERE id=(p_payload->>'campaignId')::uuid AND organization_id=p_org)
    OR p_payload->>'threadId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.threads WHERE id=(p_payload->>'threadId')::uuid AND organization_id=p_org)) THEN RAISE EXCEPTION 'downstream:invalid'; END IF;
  IF p_action='qualify' THEN
    v_lead:=(p_payload->>'leadId')::uuid; v_criteria:=p_payload->'criteria'; v_outcome:=p_payload->>'outcome';
    IF v_lead IS NULL OR jsonb_typeof(v_criteria)<>'object' OR v_outcome NOT IN('qualified','disqualified','unknown')
      OR length(coalesce(p_payload->>'evidence','')) NOT BETWEEN 1 AND 4000
      OR length(coalesce(p_payload->>'attributedSource','')) NOT BETWEEN 1 AND 80
      OR (p_payload->>'criteriaRevision')::bigint IS NULL OR (p_payload->>'criteriaRevision')::bigint<1 THEN RAISE EXCEPTION 'downstream:invalid'; END IF;
    PERFORM 1 FROM public.leads WHERE id=v_lead AND organization_id=p_org; IF NOT FOUND THEN RAISE EXCEPTION 'downstream:not_found'; END IF;
    INSERT INTO public.outreach_qualifications(organization_id,lead_id,campaign_id,thread_id,criteria_revision,criteria,outcome,evidence,attributed_source,source_decision_id,created_by)
      VALUES(p_org,v_lead,(p_payload->>'campaignId')::uuid,(p_payload->>'threadId')::uuid,(p_payload->>'criteriaRevision')::bigint,v_criteria,v_outcome,p_payload->>'evidence',p_payload->>'attributedSource',(p_payload->>'sourceDecisionId')::uuid,p_actor) RETURNING id INTO v_id;
    RETURN jsonb_build_object('saved',true,'qualificationId',v_id,'outcome',v_outcome);
  END IF;

  IF p_action='recordEligibility' THEN
    v_lead:=(p_payload->>'leadId')::uuid; v_phone:=p_payload->>'phoneE164'; v_tz:=p_payload->>'timezone';
    IF coalesce(p_payload->>'expiresAt','') !~ '(Z|[+-][0-9]{2}:[0-9]{2})$' OR v_lead IS NULL OR v_phone IS NULL OR v_phone !~ '^\+[1-9][0-9]{7,14}$' OR v_tz IS NULL
      OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=v_tz)
      OR (p_payload->>'windowStartHour')::int NOT BETWEEN 0 AND 23 OR (p_payload->>'windowEndHour')::int NOT BETWEEN 1 AND 24
      OR (p_payload->>'windowEndHour')::int<=(p_payload->>'windowStartHour')::int
      OR (p_payload->>'expiresAt')::timestamptz IS NULL OR (p_payload->>'expiresAt')::timestamptz<=v_now
      OR (p_payload->>'maxCalls')::int NOT BETWEEN 1 AND 10
      OR length(coalesce(p_payload->>'consentBasis','')) NOT BETWEEN 1 AND 500
      OR length(coalesce(p_payload->>'evidence','')) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'downstream:invalid'; END IF;
    PERFORM 1 FROM public.leads WHERE id=v_lead AND organization_id=p_org; IF NOT FOUND THEN RAISE EXCEPTION 'downstream:not_found'; END IF;
    -- Eligibility is an explicit owner/admin record only. No inbound content,
    -- model output or provider callback can create it.
    UPDATE public.outreach_callback_eligibility SET revoked_at=v_now,revision=revision+1,updated_at=v_now
      WHERE organization_id=p_org AND lead_id=v_lead AND phone_e164=v_phone AND revoked_at IS NULL;
    INSERT INTO public.outreach_callback_eligibility(organization_id,lead_id,phone_e164,timezone,window_start_hour,window_end_hour,expires_at,max_calls,consent_basis,evidence,recorded_by)
      VALUES(p_org,v_lead,v_phone,v_tz,(p_payload->>'windowStartHour')::smallint,(p_payload->>'windowEndHour')::smallint,(p_payload->>'expiresAt')::timestamptz,(p_payload->>'maxCalls')::smallint,p_payload->>'consentBasis',p_payload->>'evidence',p_actor) RETURNING id INTO v_id;
    RETURN jsonb_build_object('saved',true,'eligibilityId',v_id);
  END IF;

  IF p_action='revokeEligibility' THEN
    v_expected:=coalesce((p_payload->>'expectedRevision')::bigint,0);
    UPDATE public.outreach_callback_eligibility SET revoked_at=v_now,revision=revision+1,updated_at=v_now
      WHERE id=(p_payload->>'eligibilityId')::uuid AND organization_id=p_org AND revoked_at IS NULL AND revision=v_expected;
    IF NOT FOUND THEN RAISE EXCEPTION 'downstream:stale'; END IF;
    RETURN jsonb_build_object('saved',true,'revoked',true);
  END IF;

  -- Human review of a CloseBot proposal. Taking over only records the operator
  -- decision and hands the thread to the existing 029 inbox reply flow; it never
  -- sends an external freeform message from this module.
  IF p_action='reviewBridge' THEN
    IF (p_payload->>'decision') NOT IN('taken_over','dismissed') THEN RAISE EXCEPTION 'downstream:invalid'; END IF;
    UPDATE public.outreach_closebot_bridge SET status=p_payload->>'decision',
      review=jsonb_build_object('decision',p_payload->>'decision','note',left(coalesce(p_payload->>'note',''),1000),'at',to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      reviewed_by=p_actor,reviewed_at=v_now
      WHERE id=(p_payload->>'bridgeId')::uuid AND organization_id=p_org AND status IN('recorded','forwarded','succeeded','unknown','failed');
    IF NOT FOUND THEN RAISE EXCEPTION 'downstream:not_found'; END IF;
    IF p_payload->>'decision'='taken_over' THEN
      SELECT public.outreach_canonical_reply_thread(p_org,thread_id) INTO v_id FROM public.outreach_closebot_bridge WHERE id=(p_payload->>'bridgeId')::uuid AND organization_id=p_org;
      IF v_id IS NULL THEN RAISE EXCEPTION 'downstream:not_found'; END IF;
      INSERT INTO public.outreach_conversation_controls(organization_id,thread_id,mode,updated_by) VALUES(p_org,v_id,'human',p_actor)
        ON CONFLICT(organization_id,thread_id) DO UPDATE SET mode='human',revision=outreach_conversation_controls.revision+1,updated_at=v_now,updated_by=p_actor;
      UPDATE public.email_dispatch_attempts SET status='cancelled',error_code='human_takeover',settled_at=v_now WHERE organization_id=p_org AND thread_id=v_id AND kind='reply' AND status='reserved' AND authorized_at IS NULL;
    END IF;
    RETURN jsonb_build_object('saved',true,'decision',p_payload->>'decision');
  END IF;

  RAISE EXCEPTION 'downstream:invalid';
END $$;
REVOKE ALL ON FUNCTION public.outreach_downstream_mutate(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.outreach_downstream_mutate(uuid,uuid,text,jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- Service-only downstream effects. The scheduler resolves the current tenant,
-- connection and master stop; untrusted inbound/model content can never choose
-- them. `reserveEffect` is the single place an effect becomes eligible to make
-- a provider call; a duplicate logical key returns the existing row without a
-- second effect.
-- ---------------------------------------------------------------------------
-- Latest evidence applicable to this decision scope supersedes historical outcomes.
CREATE FUNCTION public.outreach_downstream_current_qualification(p_org uuid,p_decision uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT to_jsonb(q) FROM public.outreach_agent_decisions d
 JOIN public.replies r ON r.id=d.source_reply_id AND r.organization_id=p_org
 JOIN public.outreach_qualifications q ON q.organization_id=p_org AND q.lead_id=r.lead_id
 WHERE d.id=p_decision AND d.organization_id=p_org
 AND (q.campaign_id IS NULL OR q.campaign_id=d.campaign_id)
 AND (q.thread_id IS NULL OR q.thread_id=d.thread_id)
 ORDER BY q.created_at DESC,q.id DESC LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.outreach_downstream_current_qualification(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.outreach_downstream_effect(p_org uuid,p_action text,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  v_now timestamptz:=clock_timestamp(); v_kind text; v_logical text; v_effect public.outreach_downstream_effects;
  v_conn public.outreach_provider_connections; v_lead uuid; v_phone text; v_elig public.outreach_callback_eligibility;
  v_hour int; v_decision public.outreach_agent_decisions; v_id uuid; v_appt public.outreach_appointments; v_contact text; v_existing_fp text;
BEGIN
  IF p_org IS NULL OR p_action IS NULL THEN RAISE EXCEPTION 'downstream:invalid'; END IF;

  IF p_action='reserveEffect' THEN
    v_kind:=p_payload->>'effectKind';
    IF v_kind NOT IN('ghl_contact','ghl_opportunity','closebot_forward','ghl_note')
      OR (p_payload->>'payloadFingerprint') !~ '^[a-f0-9]{64}$'
      OR NOT EXISTS(SELECT 1 FROM public.outreach_agent_decisions d WHERE d.id=(p_payload->>'decisionId')::uuid AND d.organization_id=p_org)
      THEN RAISE EXCEPTION 'downstream:invalid'; END IF;
    v_conn:=NULL;
    SELECT * INTO v_conn FROM public.outreach_provider_connections WHERE organization_id=p_org AND provider=p_payload->>'provider';
    IF NOT FOUND OR NOT v_conn.enabled OR v_conn.credential_ciphertext IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','provider_disabled'); END IF;
    IF v_conn.revision IS DISTINCT FROM (p_payload->>'connectionRevision')::bigint THEN RETURN jsonb_build_object('allowed',false,'reason','connection_stale'); END IF;
    SELECT * INTO v_decision FROM public.outreach_agent_decisions WHERE id=(p_payload->>'decisionId')::uuid AND organization_id=p_org;
    -- The logical key is the canonical operation (source reply + effect kind),
    -- never the decision/config/browser UUID. A re-decision for the same reply
    -- can therefore never reserve a second effect while the first is unknown.
    v_logical:='operation:'||v_decision.source_reply_id::text||':'||v_kind;
    -- CloseBot may only receive an approved canonical decision, never raw
    -- interest. Opportunity sync requires an explicit qualified record first.
    IF v_kind='closebot_forward' AND NOT v_decision.approved THEN RETURN jsonb_build_object('allowed',false,'reason','decision_not_approved'); END IF;
    IF v_kind='ghl_opportunity' AND public.outreach_downstream_current_qualification(p_org,v_decision.id)->>'outcome' IS DISTINCT FROM 'qualified' THEN RETURN jsonb_build_object('allowed',false,'reason','not_qualified'); END IF;
    IF v_kind='ghl_opportunity' AND NOT EXISTS(SELECT 1 FROM public.outreach_crm_links k JOIN public.replies r ON r.id=v_decision.source_reply_id AND r.organization_id=p_org WHERE k.organization_id=p_org AND k.lead_id=r.lead_id) THEN RETURN jsonb_build_object('allowed',false,'reason','contact_not_synced'); END IF;
    -- Reserve before the call. A concurrent duplicate loses the unique insert
    -- and is told the effect already exists instead of calling the provider.
    INSERT INTO public.outreach_downstream_effects(organization_id,decision_id,effect_kind,logical_key,connection_revision,payload_fingerprint)
      VALUES(p_org,(p_payload->>'decisionId')::uuid,v_kind,v_logical,v_conn.revision,p_payload->>'payloadFingerprint')
      ON CONFLICT(organization_id,logical_key) DO NOTHING RETURNING * INTO v_effect;
    IF v_effect.id IS NULL THEN
      SELECT * INTO v_effect FROM public.outreach_downstream_effects WHERE organization_id=p_org AND logical_key=v_logical;
      RETURN jsonb_build_object('allowed',false,'reason','effect_exists','effectId',v_effect.id,'status',v_effect.status);
    END IF;
    RETURN jsonb_build_object('allowed',true,'effectId',v_effect.id,'status','reserved','provider',p_payload->>'provider',
      'credentialCiphertext',v_conn.credential_ciphertext,'config',v_conn.config,'connectionRevision',v_conn.revision);
  END IF;

  IF p_action='settleEffect' THEN
    UPDATE public.outreach_downstream_effects SET
      status=CASE WHEN p_payload->>'status' IN('succeeded','unknown','failed','skipped') THEN p_payload->>'status' ELSE status END,
      provider_receipt=p_payload->'receipt',error_code=left(p_payload->>'errorCode',200),settled_at=v_now,
      dispatch_token=NULL,dispatch_lease_expires_at=NULL
      WHERE id=(p_payload->>'effectId')::uuid AND organization_id=p_org AND status IN('dispatching','unknown')
        AND dispatch_token=(p_payload->>'dispatchToken')::uuid;
    IF NOT FOUND THEN RETURN jsonb_build_object('result','stale'); END IF;
    RETURN jsonb_build_object('result','settled');
  END IF;

  IF p_action='reserveCallback' THEN
    SELECT * INTO v_conn FROM public.outreach_provider_connections WHERE organization_id=p_org AND provider='retell';
    IF NOT FOUND OR NOT v_conn.enabled OR v_conn.credential_ciphertext IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','provider_disabled'); END IF;
    IF v_conn.revision IS DISTINCT FROM (p_payload->>'connectionRevision')::bigint THEN RETURN jsonb_build_object('allowed',false,'reason','connection_stale'); END IF;
    v_elig:=NULL;
    SELECT * INTO v_elig FROM public.outreach_callback_eligibility
      WHERE id=(p_payload->>'eligibilityId')::uuid AND organization_id=p_org AND revoked_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','eligibility_revoked'); END IF;
    SELECT id,phone INTO v_lead,v_phone FROM public.leads WHERE id=v_elig.lead_id AND organization_id=p_org;
    IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','lead_missing'); END IF;
    IF v_elig.expires_at<=v_now THEN RETURN jsonb_build_object('allowed',false,'reason','eligibility_expired'); END IF;
    IF v_elig.calls_started>=v_elig.max_calls THEN RETURN jsonb_build_object('allowed',false,'reason','call_cap_reached'); END IF;
    -- The current number must match the owner-recorded eligibility. Email
    -- interest can never supply this number.
    IF lower(btrim(coalesce(v_phone,'')))<>v_elig.phone_e164 THEN RETURN jsonb_build_object('allowed',false,'reason','phone_changed'); END IF;
    IF public.outreach_operations_outbound_stopped(p_org) THEN RETURN jsonb_build_object('allowed',false,'reason','master_stop'); END IF;
    v_hour:=extract(hour FROM (v_now AT TIME ZONE v_elig.timezone))::int;
    IF v_hour<v_elig.window_start_hour OR v_hour>=v_elig.window_end_hour THEN RETURN jsonb_build_object('allowed',false,'reason','outside_window'); END IF;
    v_logical:='callback:'||v_elig.lead_id::text||':'||v_elig.phone_e164||':'||v_elig.id::text;
    IF EXISTS(SELECT 1 FROM public.outreach_callbacks WHERE organization_id=p_org AND phone_e164=v_elig.phone_e164 AND status IN('reserved','unknown','initiated')) THEN RETURN jsonb_build_object('allowed',false,'reason','callback_exists'); END IF;
    INSERT INTO public.outreach_callbacks(organization_id,eligibility_id,lead_id,phone_e164,timezone,logical_key,idempotency_key)
      VALUES(p_org,v_elig.id,v_elig.lead_id,v_elig.phone_e164,v_elig.timezone,v_logical,coalesce(p_payload->>'idempotencyKey',gen_random_uuid()::text))
      ON CONFLICT(organization_id,logical_key) DO NOTHING;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('allowed',false,'reason','callback_exists','callbackId',(SELECT id FROM public.outreach_callbacks WHERE organization_id=p_org AND logical_key=v_logical));
    END IF;
    UPDATE public.outreach_callback_eligibility SET calls_started=calls_started+1,updated_at=v_now WHERE id=v_elig.id;
    RETURN jsonb_build_object('allowed',true,'callbackId',(SELECT id FROM public.outreach_callbacks WHERE organization_id=p_org AND logical_key=v_logical),
      'phoneE164',v_elig.phone_e164,'timezone',v_elig.timezone,'fromNumber',(p_payload->>'fromNumber'),'config',(SELECT config FROM public.outreach_provider_connections WHERE organization_id=p_org AND provider='retell'),
      'credentialCiphertext',(SELECT credential_ciphertext FROM public.outreach_provider_connections WHERE organization_id=p_org AND provider='retell' AND enabled));
  END IF;

  IF p_action='settleCallback' THEN
    UPDATE public.outreach_callbacks SET status=CASE WHEN status IN('completed','failed') THEN status WHEN p_payload->>'status' IN('initiated','unknown','completed','failed') THEN p_payload->>'status' ELSE status END,
      provider_call_id=left(p_payload->>'providerCallId',200),provider_receipt=p_payload->'receipt',summary=p_payload->'summary',
      error_code=left(p_payload->>'errorCode',200),settled_at=v_now
      WHERE id=(p_payload->>'callbackId')::uuid AND organization_id=p_org AND status IN('reserved','unknown','completed','failed');
    IF NOT FOUND THEN RETURN jsonb_build_object('result','stale'); END IF;
    RETURN jsonb_build_object('result','settled');
  END IF;

  IF p_action='recordInboundBridge' THEN
    IF (p_payload->>'payloadFingerprint') IS NULL OR (p_payload->>'payloadFingerprint') !~ '^[a-f0-9]{64}$'
      OR NOT EXISTS(SELECT 1 FROM public.leads WHERE id=(p_payload->>'leadId')::uuid AND organization_id=p_org) THEN RAISE EXCEPTION 'downstream:invalid'; END IF;
    INSERT INTO public.outreach_closebot_bridge(organization_id,lead_id,thread_id,source_id,direction,external_message_id,payload_fingerprint,status,proposal)
      VALUES(p_org,(p_payload->>'leadId')::uuid,(p_payload->>'threadId')::uuid,p_payload->>'sourceId','inbound',left(p_payload->>'externalMessageId',200),p_payload->>'payloadFingerprint','recorded',p_payload->'proposal')
      ON CONFLICT(organization_id,direction,payload_fingerprint) DO NOTHING RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      SELECT id INTO v_id FROM public.outreach_closebot_bridge WHERE organization_id=p_org AND direction='inbound' AND payload_fingerprint=p_payload->>'payloadFingerprint';
      RETURN jsonb_build_object('result','duplicate','bridgeId',v_id);
    END IF;
    RETURN jsonb_build_object('result','recorded','bridgeId',v_id);
  END IF;

  IF p_action='connectionSecret' THEN
    SELECT * INTO v_conn FROM public.outreach_provider_connections WHERE organization_id=p_org AND provider=p_payload->>'provider';
    IF NOT FOUND THEN RETURN jsonb_build_object('configured',false); END IF;
    RETURN jsonb_build_object('configured',v_conn.credential_ciphertext IS NOT NULL,'enabled',v_conn.enabled,'revision',v_conn.revision,
      'credentialCiphertext',v_conn.credential_ciphertext,'config',v_conn.config,'capability',v_conn.capability);
  END IF;

  IF p_action='recordCrmLink' THEN
    IF NOT EXISTS(SELECT 1 FROM public.leads WHERE id=(p_payload->>'leadId')::uuid AND organization_id=p_org)
      OR length(coalesce(p_payload->>'externalContactId','')) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'downstream:invalid'; END IF;
    INSERT INTO public.outreach_crm_links(organization_id,lead_id,provider,external_contact_id,external_opportunity_id,location_id,data,synced_at)
      VALUES(p_org,(p_payload->>'leadId')::uuid,'ghl',p_payload->>'externalContactId',p_payload->>'externalOpportunityId',p_payload->>'locationId',coalesce(p_payload->'data','{}'::jsonb),v_now)
      ON CONFLICT(organization_id,lead_id) DO UPDATE SET external_contact_id=coalesce(EXCLUDED.external_contact_id,outreach_crm_links.external_contact_id),
        external_opportunity_id=coalesce(EXCLUDED.external_opportunity_id,outreach_crm_links.external_opportunity_id),
        location_id=coalesce(EXCLUDED.location_id,outreach_crm_links.location_id),data=EXCLUDED.data,revision=outreach_crm_links.revision+1,synced_at=v_now,updated_at=v_now;
    RETURN jsonb_build_object('result','recorded');
  END IF;

  IF p_action='recordProviderQualification' THEN
    IF p_payload->>'attributedSource' NOT IN('closebot.callback')
      OR jsonb_typeof(p_payload->'criteria')<>'object'
      OR p_payload->>'outcome' NOT IN('qualified','disqualified','unknown')
      OR (p_payload->>'criteriaRevision')::bigint IS NULL OR (p_payload->>'criteriaRevision')::bigint<1
      OR length(coalesce(p_payload->>'evidence','')) NOT BETWEEN 1 AND 4000
      OR length(coalesce(p_payload->>'sourceEventKey','')) NOT BETWEEN 1 AND 300
      OR (p_payload->>'payloadFingerprint') !~ '^[a-f0-9]{64}$'
      OR NOT EXISTS(SELECT 1 FROM public.leads WHERE id=(p_payload->>'leadId')::uuid AND organization_id=p_org) THEN RAISE EXCEPTION 'downstream:invalid'; END IF;
    -- Idempotent on the authenticated source event: an identical retry returns
    -- the original row; the same identity with a different body is a conflict.
    INSERT INTO public.outreach_qualifications(organization_id,lead_id,campaign_id,thread_id,criteria_revision,criteria,outcome,evidence,attributed_source,source_decision_id,source_event_key,payload_fingerprint,created_by)
      VALUES(p_org,(p_payload->>'leadId')::uuid,(p_payload->>'campaignId')::uuid,(p_payload->>'threadId')::uuid,(p_payload->>'criteriaRevision')::bigint,p_payload->'criteria',p_payload->>'outcome',p_payload->>'evidence',p_payload->>'attributedSource',(p_payload->>'sourceDecisionId')::uuid,p_payload->>'sourceEventKey',p_payload->>'payloadFingerprint',NULL)
      ON CONFLICT (organization_id,source_event_key) WHERE source_event_key IS NOT NULL DO NOTHING RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      SELECT id,payload_fingerprint INTO v_id,v_existing_fp FROM public.outreach_qualifications
        WHERE organization_id=p_org AND source_event_key=p_payload->>'sourceEventKey';
      IF v_existing_fp IS DISTINCT FROM p_payload->>'payloadFingerprint' THEN RAISE EXCEPTION 'downstream:conflict'; END IF;
      RETURN jsonb_build_object('result','duplicate','qualificationId',v_id);
    END IF;
    RETURN jsonb_build_object('result','recorded','qualificationId',v_id);
  END IF;

  IF p_action='recordWebhookEvent' THEN
    IF p_payload->>'provider' NOT IN('ghl','closebot','retell')
      OR length(coalesce(p_payload->>'eventKey','')) NOT BETWEEN 1 AND 300
      OR (p_payload->>'payloadFingerprint') !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'downstream:invalid'; END IF;
    INSERT INTO public.outreach_downstream_webhook_events(organization_id,provider,event_key,provider_call_id,payload_fingerprint,event_payload)
      VALUES(p_org,p_payload->>'provider',p_payload->>'eventKey',left(p_payload->>'providerCallId',200),p_payload->>'payloadFingerprint',p_payload)
      ON CONFLICT(organization_id,provider,event_key) DO NOTHING RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      -- A replayed identity with a different body is a conflict, not a silent
      -- duplicate: the provider may be signalling a real state change.
      SELECT payload_fingerprint INTO v_existing_fp FROM public.outreach_downstream_webhook_events
        WHERE organization_id=p_org AND provider=p_payload->>'provider' AND event_key=p_payload->>'eventKey';
      IF v_existing_fp IS DISTINCT FROM p_payload->>'payloadFingerprint' THEN RAISE EXCEPTION 'downstream:conflict'; END IF;
      SELECT id INTO v_id FROM public.outreach_downstream_webhook_events WHERE organization_id=p_org AND provider=p_payload->>'provider' AND event_key=p_payload->>'eventKey';
    END IF;
    IF p_payload->>'provider'='retell' AND length(coalesce(p_payload->>'providerCallId','')) BETWEEN 1 AND 200 THEN
      -- Monotonic status: a terminal analysis event enriches a completed call
      -- without regressing it; failed wins over completed; unknown never
      -- overwrites a terminal state.
      UPDATE public.outreach_callbacks SET
        status=CASE
          WHEN p_payload->>'status'='failed' THEN 'failed'
          WHEN p_payload->>'status'='completed' AND status<>'failed' THEN 'completed'
          WHEN status IN('reserved','initiated','unknown') AND p_payload->>'status'='initiated' THEN 'initiated'
          ELSE status END,
        summary=coalesce(p_payload->'summary',summary),
        settled_at=CASE WHEN p_payload->>'status' IN('completed','failed') THEN v_now ELSE settled_at END
        WHERE organization_id=p_org AND provider_call_id=p_payload->>'providerCallId'
          AND status IN('reserved','initiated','unknown','completed','failed');
    END IF;
    -- A GHL appointment event only affects a matching existing booking: the
    -- immutable location + provider appointment id must both bind to the stored
    -- reservation. An unrecognized event is held (recorded, no booking change).
    IF p_payload->>'provider'='ghl' AND length(coalesce(p_payload->>'providerAppointmentId','')) BETWEEN 1 AND 200
      AND p_payload->>'status' IN('scheduled','rescheduled','cancelled') THEN
      UPDATE public.outreach_appointments SET status=p_payload->>'status',
        starts_at=coalesce((p_payload->>'startsAt')::timestamptz,starts_at),
        ends_at=coalesce((p_payload->>'endsAt')::timestamptz,ends_at),
        settled_at=v_now
        WHERE organization_id=p_org AND provider='ghl' AND provider_appointment_id=p_payload->>'providerAppointmentId'
          AND length(coalesce(p_payload->>'locationId',''))>0 AND location_id=p_payload->>'locationId'
          AND status IN('reserved','scheduled','rescheduled','unknown');
      IF FOUND THEN RETURN jsonb_build_object('result','matched','webhookEventId',v_id); END IF;
      RETURN jsonb_build_object('result','unmatched','webhookEventId',v_id);
    END IF;
    RETURN jsonb_build_object('result',CASE WHEN v_existing_fp IS NOT NULL THEN 'duplicate' ELSE 'recorded' END,'webhookEventId',v_id);
  END IF;

  -- Durable appointment reservation. The browser never supplies a provider id;
  -- the logical key is derived from the server-verified lead + calendar + start.
  IF p_action='reserveAppointment' THEN
    SELECT * INTO v_conn FROM public.outreach_provider_connections WHERE organization_id=p_org AND provider='ghl';
    IF NOT FOUND OR NOT v_conn.enabled OR v_conn.credential_ciphertext IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','provider_disabled'); END IF;
    IF v_conn.revision IS DISTINCT FROM (p_payload->>'connectionRevision')::bigint THEN RETURN jsonb_build_object('allowed',false,'reason','connection_stale'); END IF;
    IF (p_payload->>'startsAt')::timestamptz IS NULL OR length(coalesce(p_payload->>'calendarId','')) NOT BETWEEN 1 AND 200
      OR length(coalesce(p_payload->>'logicalKey','')) NOT BETWEEN 1 AND 300
      OR NOT EXISTS(SELECT 1 FROM public.leads WHERE id=(p_payload->>'leadId')::uuid AND organization_id=p_org) THEN RAISE EXCEPTION 'downstream:invalid'; END IF;
    IF p_payload->>'campaignId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.campaigns WHERE id=(p_payload->>'campaignId')::uuid AND organization_id=p_org)
      OR p_payload->>'threadId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.threads t JOIN public.leads l ON l.id=(p_payload->>'leadId')::uuid AND l.organization_id=p_org WHERE t.id=(p_payload->>'threadId')::uuid AND t.organization_id=p_org AND lower(btrim(t.participant_email))=lower(btrim(l.email))) THEN RAISE EXCEPTION 'downstream:invalid'; END IF;
    p_payload:=p_payload||jsonb_build_object('logicalKey','appointment:'||(p_payload->>'leadId')||':'||(p_payload->>'calendarId')||':'||((p_payload->>'startsAt')::timestamptz)::text);
    SELECT external_contact_id INTO v_contact FROM public.outreach_crm_links
      WHERE organization_id=p_org AND lead_id=(p_payload->>'leadId')::uuid AND provider='ghl' AND external_contact_id IS NOT NULL;
    IF v_contact IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','contact_not_synced'); END IF;
    IF EXISTS(SELECT 1 FROM public.outreach_appointments WHERE organization_id=p_org AND lead_id=(p_payload->>'leadId')::uuid AND calendar_id=p_payload->>'calendarId' AND status IN('reserved','unknown')) THEN RETURN jsonb_build_object('allowed',false,'reason','appointment_in_progress'); END IF;
    INSERT INTO public.outreach_appointments(organization_id,lead_id,campaign_id,thread_id,provider,calendar_id,location_id,starts_at,ends_at,timezone,status,logical_key,connection_revision)
      VALUES(p_org,(p_payload->>'leadId')::uuid,(p_payload->>'campaignId')::uuid,(p_payload->>'threadId')::uuid,'ghl',p_payload->>'calendarId',p_payload->>'locationId',
        (p_payload->>'startsAt')::timestamptz,(p_payload->>'endsAt')::timestamptz,p_payload->>'timezone','reserved',p_payload->>'logicalKey',v_conn.revision)
      ON CONFLICT(organization_id,logical_key) DO NOTHING RETURNING * INTO v_appt;
    IF v_appt.id IS NULL THEN
      SELECT * INTO v_appt FROM public.outreach_appointments WHERE organization_id=p_org AND logical_key=p_payload->>'logicalKey';
      RETURN jsonb_build_object('allowed',false,
        'reason',CASE WHEN v_appt.status IN('reserved','unknown') THEN 'appointment_in_progress' ELSE 'appointment_exists' END,
        'appointmentId',v_appt.id,'status',v_appt.status);
    END IF;
    RETURN jsonb_build_object('allowed',true,'appointmentId',v_appt.id,'status','reserved','crmContactId',v_contact,
      'credentialCiphertext',v_conn.credential_ciphertext,'config',v_conn.config,'connectionRevision',v_conn.revision);
  END IF;

  IF p_action='settleAppointment' THEN
    IF (p_payload->>'status') NOT IN('scheduled','rescheduled','cancelled','unknown','failed') THEN RAISE EXCEPTION 'downstream:invalid'; END IF;
    UPDATE public.outreach_appointments SET status=p_payload->>'status',
      provider_appointment_id=coalesce(left(p_payload->>'providerAppointmentId',200),provider_appointment_id),
      starts_at=coalesce((p_payload->>'startsAt')::timestamptz,starts_at),
      ends_at=coalesce((p_payload->>'endsAt')::timestamptz,ends_at),
      provider_receipt=p_payload->'receipt',error_code=left(p_payload->>'errorCode',200),settled_at=v_now
      WHERE id=(p_payload->>'appointmentId')::uuid AND organization_id=p_org
        AND status IN('reserved','scheduled','rescheduled','unknown')
        AND (p_payload->>'expectedProviderAppointmentId' IS NULL OR provider_appointment_id=p_payload->>'expectedProviderAppointmentId');
    IF NOT FOUND THEN RETURN jsonb_build_object('result','stale'); END IF;
    RETURN jsonb_build_object('result','settled');
  END IF;

  -- Atomic, exclusive, fenced claim. A worker claims exactly one reserved
  -- effect under a row lock; a concurrent worker gets a different row or none.
  -- An expired dispatch lease is held as unknown, never re-executed, because
  -- the previous worker may have reached the provider.
  IF p_action='claimEffect' THEN
    UPDATE public.outreach_downstream_effects SET status='unknown',error_code='dispatch_lease_expired',settled_at=v_now,
      dispatch_token=NULL,dispatch_lease_expires_at=NULL
      WHERE organization_id=p_org AND status='dispatching' AND dispatch_lease_expires_at<v_now;
    -- A master stop halts new external writes; reserved effects stay reserved so
    -- they can execute once the stop is lifted.
    IF public.outreach_operations_outbound_stopped(p_org) THEN RETURN jsonb_build_object('effectId',NULL,'reason','master_stop'); END IF;
    UPDATE public.outreach_downstream_effects SET status='dispatching',dispatch_token=gen_random_uuid(),
      dispatch_lease_expires_at=v_now+make_interval(secs=>coalesce((p_payload->>'leaseSeconds')::int,25))
      WHERE id=(SELECT id FROM public.outreach_downstream_effects
        WHERE organization_id=p_org AND status='reserved' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING * INTO v_effect;
    IF v_effect.id IS NULL THEN RETURN jsonb_build_object('effectId',NULL); END IF;
    RETURN jsonb_build_object('effectId',v_effect.id,'dispatchToken',v_effect.dispatch_token,'effectKind',v_effect.effect_kind,
      'decisionId',v_effect.decision_id,'logicalKey',v_effect.logical_key,'connectionRevision',v_effect.connection_revision,
      'payloadFingerprint',v_effect.payload_fingerprint);
  END IF;

  IF p_action='effectContext' THEN
    SELECT * INTO v_effect FROM public.outreach_downstream_effects
      WHERE id=(p_payload->>'effectId')::uuid AND organization_id=p_org AND status IN('dispatching','unknown')
        AND dispatch_token=(p_payload->>'dispatchToken')::uuid;
    IF v_effect.id IS NULL THEN RETURN jsonb_build_object('found',false); END IF;
    SELECT * INTO v_decision FROM public.outreach_agent_decisions WHERE id=v_effect.decision_id AND organization_id=p_org;
    SELECT * INTO v_conn FROM public.outreach_provider_connections WHERE organization_id=p_org
      AND provider=CASE WHEN v_effect.effect_kind='closebot_forward' THEN 'closebot' ELSE 'ghl' END;
    RETURN jsonb_build_object('found',true,
      'effect',to_jsonb(v_effect)-'provider_receipt',
      'connectionConfigured',v_conn.credential_ciphertext IS NOT NULL,
      'connectionEnabled',coalesce(v_conn.enabled,false),
      'connectionRevision',v_conn.revision,
      'connectionStale',v_conn.revision IS DISTINCT FROM v_effect.connection_revision,
      'masterStop',public.outreach_operations_outbound_stopped(p_org),
      'credentialCiphertext',v_conn.credential_ciphertext,
      'config',coalesce(v_conn.config,'{}'::jsonb),
      'decision',(SELECT jsonb_build_object('decisionId',d.id,'threadId',d.thread_id,'campaignId',d.campaign_id,'sourceReplyId',d.source_reply_id,'approved',d.approved,'policyRevision',d.policy_revision,'classification',d.classification) FROM public.outreach_agent_decisions d WHERE d.id=v_effect.decision_id AND d.organization_id=p_org),
      'lead',(SELECT jsonb_build_object('leadId',r.lead_id,'email',l.email,'phone',l.phone,'firstName',l.first_name,'lastName',l.last_name)
        FROM public.replies r JOIN public.leads l ON l.id=r.lead_id AND l.organization_id=p_org WHERE r.id=v_decision.source_reply_id),
      'crmContactId',(SELECT external_contact_id FROM public.outreach_crm_links WHERE organization_id=p_org AND lead_id=(SELECT r.lead_id FROM public.replies r WHERE r.id=v_decision.source_reply_id)),
      'replyBody',(SELECT left(r.body_text,16001) FROM public.replies r WHERE r.id=v_decision.source_reply_id),
      'bodyReady',coalesce((SELECT im.body_status='ready' FROM public.winnr_ingested_messages im WHERE im.organization_id=p_org AND im.reply_id=v_decision.source_reply_id ORDER BY im.received_at DESC LIMIT 1),false));
  END IF;

  RAISE EXCEPTION 'downstream:invalid';
END $$;
REVOKE ALL ON FUNCTION public.outreach_downstream_effect(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.outreach_downstream_effect(uuid,text,jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- Fair, current-owner organization selection for the downstream cron. Returns
-- only an organization with at least one enabled configured provider and a
-- current owner/admin; never trusts a caller-supplied tenant.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.outreach_downstream_next_org() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_org uuid; v_actor uuid;
BEGIN
  SELECT c.organization_id INTO v_org FROM public.outreach_provider_connections c
    WHERE c.enabled AND c.credential_ciphertext IS NOT NULL
      -- An organization with no current owner/admin is skipped in the initial
      -- selection so it can never starve eligible organizations.
      AND EXISTS(SELECT 1 FROM public.users u WHERE u.organization_id=c.organization_id AND u.role IN('owner','admin'))
    ORDER BY coalesce((SELECT last_claimed_at FROM public.outreach_downstream_scheduler s WHERE s.organization_id=c.organization_id),'epoch'::timestamptz), c.organization_id
    LIMIT 1;
  IF v_org IS NULL THEN RETURN NULL; END IF;
  SELECT u.id INTO v_actor FROM public.users u WHERE u.organization_id=v_org AND u.role IN('owner','admin') ORDER BY (u.role='owner') DESC,u.id LIMIT 1;
  IF v_actor IS NULL THEN RETURN NULL; END IF;
  INSERT INTO public.outreach_downstream_scheduler(organization_id,last_claimed_at) VALUES(v_org,clock_timestamp())
    ON CONFLICT(organization_id) DO UPDATE SET last_claimed_at=excluded.last_claimed_at,updated_at=excluded.last_claimed_at;
  RETURN jsonb_build_object('organizationId',v_org,'actorId',v_actor);
END $$;
REVOKE ALL ON FUNCTION public.outreach_downstream_next_org() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.outreach_downstream_next_org() TO service_role;

-- Every provider handoff consumes a durable immutable grant under the same
-- organization lock as031 stop and029 takeover. Old implementation functions
-- are private; neither service_role nor browser roles can bypass the wrapper.
ALTER TABLE public.outreach_downstream_effects ADD COLUMN source_snapshot jsonb;
ALTER TABLE public.outreach_callbacks ADD COLUMN source_snapshot jsonb;
ALTER TABLE public.outreach_appointments ADD COLUMN source_snapshot jsonb;
ALTER TABLE public.outreach_downstream_webhook_events ADD COLUMN event_payload jsonb;
CREATE TABLE public.outreach_downstream_writes(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id),
 kind text NOT NULL CHECK(kind IN('effect','callback','appointment_create','appointment_reschedule','appointment_cancel')),
 subject_id uuid NOT NULL, actor_id uuid NOT NULL, provider text NOT NULL,
 connection_revision bigint NOT NULL, snapshot jsonb NOT NULL, payload jsonb NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'), token uuid NOT NULL DEFAULT gen_random_uuid(),
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN('reserved','authorized','succeeded','unknown','rejected')),
 created_at timestamptz NOT NULL DEFAULT now(), authorized_at timestamptz,settled_at timestamptz,
 UNIQUE(organization_id,kind,subject_id,fingerprint)
);
CREATE UNIQUE INDEX outreach_downstream_write_hold ON public.outreach_downstream_writes(organization_id,subject_id)
 WHERE state IN('reserved','authorized','unknown');
ALTER TABLE public.outreach_downstream_writes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.outreach_downstream_writes FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.outreach_downstream_writes TO service_role;

CREATE FUNCTION public.outreach_downstream_expire_writes(p_org uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE expired record;
BEGIN
 FOR expired IN UPDATE public.outreach_downstream_writes SET state='unknown',settled_at=clock_timestamp()
  WHERE organization_id=p_org AND state='authorized' AND authorized_at<clock_timestamp()-interval '30 seconds' RETURNING kind,subject_id LOOP
  IF expired.kind='callback' THEN UPDATE public.outreach_callbacks SET status='unknown',error_code='write_receipt_missing' WHERE id=expired.subject_id AND organization_id=p_org AND status='reserved';
  ELSIF expired.kind='effect' THEN UPDATE public.outreach_downstream_effects SET status='unknown',error_code='write_receipt_missing' WHERE id=expired.subject_id AND organization_id=p_org AND status='dispatching';
  ELSE UPDATE public.outreach_appointments SET status='unknown',error_code='write_receipt_missing' WHERE id=expired.subject_id AND organization_id=p_org AND status IN('reserved','scheduled','rescheduled'); END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.outreach_downstream_expire_writes(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.outreach_downstream_snapshot(p_org uuid,p_kind text,p_subject uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT CASE WHEN p_kind='effect' THEN (
 SELECT jsonb_build_object('decision',to_jsonb(d),'lead',jsonb_build_object('id',l.id,'email',l.email,'phone',l.phone,'status',l.status,'firstName',l.first_name,'lastName',l.last_name),
 'crmContactId',CASE WHEN e.effect_kind IN('ghl_opportunity','ghl_note') THEN (SELECT external_contact_id FROM public.outreach_crm_links WHERE organization_id=p_org AND lead_id=l.id) ELSE NULL END,'qualification',CASE WHEN e.effect_kind='ghl_opportunity' THEN public.outreach_downstream_current_qualification(p_org,e.decision_id) ELSE NULL END,'latestReplyId',(SELECT id FROM public.replies WHERE organization_id=p_org AND thread_id=d.thread_id ORDER BY received_at DESC NULLS LAST,created_at DESC NULLS LAST,id DESC LIMIT 1),'body',r.body_text,'control',jsonb_build_object('revision',c.revision,'mode',c.mode,'merged',c.merged_into_thread_id),
 'policy',to_jsonb(p),'briefRevision',b.revision,'bodyReady',EXISTS(SELECT 1 FROM public.winnr_ingested_messages im WHERE im.organization_id=p_org AND im.reply_id=r.id AND im.body_status='ready'))
 FROM public.outreach_downstream_effects e JOIN public.outreach_agent_decisions d ON d.id=e.decision_id AND d.organization_id=p_org
 JOIN public.replies r ON r.id=d.source_reply_id AND r.organization_id=p_org JOIN public.leads l ON l.id=r.lead_id AND l.organization_id=p_org
 LEFT JOIN public.outreach_conversation_controls c ON c.organization_id=p_org AND c.thread_id=d.thread_id
 LEFT JOIN public.outreach_agent_policies p ON p.organization_id=p_org AND p.campaign_id=d.campaign_id
 LEFT JOIN public.outreach_offer_briefs b ON b.organization_id=p_org AND b.campaign_id=d.campaign_id
 WHERE e.id=p_subject AND e.organization_id=p_org)
 WHEN p_kind='callback' THEN (
 SELECT jsonb_build_object('lead',jsonb_build_object('id',l.id,'email',l.email,'phone',l.phone,'status',l.status),'eligibility',to_jsonb(e)-'updated_at'-'calls_started')
 FROM public.outreach_callbacks a JOIN public.leads l ON l.id=a.lead_id AND l.organization_id=p_org JOIN public.outreach_callback_eligibility e ON e.id=a.eligibility_id AND e.organization_id=p_org WHERE a.id=p_subject AND a.organization_id=p_org)
 ELSE (
 SELECT jsonb_build_object('lead',jsonb_build_object('id',l.id,'email',l.email,'phone',l.phone,'status',l.status),
 'appointment',to_jsonb(a)-'source_snapshot'-'provider_receipt'-'error_code'-'settled_at',
 'contactId',(SELECT external_contact_id FROM public.outreach_crm_links WHERE organization_id=p_org AND lead_id=l.id))
 FROM public.outreach_appointments a JOIN public.leads l ON l.id=a.lead_id AND l.organization_id=p_org WHERE a.id=p_subject AND a.organization_id=p_org) END || jsonb_build_object('providers',(SELECT jsonb_agg(jsonb_build_object('provider',provider,'revision',revision,'enabled',enabled) ORDER BY provider) FROM public.outreach_provider_connections WHERE organization_id=p_org),'owners',(SELECT jsonb_agg(id ORDER BY id) FROM public.users WHERE organization_id=p_org AND role IN('owner','admin')))
$$;
REVOKE ALL ON FUNCTION public.outreach_downstream_snapshot(uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

ALTER FUNCTION public.outreach_downstream_effect(uuid,text,jsonb) RENAME TO outreach_downstream_effect_private;
REVOKE ALL ON FUNCTION public.outreach_downstream_effect_private(uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.outreach_downstream_effect(p_org uuid,p_action text,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb; subject uuid; kind text; provider_name text; snap jsonb; baseline jsonb;
 grant_row public.outreach_downstream_writes; conn public.outreach_provider_connections;
 actor uuid; fp text; body text; stored_event record; expected_payload jsonb; selected_kind text; lead_id uuid; elig public.outreach_callback_eligibility; appt public.outreach_appointments;
BEGIN
 IF p_org IS NULL OR p_action IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'downstream:invalid'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('email-dispatch:'||p_org::text,0));
 PERFORM public.outreach_downstream_expire_writes(p_org);
 IF p_payload->>'campaignId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.campaigns WHERE id=(p_payload->>'campaignId')::uuid AND organization_id=p_org)
  OR p_payload->>'threadId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.threads WHERE id=(p_payload->>'threadId')::uuid AND organization_id=p_org)
  OR p_payload->>'sourceDecisionId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.outreach_agent_decisions d JOIN public.replies r ON r.id=d.source_reply_id AND r.organization_id=p_org WHERE d.id=(p_payload->>'sourceDecisionId')::uuid AND d.organization_id=p_org AND (p_payload->>'leadId' IS NULL OR r.lead_id=(p_payload->>'leadId')::uuid)) THEN RAISE EXCEPTION 'downstream:invalid'; END IF;
 IF p_action='recordQualifiedBridge' THEN
  result:=public.outreach_downstream_effect(p_org,'recordInboundBridge',p_payload-'qualification');
  baseline:=public.outreach_downstream_effect(p_org,'recordProviderQualification',p_payload->'qualification');
  RETURN result||jsonb_build_object('qualificationId',baseline->'qualificationId','qualificationDuplicate',baseline->>'result'='duplicate');
 END IF;
 IF p_action='beginWrite' THEN
  subject:=(p_payload->>'subjectId')::uuid;kind:=p_payload->>'kind';actor:=(p_payload->>'actorId')::uuid;
  IF kind NOT IN('effect','callback','appointment_create','appointment_reschedule','appointment_cancel') OR subject IS NULL THEN RAISE EXCEPTION 'downstream:invalid'; END IF;
  provider_name:=CASE WHEN kind='callback' THEN 'retell' WHEN kind='effect' THEN (SELECT CASE WHEN e.effect_kind='closebot_forward' THEN 'closebot' ELSE 'ghl' END FROM public.outreach_downstream_effects e WHERE e.id=subject AND e.organization_id=p_org) ELSE 'ghl' END;
  snap:=public.outreach_downstream_snapshot(p_org,kind,subject);
  baseline:=CASE WHEN kind='effect' THEN (SELECT source_snapshot FROM public.outreach_downstream_effects WHERE id=subject AND organization_id=p_org)
   WHEN kind='callback' THEN (SELECT source_snapshot FROM public.outreach_callbacks WHERE id=subject AND organization_id=p_org)
   WHEN kind='appointment_create' THEN (SELECT source_snapshot FROM public.outreach_appointments WHERE id=subject AND organization_id=p_org) ELSE snap END;
  IF snap IS NULL OR baseline IS NULL OR snap IS DISTINCT FROM baseline THEN RETURN jsonb_build_object('allowed',false,'reason','source_changed'); END IF;
  IF actor IS NULL THEN SELECT id INTO actor FROM public.users WHERE organization_id=p_org AND role IN('owner','admin') ORDER BY id LIMIT 1; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.users WHERE id=actor AND organization_id=p_org AND role IN('owner','admin')) THEN RETURN jsonb_build_object('allowed',false,'reason','actor_changed'); END IF;
  SELECT * INTO conn FROM public.outreach_provider_connections WHERE organization_id=p_org AND provider=provider_name;
  IF NOT FOUND OR NOT conn.enabled OR conn.credential_ciphertext IS NULL OR conn.revision IS DISTINCT FROM (p_payload->>'connectionRevision')::bigint THEN RETURN jsonb_build_object('allowed',false,'reason','connection_stale'); END IF;
  body:=p_payload->>'payloadText';IF body IS NULL OR length(body)>100000 THEN RAISE EXCEPTION 'downstream:invalid'; END IF;
  fp:=encode(sha256(convert_to(body,'UTF8')),'hex');IF fp IS DISTINCT FROM p_payload->>'fingerprint' OR jsonb_typeof(body::jsonb)<>'object' THEN RAISE EXCEPTION 'downstream:invalid'; END IF;
  -- Payload is immutable and structurally tied to the canonical source. Only
  -- internal server ports construct it; browser requests cannot supply it.
  IF kind='effect' THEN
   IF NOT EXISTS(SELECT 1 FROM public.outreach_downstream_effects WHERE id=subject AND organization_id=p_org AND status='dispatching' AND dispatch_token=(p_payload->>'dispatchToken')::uuid AND dispatch_lease_expires_at>clock_timestamp()) THEN RETURN jsonb_build_object('allowed',false,'reason','stale'); END IF;
   IF provider_name='closebot' AND (body::jsonb->'event'->>'body' IS DISTINCT FROM snap->>'body') THEN RETURN jsonb_build_object('allowed',false,'reason','content_changed'); END IF;
  ELSIF kind='callback' THEN
   IF NOT EXISTS(SELECT 1 FROM public.outreach_callbacks WHERE id=subject AND organization_id=p_org AND status='reserved' AND phone_e164=body::jsonb->>'toNumber') THEN RETURN jsonb_build_object('allowed',false,'reason','stale'); END IF;
  ELSE
   SELECT * INTO appt FROM public.outreach_appointments WHERE id=subject AND organization_id=p_org;
   IF kind='appointment_create' AND appt.status<>'reserved' OR kind<>'appointment_create' AND appt.status NOT IN('scheduled','rescheduled') THEN RETURN jsonb_build_object('allowed',false,'reason','appointment_not_active'); END IF;
   IF kind<>'appointment_create' AND appt.provider_appointment_id IS DISTINCT FROM body::jsonb->>'appointmentId' THEN RETURN jsonb_build_object('allowed',false,'reason','stale'); END IF;
  END IF;
  IF kind='effect' THEN
   SELECT e.effect_kind INTO selected_kind FROM public.outreach_downstream_effects e WHERE e.id=subject AND e.organization_id=p_org;
   expected_payload:=CASE WHEN selected_kind='ghl_contact' THEN jsonb_strip_nulls(jsonb_build_object('locationId',conn.config->>'locationId','email',snap->'lead'->>'email','source','coldforge-outreach','firstName',nullif(snap->'lead'->>'firstName',''),'lastName',nullif(snap->'lead'->>'lastName',''),'phone',nullif(snap->'lead'->>'phone','')))
    WHEN selected_kind='ghl_opportunity' THEN jsonb_build_object('locationId',conn.config->>'locationId','pipelineId',conn.config->>'pipelineId','contactId',snap->>'crmContactId','name',coalesce(nullif(btrim(coalesce(snap->'lead'->>'firstName','')||' '||coalesce(snap->'lead'->>'lastName','')),''),snap->'lead'->>'email'),'status','open')
    WHEN selected_kind='closebot_forward' THEN jsonb_build_object('sourceId',conn.config->>'sourceId','event',jsonb_build_object('contactId',snap->'lead'->>'id','body',snap->>'body','state',jsonb_build_object('coldforgeLeadId',snap->'lead'->>'id','decisionId',snap->'decision'->>'id','threadId',snap->'decision'->>'thread_id','replyId',snap->'decision'->>'source_reply_id'))) ELSE NULL END;
  ELSIF kind='callback' THEN
   expected_payload:=jsonb_build_object('fromNumber',conn.config->>'fromNumber','toNumber',snap->'lead'->>'phone','idempotencyKey',subject,'metadata',jsonb_build_object('callbackId',subject,'organizationId',p_org));
  ELSIF kind='appointment_create' THEN
   expected_payload:=jsonb_strip_nulls(jsonb_build_object('locationId',appt.location_id,'calendarId',appt.calendar_id,'contactId',snap->>'contactId','startAt',body::jsonb->>'startAt','endAt',body::jsonb->>'endAt','timezone',appt.timezone));
   IF (body::jsonb->>'startAt')::timestamptz IS DISTINCT FROM appt.starts_at OR (body::jsonb->>'endAt')::timestamptz IS DISTINCT FROM appt.ends_at THEN RETURN jsonb_build_object('allowed',false,'reason','content_changed'); END IF;
  ELSIF kind='appointment_cancel' THEN expected_payload:=jsonb_build_object('appointmentId',appt.provider_appointment_id);
  ELSE
   expected_payload:=jsonb_strip_nulls(jsonb_build_object('locationId',appt.location_id,'appointmentId',appt.provider_appointment_id,'startAt',body::jsonb->>'startAt','endAt',body::jsonb->>'endAt','timezone',body::jsonb->>'timezone'));
   IF (body::jsonb->>'startAt')::timestamptz<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=body::jsonb->>'timezone') THEN RETURN jsonb_build_object('allowed',false,'reason','invalid_schedule'); END IF;
  END IF;
  IF expected_payload IS NULL OR expected_payload IS DISTINCT FROM body::jsonb THEN RETURN jsonb_build_object('allowed',false,'reason','content_changed'); END IF;
  INSERT INTO public.outreach_downstream_writes(organization_id,kind,subject_id,actor_id,provider,connection_revision,snapshot,payload,fingerprint)
   VALUES(p_org,kind,subject,actor,provider_name,conn.revision,snap,body::jsonb,fp) ON CONFLICT DO NOTHING RETURNING * INTO grant_row;
  IF grant_row.id IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','write_held'); END IF;
  RETURN jsonb_build_object('allowed',true,'writeId',grant_row.id,'writeToken',grant_row.token,'fingerprint',fp);
 END IF;
 IF p_action='authorizeWrite' THEN
  SELECT * INTO grant_row FROM public.outreach_downstream_writes WHERE id=(p_payload->>'writeId')::uuid AND organization_id=p_org AND token=(p_payload->>'writeToken')::uuid AND fingerprint=p_payload->>'fingerprint' AND state='reserved' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','write_held'); END IF;
  snap:=public.outreach_downstream_snapshot(p_org,grant_row.kind,grant_row.subject_id);
  SELECT * INTO conn FROM public.outreach_provider_connections WHERE organization_id=p_org AND provider=grant_row.provider;
  IF public.outreach_operations_outbound_stopped(p_org) OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=grant_row.actor_id AND organization_id=p_org AND role IN('owner','admin')) OR NOT conn.enabled OR conn.credential_ciphertext IS NULL OR conn.revision IS DISTINCT FROM grant_row.connection_revision OR snap IS NULL OR snap IS DISTINCT FROM grant_row.snapshot THEN RETURN jsonb_build_object('allowed',false,'reason','current_state_changed'); END IF;
  lead_id:=(snap->'lead'->>'id')::uuid;
  IF snap->'lead'->>'status' IN('unsubscribed','bounced','complained') OR EXISTS(SELECT 1 FROM public.outreach_suppressions WHERE organization_id=p_org AND normalized_email=lower(btrim(snap->'lead'->>'email'))) THEN RETURN jsonb_build_object('allowed',false,'reason','lead_suppressed'); END IF;
  IF grant_row.kind='effect' THEN
   IF NOT EXISTS(SELECT 1 FROM public.outreach_downstream_effects WHERE id=grant_row.subject_id AND organization_id=p_org AND status='dispatching' AND dispatch_lease_expires_at>clock_timestamp()) THEN RETURN jsonb_build_object('allowed',false,'reason','stale'); END IF;
   IF snap->>'latestReplyId' IS DISTINCT FROM snap->'decision'->>'source_reply_id' OR snap->'decision'->>'control_revision' IS DISTINCT FROM snap->'control'->>'revision' OR snap->'decision'->>'policy_revision' IS DISTINCT FROM snap->'policy'->>'revision' OR snap->'policy'->'policy'->>'enabled' IS DISTINCT FROM 'true' OR coalesce(snap->>'body','') ~* '(unsubscribe|opt.?out|remove me|stop (emailing|contacting|sending)|automatic reply|auto.?reply|out of (the )?office|on vacation)' OR snap->'control'->>'mode'='human' OR snap->'control'->>'merged' IS NOT NULL OR snap->>'bodyReady' IS DISTINCT FROM 'true' OR snap->'decision'->>'source_body_hash' IS DISTINCT FROM encode(sha256(convert_to(coalesce(snap->>'body',''),'UTF8')),'hex') THEN RETURN jsonb_build_object('allowed',false,'reason','decision_changed'); END IF;
   IF EXISTS(SELECT 1 FROM public.outreach_downstream_effects WHERE id=grant_row.subject_id AND effect_kind='ghl_opportunity') AND snap->'qualification'->>'outcome' IS DISTINCT FROM 'qualified' THEN RETURN jsonb_build_object('allowed',false,'reason','not_qualified'); END IF;
   IF grant_row.provider='closebot' AND NOT public.outreach_reply_decision_is_authorized(p_org,(snap->'decision'->>'thread_id')::uuid,(snap->'decision'->>'source_reply_id')::uuid,(snap->'decision'->>'control_revision')::bigint,(snap->'decision'->>'id')::uuid,snap->'decision'->>'fingerprint',clock_timestamp()) THEN RETURN jsonb_build_object('allowed',false,'reason','decision_changed'); END IF;
   IF grant_row.provider='closebot' AND (snap->'control'->>'mode' IS DISTINCT FROM 'autonomous' OR snap->'policy'->'policy'->>'enabled' IS DISTINCT FROM 'true' OR (snap->'decision'->>'created_at')::timestamptz<clock_timestamp()-interval '15 minutes' OR snap->'decision'->>'approved' IS DISTINCT FROM 'true' OR snap->'decision'->>'control_revision' IS DISTINCT FROM snap->'control'->>'revision' OR snap->'decision'->>'policy_revision' IS DISTINCT FROM snap->'policy'->>'revision' OR snap->'decision'->>'brief_revision' IS DISTINCT FROM snap->>'briefRevision') THEN RETURN jsonb_build_object('allowed',false,'reason','decision_changed'); END IF;
  ELSIF grant_row.kind='callback' THEN
   SELECT * INTO elig FROM public.outreach_callback_eligibility WHERE id=(snap->'eligibility'->>'id')::uuid AND organization_id=p_org;
   IF elig.revoked_at IS NOT NULL OR elig.expires_at<=clock_timestamp() OR elig.calls_started>elig.max_calls OR elig.phone_e164 IS DISTINCT FROM snap->'lead'->>'phone' OR extract(hour FROM clock_timestamp() AT TIME ZONE elig.timezone)<elig.window_start_hour OR extract(hour FROM clock_timestamp() AT TIME ZONE elig.timezone)>=elig.window_end_hour OR grant_row.payload->>'fromNumber' IS DISTINCT FROM conn.config->>'fromNumber' THEN RETURN jsonb_build_object('allowed',false,'reason','eligibility_changed'); END IF;
  END IF;
  UPDATE public.outreach_downstream_writes SET state='authorized',authorized_at=clock_timestamp() WHERE id=grant_row.id;
  RETURN jsonb_build_object('allowed',true);
 END IF;
 IF p_action IN('settleEffect','settleCallback','settleAppointment') THEN
  SELECT * INTO grant_row FROM public.outreach_downstream_writes WHERE id=(p_payload->>'writeId')::uuid AND organization_id=p_org AND token=(p_payload->>'writeToken')::uuid AND fingerprint=p_payload->>'fingerprint' AND state IN('authorized','unknown') FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result','stale'); END IF;
  subject:=coalesce((p_payload->>'effectId')::uuid,(p_payload->>'callbackId')::uuid,(p_payload->>'appointmentId')::uuid);
  IF subject IS DISTINCT FROM grant_row.subject_id OR (p_action='settleEffect') IS DISTINCT FROM (grant_row.kind='effect') OR (p_action='settleCallback') IS DISTINCT FROM (grant_row.kind='callback') THEN RETURN jsonb_build_object('result','stale'); END IF;
  IF p_payload->>'status' NOT IN('unknown','failed','skipped') AND (
    grant_row.kind='appointment_cancel' AND p_payload->>'status'<>'cancelled' OR
    grant_row.kind='appointment_reschedule' AND p_payload->>'status'<>'rescheduled' OR
    grant_row.kind='appointment_create' AND p_payload->>'status'<>'scheduled' OR
    grant_row.kind='callback' AND p_payload->>'status'<>'initiated' OR
    grant_row.kind='effect' AND p_payload->>'status'<>'succeeded') THEN RETURN jsonb_build_object('result','stale'); END IF;
  IF grant_row.kind IN('appointment_create','appointment_reschedule') AND p_payload->>'status' IN('scheduled','rescheduled') AND
   (p_payload->>'startsAt')::timestamptz IS DISTINCT FROM (grant_row.payload->>'startAt')::timestamptz THEN RETURN jsonb_build_object('result','stale'); END IF;
  result:=public.outreach_downstream_effect_private(p_org,p_action,p_payload);
  IF result->>'result'='settled' AND p_action IN('settleCallback','settleAppointment') THEN
    FOR stored_event IN SELECT event_payload FROM public.outreach_downstream_webhook_events
      WHERE organization_id=p_org AND event_payload IS NOT NULL AND
      (p_action='settleCallback' AND provider='retell' AND provider_call_id=p_payload->>'providerCallId'
       OR p_action='settleAppointment' AND provider='ghl' AND event_payload->>'providerAppointmentId'=p_payload->>'providerAppointmentId') ORDER BY received_at,id LOOP
      PERFORM public.outreach_downstream_effect_private(p_org,'recordWebhookEvent',stored_event.event_payload);
    END LOOP;
  END IF;
  IF result->>'result'='settled' THEN UPDATE public.outreach_downstream_writes SET state=CASE WHEN p_payload->>'status' IN('succeeded','initiated','scheduled','rescheduled','cancelled') THEN 'succeeded' ELSE 'unknown' END,settled_at=clock_timestamp() WHERE id=grant_row.id; END IF;
  RETURN result;
 END IF;
 result:=public.outreach_downstream_effect_private(p_org,p_action,p_payload);
 IF p_action='reserveEffect' AND result->>'allowed'='true' THEN
  UPDATE public.outreach_downstream_effects SET source_snapshot=public.outreach_downstream_snapshot(p_org,'effect',id) WHERE id=(result->>'effectId')::uuid AND organization_id=p_org;
 ELSIF p_action='reserveCallback' AND result->>'allowed'='true' THEN
  UPDATE public.outreach_callbacks SET source_snapshot=public.outreach_downstream_snapshot(p_org,'callback',id) WHERE id=(result->>'callbackId')::uuid AND organization_id=p_org;
 ELSIF p_action='reserveAppointment' AND result->>'allowed'='true' THEN
  UPDATE public.outreach_appointments SET source_snapshot=public.outreach_downstream_snapshot(p_org,'appointment_create',id) WHERE id=(result->>'appointmentId')::uuid AND organization_id=p_org;
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.outreach_downstream_effect(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.outreach_downstream_effect(uuid,text,jsonb) TO service_role;

COMMIT;
