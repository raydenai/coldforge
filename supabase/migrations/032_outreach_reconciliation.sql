-- 032 verified SMTP reconciliation.
--
-- An operator may resolve a held (`unknown`, or `dispatching` whose lease has
-- expired) email dispatch attempt by recording a past provider effect that is
-- already proven by authenticated Winnr relay evidence. This migration never
-- sends, never retries and never fabricates a receipt: it joins the frozen
-- attempt message identity to the persisted 027 mapping/receipt ledger and only
-- then applies the exact 024/029 accepted-settlement semantics.
BEGIN;

-- 027 owns the mapping ledger. The authoritative lookup is by frozen RFC
-- Message-ID; additive index (027's file is unchanged).
CREATE INDEX outreach_reconciliation_maps_lookup
  ON public.winnr_message_id_maps(organization_id,account_id,original_message_id);

-- Durable, attributable, append-only reconciliation audit. The source receipt
-- row, mapping identity and fingerprint are retained verbatim.
CREATE TABLE public.outreach_reconciliation_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES public.organizations(id),
 attempt_id uuid NOT NULL REFERENCES public.email_dispatch_attempts(id),
 kind text NOT NULL CHECK(kind IN('campaign','reply')),
 status_before text NOT NULL CHECK(status_before IN('unknown','dispatching')),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 message_id text NOT NULL,
 provider_message_id text NOT NULL,
 recipient text NOT NULL,
 sender text NOT NULL,
 account_id uuid NOT NULL REFERENCES public.email_accounts(id),
 connection_id uuid NOT NULL,
 connection_version integer NOT NULL,
 provider_account_id text NOT NULL,
 source_receipt_id uuid NOT NULL REFERENCES public.winnr_ingestion_receipts(id),
 source_receipt_fingerprint text NOT NULL CHECK(length(source_receipt_fingerprint)=64),
 source_receipt_at timestamptz NOT NULL,
 source_receipt_arrival_at timestamptz NOT NULL,
 event_id uuid NOT NULL REFERENCES public.outreach_events(id),
 reconciled_by uuid NOT NULL,
 reconciled_at timestamptz NOT NULL,
 UNIQUE(attempt_id)
);
ALTER TABLE public.outreach_reconciliation_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.outreach_reconciliation_audit FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.outreach_reconciliation_audit TO service_role;
CREATE POLICY service_only ON public.outreach_reconciliation_audit TO service_role USING(true) WITH CHECK(true);
CREATE FUNCTION public.outreach_reconciliation_audit_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'reconciliation:audit_immutable'; END $$;
CREATE TRIGGER outreach_reconciliation_audit_guard BEFORE UPDATE OR DELETE ON public.outreach_reconciliation_audit FOR EACH ROW EXECUTE FUNCTION public.outreach_reconciliation_audit_guard();
REVOKE ALL ON FUNCTION public.outreach_reconciliation_audit_guard() FROM PUBLIC,anon,authenticated,service_role;

-- Authenticated provider event time for one persisted receipt payload.
--
-- Prefers the provider-supplied `data.relayed_at` whenever that key is present.
-- Falls back to the signed envelope `created` ONLY while `relayed_at` is
-- absent. A supplied value that is not a strict ISO-8601 instant (wrong JSON
-- type, empty, unparseable) resolves to NULL so the caller holds the attempt;
-- it is never silently replaced by the envelope fallback. The strict regex plus
-- the guarded cast keep malformed private-fixture payloads from raising and
-- aborting the whole list/status page. Local `receipts.created_at` is the
-- arrival time and is never substituted here as event proof.
CREATE FUNCTION public.outreach_reconciliation_event_time(p_payload jsonb)
RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE v_raw text; v_ts timestamptz;
BEGIN
 IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' THEN RETURN NULL; END IF;
 IF p_payload->'data' ? 'relayed_at' THEN
  IF jsonb_typeof(p_payload->'data'->'relayed_at')<>'string' THEN RETURN NULL; END IF;
  v_raw:=p_payload->'data'->>'relayed_at';
 ELSE
  IF NOT(p_payload ? 'created') OR jsonb_typeof(p_payload->'created')<>'string' THEN RETURN NULL; END IF;
  v_raw:=p_payload->>'created';
 END IF;
 IF v_raw IS NULL OR v_raw !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?([Zz]|[+-]\d{2}:\d{2})$' THEN RETURN NULL; END IF;
 BEGIN v_ts:=v_raw::timestamptz; EXCEPTION WHEN others THEN RETURN NULL; END;
 RETURN v_ts;
END $$;

-- Persisted evidence candidates for one held attempt. A candidate must share
-- the attempt's frozen organization/Message-ID and must belong to the provider
-- account bound to the attempt's exact immutable endpoint (connection UUID AND
-- connection_version). Deriving that expected provider account from the exact
-- versioned endpoint prevents a retained older/newer endpoint from proving a
-- different account, and the single version-qualified endpoint row cannot
-- multiply one receipt across old and current endpoints. Same-provider mappings
-- ingested under a later reconnect still match on the stable provider account.
-- A candidate is only complete with its authenticated receipt row; the
-- authenticated provider event time and the local arrival time are returned
-- separately. The caller still has to prove exact canonical account, recipient
-- and sender; ambiguous or mismatched candidates are held.
CREATE FUNCTION public.outreach_reconciliation_candidates(p_org uuid,p_attempt uuid)
RETURNS TABLE(receipt_id uuid,receipt_fingerprint text,receipt_event_at timestamptz,receipt_arrival_at timestamptz,provider_message_id text,provider_account_id text,account_id uuid,original_message_id text,recipient text,sender text,connection_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT r.id,r.fingerprint,r.event_at,r.arrival_at,m.provider_message_id,m.provider_account_id,m.account_id,m.original_message_id,lower(btrim(m.recipient)),lower(btrim(r.sender)),m.connection_id
 FROM public.email_dispatch_attempts a
 JOIN public.winnr_ingestion_endpoints e
   ON e.organization_id=a.organization_id AND e.connection_id=a.connection_id AND e.connection_version=a.connection_version
 JOIN public.winnr_message_id_maps m
   ON m.organization_id=a.organization_id AND m.provider_account_id=e.provider_account_id AND m.original_message_id=a.message->>'messageId'
 JOIN LATERAL (
  SELECT rr.id,rr.fingerprint,public.outreach_reconciliation_event_time(rr.payload) AS event_at,rr.created_at AS arrival_at,rr.payload->'data'->>'sender' AS sender
  FROM public.winnr_ingestion_receipts rr
  JOIN public.winnr_ingestion_endpoints re
    ON re.id=rr.endpoint_id AND re.organization_id=rr.organization_id AND re.provider_account_id=m.provider_account_id
  WHERE rr.organization_id=m.organization_id
    AND rr.payload->>'type'='message.relayed'
    AND rr.payload->'data'->>'original_message_id'=m.original_message_id
    AND rr.payload->'data'->>'provider_message_id'=m.provider_message_id
    AND lower(rr.payload->'data'->>'recipient')=lower(m.recipient)
  ORDER BY rr.created_at,rr.id LIMIT 1
 ) r ON true
 WHERE a.organization_id=p_org AND a.id=p_attempt;
$$;

-- Service-only operator RPC. list/status are pure reads; reconcile serializes
-- on the same per-organization email-dispatch transaction lock as dispatch and
-- takes the attempt row FOR UPDATE.
CREATE FUNCTION public.outreach_reconciliation_mutate(p_actor uuid,p_org uuid,p_action text,p_payload jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
 v_role text; v_now timestamptz; a public.email_dispatch_attempts; v_evidence record; v_msg record;
 v_total bigint; v_exact bigint; v_usable bigint; v_attempt uuid; v_expected text; v_thread uuid; v_next public.campaign_sequences%ROWTYPE;
 v_audit uuid; v_event jsonb; v_items jsonb; v_counts jsonb; v_recent jsonb; v_status text; v_evidence_status text; v_can boolean;
BEGIN
 IF p_org IS NULL OR p_action IS NULL THEN RAISE EXCEPTION 'reconciliation:invalid'; END IF;
 SELECT role INTO v_role FROM public.users WHERE id=p_actor AND organization_id=p_org FOR SHARE;
 IF v_role IS NULL OR v_role NOT IN('owner','admin') THEN RAISE EXCEPTION 'reconciliation:forbidden'; END IF;
 v_now:=clock_timestamp();

 IF p_action='list' THEN
  SELECT coalesce(jsonb_agg(x.item ORDER BY x.sort_at DESC),'[]') INTO v_items FROM (
   SELECT a0.created_at AS sort_at,jsonb_build_object(
     'attemptId',a0.id,'kind',a0.kind,'status',a0.status,
     'createdAt',to_char(a0.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
     'authorizedAt',CASE WHEN a0.authorized_at IS NULL THEN NULL ELSE to_char(a0.authorized_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
     'ageSeconds',greatest(0,floor(extract(epoch FROM (v_now-a0.created_at)))::bigint),
     'recipient',a0.message->>'to','sender',a0.message->>'from','campaignId',a0.campaign_id,
     'threadId',a0.thread_id,'sourceReplyId',a0.source_reply_id,'fingerprint',a0.fingerprint,
     'evidence',CASE WHEN c.total_count=0 THEN 'missing' WHEN c.total_count=1 AND c.exact_count=1 AND c.usable_count=1 THEN 'available' ELSE 'conflicting' END,
     'providerMessageId',c.provider_message_id
   ) AS item
   FROM public.email_dispatch_attempts a0
   CROSS JOIN LATERAL (
    SELECT count(*) AS total_count,
     count(*) FILTER (WHERE cand.account_id=a0.account_id AND lower(btrim(cand.recipient))=lower(btrim(a0.message->>'to')) AND cand.sender=lower(btrim(a0.message->>'from'))
       AND EXISTS(SELECT 1 FROM public.email_accounts ea WHERE ea.id=cand.account_id AND ea.organization_id=p_org AND lower(btrim(ea.email))=lower(btrim(a0.message->>'from')))) AS exact_count,
     count(*) FILTER (WHERE cand.account_id=a0.account_id AND lower(btrim(cand.recipient))=lower(btrim(a0.message->>'to')) AND cand.sender=lower(btrim(a0.message->>'from'))
       AND EXISTS(SELECT 1 FROM public.email_accounts ea WHERE ea.id=cand.account_id AND ea.organization_id=p_org AND lower(btrim(ea.email))=lower(btrim(a0.message->>'from')))
       AND cand.receipt_event_at IS NOT NULL AND cand.receipt_event_at<=v_now+interval '5 minutes' AND cand.receipt_event_at>=coalesce(a0.authorized_at,a0.created_at)-interval '5 minutes') AS usable_count,
     min(cand.provider_message_id) AS provider_message_id
    FROM public.outreach_reconciliation_candidates(p_org,a0.id) cand
   ) c
   WHERE a0.organization_id=p_org AND (a0.status='unknown' OR (a0.status='dispatching' AND a0.lease_expires_at<=v_now))
   ORDER BY a0.created_at DESC LIMIT 50
  ) x;
  SELECT jsonb_build_object('unconfirmed',count(*) FILTER (WHERE status='unknown' OR (status='dispatching' AND lease_expires_at<=v_now)),'accepted',count(*) FILTER (WHERE status='accepted')) INTO v_counts
   FROM public.email_dispatch_attempts WHERE organization_id=p_org;
  v_counts:=v_counts||(SELECT jsonb_build_object('held',count(*),'available',count(*) FILTER (WHERE total_count=1 AND exact_count=1 AND usable_count=1),'conflicting',count(*) FILTER (WHERE total_count>0 AND NOT(exact_count=1 AND total_count=1 AND usable_count=1)),'missing',count(*) FILTER (WHERE total_count=0)) FROM (
   SELECT c.total_count,c.exact_count,c.usable_count FROM public.email_dispatch_attempts a0 CROSS JOIN LATERAL (
    SELECT count(*) AS total_count,
     count(*) FILTER (WHERE cand.account_id=a0.account_id AND lower(btrim(cand.recipient))=lower(btrim(a0.message->>'to')) AND cand.sender=lower(btrim(a0.message->>'from'))
       AND EXISTS(SELECT 1 FROM public.email_accounts ea WHERE ea.id=cand.account_id AND ea.organization_id=p_org AND lower(btrim(ea.email))=lower(btrim(a0.message->>'from')))) AS exact_count,
     count(*) FILTER (WHERE cand.account_id=a0.account_id AND lower(btrim(cand.recipient))=lower(btrim(a0.message->>'to')) AND cand.sender=lower(btrim(a0.message->>'from'))
       AND EXISTS(SELECT 1 FROM public.email_accounts ea WHERE ea.id=cand.account_id AND ea.organization_id=p_org AND lower(btrim(ea.email))=lower(btrim(a0.message->>'from')))
       AND cand.receipt_event_at IS NOT NULL AND cand.receipt_event_at<=v_now+interval '5 minutes' AND cand.receipt_event_at>=coalesce(a0.authorized_at,a0.created_at)-interval '5 minutes') AS usable_count
    FROM public.outreach_reconciliation_candidates(p_org,a0.id) cand
   ) c
   WHERE a0.organization_id=p_org AND (a0.status='unknown' OR (a0.status='dispatching' AND a0.lease_expires_at<=v_now))
  ) h);
  SELECT coalesce(jsonb_agg(y.item ORDER BY y.at DESC),'[]') INTO v_recent FROM (
   SELECT au.reconciled_at AS at,jsonb_build_object('auditId',au.id,'attemptId',au.attempt_id,'kind',au.kind,
     'reconciledAt',to_char(au.reconciled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
     'reconciledBy',au.reconciled_by,'providerMessageId',au.provider_message_id,'recipient',au.recipient,
     'sourceReceiptId',au.source_receipt_id,'sourceReceiptFingerprint',au.source_receipt_fingerprint) AS item
   FROM public.outreach_reconciliation_audit au WHERE au.organization_id=p_org ORDER BY au.reconciled_at DESC LIMIT 20
  ) y;
  RETURN jsonb_build_object('items',v_items,'counts',v_counts,'recent',v_recent,'generatedAt',to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 END IF;

 IF p_action='status' THEN
  v_attempt:=(p_payload->>'attemptId')::uuid;
  SELECT * INTO a FROM public.email_dispatch_attempts WHERE id=v_attempt AND organization_id=p_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'reconciliation:not_found'; END IF;
  v_status:=CASE
   WHEN a.status='accepted' THEN 'accepted'
   WHEN a.authorized_at IS NULL THEN 'pre_effect_reservation'
   WHEN a.status='dispatching' AND a.lease_expires_at>v_now THEN 'handoff_active'
   WHEN a.status NOT IN('unknown','dispatching') THEN 'not_proof_of_send'
   ELSE NULL END;
  SELECT count(*),count(*) FILTER (WHERE cand.account_id=a.account_id AND lower(btrim(cand.recipient))=lower(btrim(a.message->>'to')) AND cand.sender=lower(btrim(a.message->>'from'))
    AND EXISTS(SELECT 1 FROM public.email_accounts ea WHERE ea.id=cand.account_id AND ea.organization_id=p_org AND lower(btrim(ea.email))=lower(btrim(a.message->>'from')))),
   count(*) FILTER (WHERE cand.account_id=a.account_id AND lower(btrim(cand.recipient))=lower(btrim(a.message->>'to')) AND cand.sender=lower(btrim(a.message->>'from'))
    AND EXISTS(SELECT 1 FROM public.email_accounts ea WHERE ea.id=cand.account_id AND ea.organization_id=p_org AND lower(btrim(ea.email))=lower(btrim(a.message->>'from')))
    AND cand.receipt_event_at IS NOT NULL AND cand.receipt_event_at<=v_now+interval '5 minutes' AND cand.receipt_event_at>=coalesce(a.authorized_at,a.created_at)-interval '5 minutes')
   INTO v_total,v_exact,v_usable FROM public.outreach_reconciliation_candidates(p_org,a.id) cand;
  v_evidence_status:=CASE WHEN v_total=0 THEN 'missing' WHEN v_total=1 AND v_exact=1 AND v_usable=1 THEN 'available' ELSE 'conflicting' END;
  v_can:=(v_status IS NULL AND v_evidence_status='available');
  RETURN jsonb_build_object('attemptId',a.id,'kind',a.kind,'status',a.status,'canReconcile',v_can,
   'reason',CASE WHEN v_status IS NOT NULL THEN v_status WHEN v_evidence_status='available' THEN NULL ELSE 'evidence_'||v_evidence_status END,
   'evidence',v_evidence_status,
   'ageSeconds',greatest(0,floor(extract(epoch FROM (v_now-a.created_at)))::bigint),'recipient',a.message->>'to','sender',a.message->>'from',
   'campaignId',a.campaign_id,'threadId',a.thread_id,'canonicalThreadId',CASE WHEN a.kind='reply' THEN public.outreach_canonical_reply_thread(p_org,a.thread_id) ELSE NULL END,
   'sourceReplyId',a.source_reply_id,'fingerprint',a.fingerprint,
   'auditId',(SELECT id FROM public.outreach_reconciliation_audit WHERE attempt_id=a.id));
 END IF;

 IF p_action='reconcile' THEN
  v_attempt:=(p_payload->>'attemptId')::uuid;
  IF v_attempt IS NULL THEN RAISE EXCEPTION 'reconciliation:invalid'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('email-dispatch:'||p_org::text,0));
  v_now:=clock_timestamp();
  SELECT * INTO a FROM public.email_dispatch_attempts WHERE id=v_attempt AND organization_id=p_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reconciliation:not_found'; END IF;
  -- Deterministic double submission returns the current status without any effect.
  IF a.status='accepted' THEN
   RETURN jsonb_build_object('status','accepted','alreadyAccepted',true,'attemptId',a.id,'kind',a.kind,'evidence','available','auditId',(SELECT id FROM public.outreach_reconciliation_audit WHERE attempt_id=a.id));
  END IF;
  v_expected:=p_payload->>'fingerprint';
  IF v_expected IS NOT NULL AND (v_expected!~'^[a-f0-9]{64}$' OR v_expected<>a.fingerprint) THEN
   RETURN jsonb_build_object('status','held','reason','fingerprint_mismatch','attemptId',a.id,'kind',a.kind,'previousStatus',a.status);
  END IF;
  IF a.authorized_at IS NULL THEN
   RETURN jsonb_build_object('status','held','reason','pre_effect_reservation','attemptId',a.id,'kind',a.kind,'previousStatus',a.status,'evidence','missing');
  END IF;
  IF NOT (a.status='unknown' OR (a.status='dispatching' AND a.lease_expires_at<=v_now)) THEN
   RETURN jsonb_build_object('status','held','reason',CASE WHEN a.status='dispatching' THEN 'handoff_active' WHEN a.status='reserved' THEN 'pre_effect_reservation' ELSE 'not_proof_of_send' END,'attemptId',a.id,'kind',a.kind,'previousStatus',a.status);
  END IF;
  SELECT count(*),count(*) FILTER (WHERE cand.account_id=a.account_id AND lower(btrim(cand.recipient))=lower(btrim(a.message->>'to')) AND cand.sender=lower(btrim(a.message->>'from'))
    AND EXISTS(SELECT 1 FROM public.email_accounts ea WHERE ea.id=cand.account_id AND ea.organization_id=p_org AND lower(btrim(ea.email))=lower(btrim(a.message->>'from'))))
   INTO v_total,v_exact FROM public.outreach_reconciliation_candidates(p_org,a.id) cand;
  IF v_total=0 THEN RETURN jsonb_build_object('status','held','reason','evidence_missing','attemptId',a.id,'kind',a.kind,'previousStatus',a.status,'evidence','missing'); END IF;
  IF v_exact<>1 OR v_total<>1 THEN RETURN jsonb_build_object('status','held','reason','evidence_conflicting','attemptId',a.id,'kind',a.kind,'previousStatus',a.status,'evidence','conflicting'); END IF;
  SELECT cand.* INTO v_evidence FROM public.outreach_reconciliation_candidates(p_org,a.id) cand
   WHERE cand.account_id=a.account_id AND lower(btrim(cand.recipient))=lower(btrim(a.message->>'to')) AND cand.sender=lower(btrim(a.message->>'from'))
     AND EXISTS(SELECT 1 FROM public.email_accounts ea WHERE ea.id=cand.account_id AND ea.organization_id=p_org AND lower(btrim(ea.email))=lower(btrim(a.message->>'from')))
   LIMIT 1;
  -- Provider event time must be attributable and sane: the authenticated relay
  -- instant (`data.relayed_at`, or envelope `created` only while the relay
  -- timestamp is absent) must be a strict ISO instant, not in the future beyond
  -- clock skew, and not before this attempt was authorized. A malformed/absent
  -- provider time stays held and is never silently replaced by the local
  -- arrival; receipt.created_at is stored separately as arrival evidence only.
  IF v_evidence.receipt_event_at IS NULL
   OR v_evidence.receipt_event_at>v_now+interval '5 minutes'
   OR v_evidence.receipt_event_at<coalesce(a.authorized_at,a.created_at)-interval '5 minutes' THEN
   RETURN jsonb_build_object('status','held','reason','evidence_timestamp','attemptId',a.id,'kind',a.kind,'previousStatus',a.status,'evidence','conflicting');
  END IF;
  IF a.kind='reply' THEN
   v_thread:=public.outreach_canonical_reply_thread(p_org,a.thread_id);
   IF v_thread IS NULL OR NOT EXISTS(SELECT 1 FROM public.threads WHERE id=v_thread AND organization_id=p_org AND mailbox_id=a.account_id AND lower(btrim(participant_email))=a.message->>'to') THEN
    RETURN jsonb_build_object('status','held','reason','canonical_thread_unavailable','attemptId',a.id,'kind',a.kind,'previousStatus',a.status,'evidence','available');
   END IF;
  END IF;
  UPDATE public.email_dispatch_attempts SET status='accepted',settled_at=v_now,
   receipt=jsonb_build_object('messageId',a.message->>'messageId','recipient',a.message->>'to','providerMessageId',v_evidence.provider_message_id,'sourceReceiptId',v_evidence.receipt_id,'reconciled',true)
   WHERE id=a.id;
  IF a.kind='campaign' THEN
   INSERT INTO public.sent_emails(id,organization_id,campaign_id,campaign_lead_id,lead_id,email_account_id,from_email,to_email,subject,body_text,body_html,message_id,status,sent_at)
   VALUES(a.id,p_org,a.campaign_id,a.enrollment_id,a.lead_id,a.account_id,a.message->>'from',a.message->>'to',a.message->>'subject',a.message->>'text',a.message->>'html',a.message->>'messageId','sent',v_now);
   SELECT * INTO v_next FROM public.campaign_sequences WHERE campaign_id=a.campaign_id AND step_number>a.step_number ORDER BY step_number LIMIT 1;
   -- Preserve replied/unsubscribed/bounced/completed state; never resume the campaign.
   UPDATE public.campaign_leads SET current_step=a.step_number,last_sent_at=v_now,
    status=CASE WHEN status IN('pending','in_progress') THEN CASE WHEN v_next.id IS NULL THEN 'completed' ELSE 'in_progress' END ELSE status END,
    next_send_at=CASE WHEN v_next.id IS NOT NULL AND status IN('pending','in_progress') THEN v_now+make_interval(days=>coalesce(v_next.delay_days,0),hours=>coalesce(v_next.delay_hours,0)) ELSE NULL END
    WHERE id=a.enrollment_id AND campaign_id=a.campaign_id;
  ELSE
   INSERT INTO public.sent_emails(id,organization_id,campaign_id,email_account_id,lead_id,to_email,from_email,subject,body_text,body_html,message_id,status,sent_at)
   VALUES(a.id,p_org,a.campaign_id,a.account_id,a.lead_id,a.message->>'to',a.message->>'from',a.message->>'subject',a.message->>'text',a.message->>'html',a.message->>'messageId','sent',v_now);
   INSERT INTO public.thread_messages(id,thread_id,message_id,in_reply_to,direction,from_email,to_email,subject,body_text,body_html,sent_at)
   VALUES(a.id,v_thread,a.message->>'messageId',a.message->>'inReplyTo','outbound',a.message->>'from',a.message->>'to',a.message->>'subject',a.message->>'text',a.message->>'html',v_now);
   UPDATE public.threads SET last_message_at=greatest(last_message_at,v_now),message_count=(SELECT count(*) FROM public.thread_messages WHERE thread_id=v_thread)+(SELECT count(*) FROM public.replies WHERE thread_id=v_thread),updated_at=v_now
    WHERE id=v_thread AND organization_id=p_org;
  END IF;
  -- Audit row and 021 canonical event commit in the same transaction. The audit
  -- id is fixed before the event so causation is exact and the event id FK is set.
  v_audit:=gen_random_uuid();
  v_event:=jsonb_build_object('version',1,'organizationId',p_org,'type','outreach.dispatch.reconciled','source','outreach.reconciliation','sourceEventId',a.id::text,
   'occurredAt',to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'correlationId',coalesce(a.thread_id::text,a.campaign_id::text),'causationId',v_audit::text,
   'subject',jsonb_strip_nulls(jsonb_build_object('leadId',a.lead_id,'campaignId',a.campaign_id)),
   'data',jsonb_build_object('attemptId',a.id,'auditId',v_audit,'kind',a.kind,'sourceReceiptId',v_evidence.receipt_id,'providerMessageId',v_evidence.provider_message_id,'reconciledBy',p_actor));
  v_event:=public.outreach_append_event(p_org,v_event,ARRAY[]::text[],encode(sha256(convert_to(a.id::text||':'||v_evidence.receipt_id::text,'UTF8')),'hex'));
  IF v_event->>'result'<>'created' OR (v_event->>'event_id') IS NULL THEN RAISE EXCEPTION 'reconciliation:event_rejected'; END IF;
  INSERT INTO public.outreach_reconciliation_audit(id,organization_id,attempt_id,kind,status_before,fingerprint,message_id,provider_message_id,recipient,sender,account_id,connection_id,connection_version,provider_account_id,source_receipt_id,source_receipt_fingerprint,source_receipt_at,source_receipt_arrival_at,event_id,reconciled_by,reconciled_at)
  VALUES(v_audit,p_org,a.id,a.kind,a.status,a.fingerprint,a.message->>'messageId',v_evidence.provider_message_id,a.message->>'to',a.message->>'from',a.account_id,a.connection_id,a.connection_version,v_evidence.provider_account_id,v_evidence.receipt_id,v_evidence.receipt_fingerprint,v_evidence.receipt_event_at,v_evidence.receipt_arrival_at,(v_event->>'event_id')::uuid,p_actor,v_now);
  -- A received message that arrived before this acceptance is re-correlated by the
  -- same exact identity join (never subject matching).
  FOR v_msg IN SELECT id FROM public.winnr_ingested_messages WHERE organization_id=p_org AND account_id=a.account_id AND in_reply_to IS NOT NULL AND (in_reply_to=a.message->>'messageId' OR in_reply_to=v_evidence.provider_message_id) LOOP
   PERFORM public.winnr_correlate_ingested(p_org,v_msg.id);
  END LOOP;
  RETURN jsonb_build_object('status','accepted','alreadyAccepted',false,'attemptId',a.id,'kind',a.kind,'evidence','available','auditId',v_audit,'eventId',(v_event->>'event_id')::uuid,'sourceReceiptId',v_evidence.receipt_id,'providerMessageId',v_evidence.provider_message_id,'recipient',a.message->>'to');
 END IF;
 RAISE EXCEPTION 'reconciliation:invalid';
END $$;

REVOKE ALL ON FUNCTION public.outreach_reconciliation_mutate(uuid,uuid,text,jsonb),public.outreach_reconciliation_candidates(uuid,uuid),public.outreach_reconciliation_event_time(jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.outreach_reconciliation_mutate(uuid,uuid,text,jsonb) TO service_role;
COMMIT;
