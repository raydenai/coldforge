BEGIN;
-- Shard 031: authenticated, bounded automated email operations.
--
-- This migration is additive. It owns:
--   * per-organization automation control (disabled by default) with a clear
--     split between "scheduler paused" and the master outbound stop;
--   * durable scheduler leases/runs/heartbeats, service-only and RLS-guarded;
--   * two SECURITY DEFINER RPCs (claim/settle) and one owner/admin control RPC;
--   * the master outbound stop enforced at the final shared send gate by
--     wrapping 029's `email_dispatch_mutate` and `outreach_reply_mutate`.
--
-- The 029/030 send ledgers stay the source of authority. Settlement, audit and
-- already-authorized in-flight effects are never blocked by the master stop.

-- ---------------------------------------------------------------------------
-- Service-only durable state. Browser roles can never read or write it; even
-- service_role only gets SELECT, every transition goes through an RPC.
-- ---------------------------------------------------------------------------
CREATE TABLE public.outreach_operations_control (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id),
  automation_enabled boolean NOT NULL DEFAULT false,
  scheduler_paused boolean NOT NULL DEFAULT false,
  master_stop boolean NOT NULL DEFAULT false,
  phase_cursor smallint NOT NULL DEFAULT 0 CHECK(phase_cursor BETWEEN 0 AND 3),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision > 0),
  enabled_at timestamptz,
  enabled_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

CREATE TABLE public.outreach_operations_heartbeats (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id),
  revision bigint NOT NULL DEFAULT 0 CHECK(revision >= 0),
  last_attempt_at timestamptz,
  last_attempt_phase text,
  last_attempt_status text,
  last_attempt_detail text,
  last_success_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK(consecutive_failures >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.outreach_operations_leases (
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  scope_key text NOT NULL,
  lease_token uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,scope_key)
);

CREATE TABLE public.outreach_operations_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  phase text NOT NULL CHECK(phase IN('campaign','body','decision','reply')),
  scope_key text NOT NULL,
  campaign_id uuid REFERENCES public.campaigns(id),
  reference_id uuid,
  reference_fingerprint text,
  status text NOT NULL CHECK(status IN('running','idle','completed','held','blocked')),
  reason text,
  lease_token uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  attempt_id uuid,
  decision_id uuid,
  model_calls integer NOT NULL DEFAULT 0 CHECK(model_calls >= 0),
  smtp_attempts integer NOT NULL DEFAULT 0 CHECK(smtp_attempts >= 0),
  actor_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);

CREATE INDEX outreach_operations_runs_attention
  ON public.outreach_operations_runs(organization_id,settled_at DESC)
  WHERE status IN('held','blocked');
CREATE INDEX outreach_operations_runs_lease
  ON public.outreach_operations_runs(status,lease_expires_at);
-- Campaign fairness orders by the last campaign-phase selection per campaign.
CREATE INDEX outreach_operations_runs_campaign_selection
  ON public.outreach_operations_runs(organization_id,campaign_id,started_at DESC)
  WHERE phase='campaign';

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['outreach_operations_control','outreach_operations_heartbeats','outreach_operations_leases','outreach_operations_runs'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
    EXECUTE format('GRANT SELECT ON public.%I TO service_role',t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Internal predicates. SECURITY DEFINER so the send-gate wrappers can consult
-- the control row; the ACL below denies any direct client execution.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.outreach_operations_outbound_stopped(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT coalesce((SELECT master_stop FROM public.outreach_operations_control WHERE organization_id=p_org),false)
$$;

-- Expire any run whose lease lapsed. An expired external-effect run is held as
-- outcome-unknown and is never automatically replayed; settlement afterwards is
-- fenced stale by the exact lease token/expiry comparison.
CREATE FUNCTION public.outreach_operations_expire_runs() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE n integer;
BEGIN
  UPDATE public.outreach_operations_runs
    SET status='held',reason=coalesce(reason,'lease_expired_outcome_unknown'),settled_at=clock_timestamp()
    WHERE status='running' AND lease_expires_at<=clock_timestamp();
  GET DIAGNOSTICS n=ROW_COUNT;
  DELETE FROM public.outreach_operations_leases WHERE lease_expires_at<=clock_timestamp();
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------
-- Claim exactly one phase for one organization.
--   * p_org NULL -> globally fair round-robin across eligible organizations.
--   * p_org set  -> one manual tick scoped to that organization.
-- The resolved actor is a *current* real owner/admin of the organization; if
-- membership changed, the claim refuses rather than acting as a stale user.
-- The phase cursor and per-phase lease make overlaps impossible and keep a
-- blocked phase from starving the others.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.outreach_operations_claim(
  p_lease_token uuid,
  p_lease_seconds integer,
  p_org uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  phases text[]:=ARRAY['campaign','body','decision','reply'];
  v_org uuid; v_actor uuid; v_role text; v_phase text; v_campaign uuid; v_scope text; v_expires timestamptz;
  v_now timestamptz:=clock_timestamp(); v_cursor smallint; v_paused boolean; v_stopped boolean; v_run uuid;
BEGIN
  IF p_lease_token IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 1 AND 3600 THEN
    RETURN jsonb_build_object('result','invalid');
  END IF;
  PERFORM public.outreach_operations_expire_runs();
  IF p_org IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM public.organizations WHERE id=p_org) THEN
      RETURN jsonb_build_object('result','idle','reason','organization_not_found');
    END IF;
    SELECT u.id,u.role INTO v_actor,v_role FROM public.users u
      WHERE u.organization_id=p_org AND u.role IN('owner','admin')
      ORDER BY (u.role='owner') DESC,u.id LIMIT 1;
    IF v_actor IS NULL THEN RETURN jsonb_build_object('result','idle','reason','no_owner_admin'); END IF;
    v_org:=p_org;
  ELSE
    SELECT c.organization_id,u.id,u.role INTO v_org,v_actor,v_role
      FROM public.outreach_operations_control c
      JOIN LATERAL(
        SELECT id,role FROM public.users
        WHERE organization_id=c.organization_id AND role IN('owner','admin')
        ORDER BY (role='owner') DESC,id LIMIT 1
      ) u ON true
      LEFT JOIN public.outreach_operations_heartbeats h ON h.organization_id=c.organization_id
      WHERE c.automation_enabled AND NOT c.scheduler_paused AND NOT c.master_stop
        AND NOT EXISTS(SELECT 1 FROM public.outreach_operations_leases l WHERE l.organization_id=c.organization_id AND l.lease_expires_at>clock_timestamp())
      ORDER BY h.last_attempt_at ASC NULLS FIRST,c.organization_id
      LIMIT 1;
    IF v_org IS NULL THEN RETURN jsonb_build_object('result','idle','reason','no_eligible_organization'); END IF;
  END IF;

  INSERT INTO public.outreach_operations_control(organization_id) VALUES(v_org) ON CONFLICT DO NOTHING;
  SELECT phase_cursor,scheduler_paused,master_stop INTO v_cursor,v_paused,v_stopped
    FROM public.outreach_operations_control WHERE organization_id=v_org FOR UPDATE;
  IF v_stopped THEN RETURN jsonb_build_object('result','idle','reason','master_stop','organizationId',v_org); END IF;
  IF v_paused THEN RETURN jsonb_build_object('result','idle','reason','scheduler_paused','organizationId',v_org); END IF;

  v_phase:=phases[(v_cursor % 4) + 1];
  UPDATE public.outreach_operations_control SET phase_cursor=((phase_cursor + 1) % 4),updated_at=v_now WHERE organization_id=v_org;

  IF v_phase='campaign' THEN
    -- Fairness is derived from the durable campaign-phase *selection/attempt*
    -- (a run is recorded for every claim, including blocked/idle outcomes), not
    -- from successful SMTP settlements. A killed, unconfigured or no-candidate
    -- campaign therefore rotates to the back of the queue instead of starving
    -- every later eligible campaign forever.
    SELECT c.id INTO v_campaign FROM public.campaigns c
      WHERE c.organization_id=v_org AND c.status='active'
      ORDER BY (SELECT max(r.started_at) FROM public.outreach_operations_runs r
                 WHERE r.organization_id=v_org AND r.phase='campaign' AND r.campaign_id=c.id) ASC NULLS FIRST,c.id
      LIMIT 1;
  END IF;

  v_scope:=v_phase||CASE WHEN v_campaign IS NOT NULL THEN ':'||v_campaign::text ELSE '' END;
  v_expires:=v_now + make_interval(secs=>p_lease_seconds);
  INSERT INTO public.outreach_operations_leases(organization_id,scope_key,lease_token,lease_expires_at,updated_at)
    VALUES(v_org,v_scope,p_lease_token,v_expires,v_now)
    ON CONFLICT(organization_id,scope_key) DO UPDATE
      SET lease_token=EXCLUDED.lease_token,lease_expires_at=EXCLUDED.lease_expires_at,updated_at=EXCLUDED.updated_at
      WHERE public.outreach_operations_leases.lease_expires_at<=v_now;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result','idle','reason','phase_busy','organizationId',v_org,'phase',v_phase);
  END IF;

  INSERT INTO public.outreach_operations_runs(organization_id,phase,scope_key,campaign_id,status,lease_token,lease_expires_at,actor_id)
    VALUES(v_org,v_phase,v_scope,v_campaign,'running',p_lease_token,v_expires,v_actor)
    RETURNING id INTO v_run;
  RETURN jsonb_build_object('result','claimed','runId',v_run,'leaseToken',p_lease_token,'leaseExpiresAt',v_expires,'organizationId',v_org,'actorId',v_actor,'role',v_role,'phase',v_phase,'campaignId',v_campaign,'scopeKey',v_scope);
END $$;

-- ---------------------------------------------------------------------------
-- Settle one claimed run. The token AND its exact expiry must still be current,
-- which fences a zombie worker from settling a successor claim.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.outreach_operations_settle(
  p_org uuid,
  p_scope_key text,
  p_lease_token uuid,
  p_lease_expires_at timestamptz,
  p_status text,
  p_reason text DEFAULT NULL,
  p_attempt_id uuid DEFAULT NULL,
  p_decision_id uuid DEFAULT NULL,
  p_reference_id uuid DEFAULT NULL,
  p_reference_fingerprint text DEFAULT NULL,
  p_model_calls integer DEFAULT 0,
  p_smtp_attempts integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.outreach_operations_runs; now_at timestamptz:=clock_timestamp();
BEGIN
  IF p_status NOT IN('idle','completed','held','blocked') THEN RETURN jsonb_build_object('result','invalid'); END IF;
  SELECT * INTO r FROM public.outreach_operations_runs
    WHERE organization_id=p_org AND scope_key=p_scope_key AND lease_token=p_lease_token
    FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result','not_found'); END IF;
  IF r.status<>'running' OR r.lease_expires_at IS DISTINCT FROM p_lease_expires_at OR r.lease_expires_at<=now_at THEN
    RETURN jsonb_build_object('result','stale');
  END IF;
  UPDATE public.outreach_operations_runs
    SET status=p_status,reason=left(p_reason,500),attempt_id=p_attempt_id,decision_id=p_decision_id,
        reference_id=p_reference_id,reference_fingerprint=left(p_reference_fingerprint,200),
        model_calls=greatest(0,coalesce(p_model_calls,0)),smtp_attempts=greatest(0,coalesce(p_smtp_attempts,0)),settled_at=now_at
    WHERE id=r.id;
  DELETE FROM public.outreach_operations_leases WHERE organization_id=p_org AND scope_key=p_scope_key AND lease_token=p_lease_token;
  INSERT INTO public.outreach_operations_heartbeats(organization_id,revision,last_attempt_at,last_attempt_phase,last_attempt_status,last_attempt_detail,last_success_at,consecutive_failures,updated_at)
    VALUES(p_org,1,now_at,r.phase,p_status,left(p_reason,500),CASE WHEN p_status IN('completed','idle') THEN now_at ELSE NULL END,CASE WHEN p_status IN('completed','idle') THEN 0 ELSE 1 END,now_at)
    ON CONFLICT(organization_id) DO UPDATE SET
      revision=public.outreach_operations_heartbeats.revision+1,
      last_attempt_at=now_at,
      last_attempt_phase=r.phase,
      last_attempt_status=p_status,
      last_attempt_detail=left(p_reason,500),
      last_success_at=CASE WHEN p_status IN('completed','idle') THEN now_at ELSE public.outreach_operations_heartbeats.last_success_at END,
      consecutive_failures=CASE WHEN p_status IN('completed','idle') THEN 0 ELSE public.outreach_operations_heartbeats.consecutive_failures+1 END,
      updated_at=now_at;
  RETURN jsonb_build_object('result','settled','runId',r.id,'status',p_status);
END $$;

-- ---------------------------------------------------------------------------
-- Owner/admin control + honest status read. The enable decision itself is made
-- server-side in the route (readiness needs provider facts SQL does not own);
-- SQL only enforces current membership and revision fencing.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.outreach_operations_mutate(
  p_actor uuid,
  p_org uuid,
  p_action text,
  p_payload jsonb DEFAULT '{}'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE ctl public.outreach_operations_control; hb public.outreach_operations_heartbeats; now_at timestamptz:=clock_timestamp();
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('outreach-operations:'||p_org::text,0));
  -- stop/resumeStop participate in the same email-dispatch organization lock as
  -- the send-gate wrappers so a stop cannot commit between a wrapper's fresh
  -- stop read and its grant. Lock order is operations -> email-dispatch and the
  -- send-gate wrappers take only email-dispatch, so no cycle is possible.
  IF p_action IN('stop','resumeStop') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('email-dispatch:'||p_org::text,0));
  END IF;
  PERFORM 1 FROM public.users WHERE id=p_actor AND organization_id=p_org AND role IN('owner','admin') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'operations:forbidden'; END IF;
  INSERT INTO public.outreach_operations_control(organization_id) VALUES(p_org) ON CONFLICT DO NOTHING;
  SELECT * INTO ctl FROM public.outreach_operations_control WHERE organization_id=p_org FOR UPDATE;
  INSERT INTO public.outreach_operations_heartbeats(organization_id) VALUES(p_org) ON CONFLICT DO NOTHING;
  SELECT * INTO hb FROM public.outreach_operations_heartbeats WHERE organization_id=p_org;

  IF p_action='read' THEN
    RETURN jsonb_build_object(
      'control',jsonb_build_object('revision',ctl.revision,'automationEnabled',ctl.automation_enabled,'schedulerPaused',ctl.scheduler_paused,'masterStop',ctl.master_stop,'enabledAt',ctl.enabled_at,'updatedAt',ctl.updated_at),
      'heartbeat',jsonb_build_object('revision',hb.revision,'lastAttemptAt',hb.last_attempt_at,'lastAttemptPhase',hb.last_attempt_phase,'lastAttemptStatus',hb.last_attempt_status,'lastAttemptDetail',hb.last_attempt_detail,'lastSuccessAt',hb.last_success_at,'consecutiveFailures',hb.consecutive_failures),
      'stats',jsonb_build_object(
        'attemptsAccepted',(SELECT count(*) FROM public.email_dispatch_attempts WHERE organization_id=p_org AND status='accepted'),
        'attemptsUnknown',(SELECT count(*) FROM public.email_dispatch_attempts WHERE organization_id=p_org AND status='unknown'),
        'attemptsReserved',(SELECT count(*) FROM public.email_dispatch_attempts WHERE organization_id=p_org AND status='reserved'),
        'sendsAcceptedToday',(SELECT count(*) FROM public.email_dispatch_attempts WHERE organization_id=p_org AND status='accepted' AND settled_at>=date_trunc('day',now_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
        'agentRunsUnknown',(SELECT count(*) FROM public.outreach_agent_runs WHERE organization_id=p_org AND status='unknown'),
        'bodyPending',(SELECT count(*) FROM public.winnr_ingested_messages WHERE organization_id=p_org AND body_status='pending'),
        'decisionsPending',(SELECT count(*) FROM public.outreach_agent_decisions d WHERE d.organization_id=p_org AND d.approved AND NOT EXISTS(SELECT 1 FROM public.email_dispatch_attempts a WHERE a.organization_id=p_org AND a.thread_id=d.thread_id AND a.source_reply_id=d.source_reply_id AND a.kind='reply' AND a.status<>'cancelled'))
      ),
      'attention',(SELECT coalesce(jsonb_agg(jsonb_build_object('kind',kind,'referenceId',reference_id,'reason',reason,'observedAt',observed_at,'fingerprint',fingerprint) ORDER BY observed_at DESC NULLS LAST),'[]'::jsonb) FROM (
        SELECT 'smtp_unknown'::text kind,a.id::text reference_id,a.error_code reason,a.settled_at observed_at,a.fingerprint fingerprint FROM public.email_dispatch_attempts a WHERE a.organization_id=p_org AND a.status='unknown'
        UNION ALL
        SELECT 'model_unknown',r.id::text,r.error_code,coalesce(r.settled_at,r.created_at),r.model FROM public.outreach_agent_runs r WHERE r.organization_id=p_org AND r.status='unknown'
        UNION ALL
        SELECT 'body_pending',m.id::text,m.body_status,m.received_at,m.message_id FROM public.winnr_ingested_messages m WHERE m.organization_id=p_org AND m.body_status='pending'
        UNION ALL
        SELECT 'provider_unknown',w.id::text,w.error_code,coalesce(w.settled_at,w.updated_at),w.request_fingerprint FROM public.winnr_operations w WHERE w.organization_id=p_org AND w.status='unknown'
        UNION ALL
        SELECT 'run_'||run.status,run.id::text,run.reason,run.settled_at,run.reference_fingerprint FROM public.outreach_operations_runs run WHERE run.organization_id=p_org AND run.status IN('held','blocked')
      ) att),
      'runs',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'phase',phase,'status',status,'reason',reason,'campaignId',campaign_id,'referenceId',reference_id,'referenceFingerprint',reference_fingerprint,'attemptId',attempt_id,'decisionId',decision_id,'modelCalls',model_calls,'smtpAttempts',smtp_attempts,'startedAt',started_at,'settledAt',settled_at) ORDER BY started_at DESC),'[]'::jsonb) FROM (SELECT * FROM public.outreach_operations_runs WHERE organization_id=p_org ORDER BY started_at DESC LIMIT 15) rr)
    );
  END IF;

  IF p_action NOT IN('enable','disable','pause','resume','stop','resumeStop') THEN RAISE EXCEPTION 'operations:invalid'; END IF;
  IF p_payload->>'expectedRevision' IS NULL THEN RAISE EXCEPTION 'operations:invalid'; END IF;
  IF ctl.revision IS DISTINCT FROM (p_payload->>'expectedRevision')::bigint THEN RAISE EXCEPTION 'operations:stale'; END IF;
  UPDATE public.outreach_operations_control SET
    automation_enabled=CASE WHEN p_action='enable' THEN true WHEN p_action='disable' THEN false ELSE automation_enabled END,
    scheduler_paused=CASE WHEN p_action='pause' THEN true WHEN p_action='resume' THEN false ELSE scheduler_paused END,
    master_stop=CASE WHEN p_action='stop' THEN true WHEN p_action='resumeStop' THEN false ELSE master_stop END,
    enabled_at=CASE WHEN p_action='enable' THEN now_at ELSE enabled_at END,
    enabled_by=CASE WHEN p_action='enable' THEN p_actor ELSE enabled_by END,
    revision=revision+1,updated_at=now_at,updated_by=p_actor
    WHERE organization_id=p_org RETURNING * INTO ctl;
  RETURN jsonb_build_object('saved',true,'revision',ctl.revision,'automationEnabled',ctl.automation_enabled,'schedulerPaused',ctl.scheduler_paused,'masterStop',ctl.master_stop);
END $$;

-- ---------------------------------------------------------------------------
-- Static enablement readiness. Provider mailbox availability is deliberately
-- not asserted here: it is revalidated at each send by the 029/024 gate. This
-- only proves the operator has the durable setup the scheduler needs, and names
-- each missing input so the UI can link straight to it.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.outreach_operations_readiness(p_org uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  WITH conn AS (
    SELECT id,version FROM public.winnr_connections WHERE organization_id=p_org ORDER BY version DESC LIMIT 1
  ), mail AS (
    SELECT count(*) n FROM public.winnr_mailbox_credentials m JOIN conn ON conn.id=m.connection_id AND conn.version=m.connection_version
  ), active AS (
    SELECT count(*) n FROM public.campaigns WHERE organization_id=p_org AND status='active'
  ), configured AS (
    SELECT count(*) n FROM public.campaigns c JOIN public.email_dispatch_config cfg ON cfg.campaign_id=c.id AND cfg.organization_id=p_org
    WHERE c.organization_id=p_org AND c.status='active' AND NOT cfg.killed AND public.winnr_ingestion_is_ready(p_org,cfg.connection_id,cfg.connection_version)
  ), agent_needed AS (
    SELECT count(*) n FROM public.campaigns c JOIN public.outreach_agent_policies p ON p.campaign_id=c.id AND p.organization_id=p_org
    WHERE c.organization_id=p_org AND c.status='active' AND (p.policy->>'enabled')::boolean
  ), agent_model AS (
    SELECT count(*) n FROM public.outreach_agent_models WHERE organization_id=p_org AND api_key_ciphertext IS NOT NULL
  )
  SELECT jsonb_build_object(
    'ready',(SELECT count(*) FROM conn)>0 AND (SELECT n FROM mail)>0 AND (SELECT n FROM active)>0 AND (SELECT n FROM configured)>0 AND ((SELECT n FROM agent_needed)=0 OR (SELECT n FROM agent_model)>0),
    'activeCampaigns',(SELECT n FROM active),
    'configuredCampaigns',(SELECT n FROM configured),
    'blockers',(SELECT coalesce(jsonb_agg(b),'[]'::jsonb) FROM (
      SELECT jsonb_build_object('code','winnr_connection','label','Connect Winnr','href','/winnr') b WHERE (SELECT count(*) FROM conn)=0
      UNION ALL
      SELECT jsonb_build_object('code','smtp_mailbox','label','Sync an SMTP mailbox','href','/winnr') WHERE (SELECT n FROM mail)=0
      UNION ALL
      SELECT jsonb_build_object('code','active_campaign','label','Start a campaign','href','/campaigns') WHERE (SELECT n FROM active)=0
      UNION ALL
      SELECT jsonb_build_object('code','dispatch_configuration','label','Finish an active campaign''s sender and ingestion setup','href','/campaigns') WHERE (SELECT n FROM active)>0 AND (SELECT n FROM configured)=0
      UNION ALL
      SELECT jsonb_build_object('code','agent_model','label','Configure the conversation agent model','href','/inbox') WHERE (SELECT n FROM agent_needed)>0 AND (SELECT n FROM agent_model)=0
    ) x)
  )
$$;

-- ---------------------------------------------------------------------------
-- Master outbound stop at the one shared send gate. 029's wrappers are kept
-- private (no service-role EXECUTE) and are reachable only through this gate.
-- Only new reservations/authorizations are refused; settling a receipt, reading
-- readiness and every audit path stay available.
-- ---------------------------------------------------------------------------
ALTER FUNCTION public.email_dispatch_mutate(uuid,uuid,text,jsonb) RENAME TO email_dispatch_mutate_029;
REVOKE ALL ON FUNCTION public.email_dispatch_mutate_029(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.email_dispatch_mutate(p_actor uuid,p_org uuid,p_action text,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  -- Acquire the shared email-dispatch organization lock *before* reading the
  -- master stop so a committed stop can never be observed stale and bypassed by
  -- a queued authorization. The nested 029 call re-acquires the same lock
  -- reentrantly.
  PERFORM pg_advisory_xact_lock(hashtextextended('email-dispatch:'||p_org::text,0));
  IF p_action IN('reserve','authorize') AND public.outreach_operations_outbound_stopped(p_org) THEN
    RETURN jsonb_build_object('ready',false,'allowed',false,'reason','outbound_stopped');
  END IF;
  RETURN public.email_dispatch_mutate_029(p_actor,p_org,p_action,p_payload);
END $$;
REVOKE ALL ON FUNCTION public.email_dispatch_mutate(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.email_dispatch_mutate(uuid,uuid,text,jsonb) TO service_role;

ALTER FUNCTION public.outreach_reply_mutate(uuid,uuid,text,jsonb) RENAME TO outreach_reply_mutate_029;
REVOKE ALL ON FUNCTION public.outreach_reply_mutate_029(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.outreach_reply_mutate(p_actor uuid,p_org uuid,p_action text,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  -- Same lock-before-stop-read discipline as the campaign wrapper.
  PERFORM pg_advisory_xact_lock(hashtextextended('email-dispatch:'||p_org::text,0));
  IF p_action IN('reserve','authorize') AND public.outreach_operations_outbound_stopped(p_org) THEN
    RETURN jsonb_build_object('ready',false,'allowed',false,'reason','outbound_stopped');
  END IF;
  RETURN public.outreach_reply_mutate_029(p_actor,p_org,p_action,p_payload);
END $$;
REVOKE ALL ON FUNCTION public.outreach_reply_mutate(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.outreach_reply_mutate(uuid,uuid,text,jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.outreach_operations_outbound_stopped(uuid),public.outreach_operations_expire_runs() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.outreach_operations_claim(uuid,integer,uuid),public.outreach_operations_settle(uuid,text,uuid,timestamptz,text,text,uuid,uuid,uuid,text,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.outreach_operations_claim(uuid,integer,uuid),public.outreach_operations_settle(uuid,text,uuid,timestamptz,text,text,uuid,uuid,uuid,text,integer,integer) TO service_role;
REVOKE ALL ON FUNCTION public.outreach_operations_readiness(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.outreach_operations_readiness(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.outreach_operations_mutate(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.outreach_operations_mutate(uuid,uuid,text,jsonb) TO service_role;
COMMIT;
