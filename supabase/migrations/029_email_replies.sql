BEGIN;
-- Historical effects share one ledger and one SMTP authorization RPC.
ALTER TABLE public.email_dispatch_attempts ADD COLUMN kind text NOT NULL DEFAULT 'campaign' CHECK(kind IN('campaign','reply')),
 ADD COLUMN thread_id uuid REFERENCES public.threads(id), ADD COLUMN source_reply_id uuid REFERENCES public.replies(id),
 ADD COLUMN control_revision bigint, ADD COLUMN reply_source text CHECK(reply_source IN('human','agent','closebot')), ADD COLUMN policy_decision_id uuid;
ALTER TABLE public.email_dispatch_attempts ALTER COLUMN enrollment_id DROP NOT NULL, ALTER COLUMN step_number DROP NOT NULL;
ALTER TABLE public.email_dispatch_attempts ADD CONSTRAINT reply_context_required CHECK(kind='campaign' OR (thread_id IS NOT NULL AND source_reply_id IS NOT NULL AND control_revision IS NOT NULL AND reply_source IS NOT NULL));
CREATE UNIQUE INDEX email_reply_logical_effect ON public.email_dispatch_attempts(thread_id,source_reply_id) WHERE kind='reply' AND status<>'cancelled';
CREATE UNIQUE INDEX email_reply_source_effect ON public.email_dispatch_attempts(organization_id,source_reply_id) WHERE kind='reply' AND status<>'cancelled';
CREATE TABLE public.outreach_conversation_controls (
 organization_id uuid NOT NULL REFERENCES public.organizations(id),thread_id uuid NOT NULL REFERENCES public.threads(id) ON DELETE CASCADE,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),mode text NOT NULL DEFAULT 'assist' CHECK(mode IN('human','assist','autonomous')),
 merged_into_thread_id uuid REFERENCES public.threads(id),updated_at timestamptz NOT NULL DEFAULT now(),updated_by uuid NOT NULL,PRIMARY KEY(organization_id,thread_id)
);
ALTER TABLE public.outreach_conversation_controls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.outreach_conversation_controls FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.outreach_conversation_controls TO service_role;
-- Keep referenced audit threads when the ingestion correlator retires an empty temporary thread.
CREATE FUNCTION public.outreach_preserve_audit_thread() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.email_dispatch_attempts WHERE thread_id=OLD.id) OR EXISTS(SELECT 1 FROM public.outreach_conversation_controls WHERE thread_id=OLD.id AND mode='human' AND merged_into_thread_id IS NULL) THEN RETURN NULL; END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER outreach_preserve_audit_thread BEFORE DELETE ON public.threads FOR EACH ROW EXECUTE FUNCTION public.outreach_preserve_audit_thread();
REVOKE ALL ON FUNCTION public.outreach_preserve_audit_thread() FROM PUBLIC,anon,authenticated,service_role;
-- Resolve canonical visibility without changing the immutable attempt/thread binding.
CREATE FUNCTION public.outreach_canonical_reply_thread(p_org uuid,p_thread uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE current_thread uuid:=p_thread; target uuid; hops int:=0;
BEGIN
 LOOP
  SELECT c.merged_into_thread_id INTO target FROM public.threads t LEFT JOIN public.outreach_conversation_controls c ON c.organization_id=t.organization_id AND c.thread_id=t.id WHERE t.organization_id=p_org AND t.id=current_thread;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF target IS NULL THEN RETURN current_thread; END IF;
  hops:=hops+1; IF hops>32 THEN RETURN NULL; END IF;
  current_thread:=target;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.outreach_canonical_reply_thread(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.outreach_merge_reply_controls(p_org uuid,p_old uuid,p_new uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE human_control public.outreach_conversation_controls;
BEGIN
 IF p_old IS NOT DISTINCT FROM p_new THEN RETURN; END IF;
 SELECT * INTO human_control FROM public.outreach_conversation_controls WHERE organization_id=p_org AND thread_id IN(p_old,p_new) AND mode='human' ORDER BY revision DESC LIMIT 1;
 IF FOUND THEN
  INSERT INTO public.outreach_conversation_controls(organization_id,thread_id,revision,mode,updated_by) VALUES(p_org,p_new,human_control.revision+1,'human',human_control.updated_by)
  ON CONFLICT(organization_id,thread_id) DO UPDATE SET mode='human',revision=outreach_conversation_controls.revision+1,updated_at=now(),updated_by=EXCLUDED.updated_by;
 END IF;
 -- Cancellation proves there was no SMTP authorization. Dispatching/unknown history stays immutable.
 UPDATE public.email_dispatch_attempts SET status='cancelled',error_code='thread_merged',settled_at=now() WHERE organization_id=p_org AND thread_id IN(p_old,p_new) AND kind='reply' AND status='reserved' AND authorized_at IS NULL;
 UPDATE public.outreach_conversation_controls SET merged_into_thread_id=p_new,revision=revision+1,updated_at=now() WHERE organization_id=p_org AND thread_id=p_old;
 UPDATE public.thread_messages SET thread_id=p_new WHERE thread_id=p_old;
 UPDATE public.threads SET message_count=(SELECT count(*) FROM public.thread_messages WHERE thread_id=p_new)+(SELECT count(*) FROM public.replies WHERE thread_id=p_new),last_message_at=greatest(last_message_at,(SELECT last_message_at FROM public.threads WHERE id=p_old AND organization_id=p_org)),updated_at=now() WHERE organization_id=p_org AND id=p_new;
 UPDATE public.threads SET status='archived',message_count=(SELECT count(*) FROM public.thread_messages WHERE thread_id=p_old),updated_at=now() WHERE organization_id=p_org AND id=p_old;
 DELETE FROM public.threads WHERE id=p_old AND organization_id=p_org AND NOT EXISTS(SELECT 1 FROM public.email_dispatch_attempts WHERE thread_id=p_old) AND NOT EXISTS(SELECT 1 FROM public.replies WHERE thread_id=p_old) AND NOT EXISTS(SELECT 1 FROM public.thread_messages WHERE thread_id=p_old);
END $$;
REVOKE ALL ON FUNCTION public.outreach_merge_reply_controls(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.outreach_reply_policy_allows(p_org uuid,p_thread uuid,p_source_reply uuid,p_revision bigint,p_decision uuid,p_fingerprint text,p_now timestamptz) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE allowed boolean;
BEGIN
 IF p_decision IS NULL OR to_regprocedure('public.outreach_reply_decision_is_authorized(uuid,uuid,uuid,bigint,uuid,text,timestamp with time zone)') IS NULL THEN RETURN false; END IF;
 EXECUTE 'SELECT public.outreach_reply_decision_is_authorized($1,$2,$3,$4,$5,$6,$7)' INTO allowed USING p_org,p_thread,p_source_reply,p_revision,p_decision,p_fingerprint,p_now;
 RETURN coalesce(allowed,false);
END $$;
CREATE FUNCTION public.outreach_reply_mutate(p_actor uuid,p_org uuid,p_action text,p_payload jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t public.threads; r public.replies; l public.leads; cfg public.email_dispatch_config; ctl public.outreach_conversation_controls; a public.email_dispatch_attempts; cred public.winnr_mailbox_credentials; now_at timestamptz; cid uuid; tid uuid; cap int; recipient text; source text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('email-dispatch:'||p_org::text,0));
 PERFORM 1 FROM public.users WHERE id=p_actor AND organization_id=p_org AND role IN('owner','admin') FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'reply:forbidden'; END IF;
 now_at:=clock_timestamp();
 UPDATE public.email_dispatch_attempts SET status='unknown',error_code='lease_expired',settled_at=now_at WHERE organization_id=p_org AND kind='reply' AND status='dispatching' AND lease_expires_at<=now_at;
 UPDATE public.email_dispatch_attempts SET status='cancelled',error_code='preflight_lease_expired',settled_at=now_at WHERE organization_id=p_org AND kind='reply' AND status='reserved' AND lease_expires_at<=now_at;
 IF p_action IN('authorize','settle') THEN
  SELECT * INTO a FROM public.email_dispatch_attempts WHERE claim_token=(p_payload->>'claimToken')::uuid AND organization_id=p_org AND kind='reply' FOR UPDATE;
  IF NOT FOUND OR a.actor_id<>p_actor THEN RETURN jsonb_build_object('allowed',false,'reason','claim_not_found'); END IF;
  tid:=a.thread_id;
 ELSE tid:=(p_payload->>'threadId')::uuid; END IF;
 SELECT * INTO t FROM public.threads WHERE id=tid AND organization_id=p_org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'reply:not_found'; END IF;
 INSERT INTO public.outreach_conversation_controls(organization_id,thread_id,updated_by) VALUES(p_org,tid,p_actor) ON CONFLICT DO NOTHING;
 SELECT * INTO ctl FROM public.outreach_conversation_controls WHERE organization_id=p_org AND thread_id=tid FOR UPDATE;
 IF ctl.merged_into_thread_id IS NOT NULL AND p_action<>'settle' THEN RETURN jsonb_build_object('allowed',false,'ready',false,'reason','thread_merged','canonicalThreadId',ctl.merged_into_thread_id); END IF;
 IF p_action='control' THEN
  IF ctl.revision IS DISTINCT FROM (p_payload->>'expectedRevision')::bigint THEN RETURN jsonb_build_object('allowed',false,'reason','stale_control'); END IF;
  IF p_payload->>'mode' NOT IN('human','assist','autonomous') OR p_payload->>'mode' IS NULL THEN RAISE EXCEPTION 'reply:invalid_mode'; END IF;
  IF p_payload->>'mode'='autonomous' AND to_regprocedure('public.outreach_reply_decision_is_authorized(uuid,uuid,uuid,bigint,uuid,text,timestamp with time zone)') IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','automation_not_configured'); END IF;
  UPDATE public.outreach_conversation_controls SET mode=p_payload->>'mode',revision=revision+1,updated_at=now_at,updated_by=p_actor WHERE organization_id=p_org AND thread_id=tid RETURNING * INTO ctl;
  UPDATE public.email_dispatch_attempts SET status='cancelled',settled_at=now_at,error_code='control_changed' WHERE organization_id=p_org AND thread_id=tid AND kind='reply' AND status='reserved' AND authorized_at IS NULL;
  RETURN jsonb_build_object('allowed',true,'control',to_jsonb(ctl));
 END IF;
 -- A durable accepted receipt survives later control, suppression and configuration changes.
 IF p_action='settle' THEN
  IF a.status='reserved' AND p_payload->>'outcome' IN('rejected','unknown') THEN
   UPDATE public.email_dispatch_attempts SET status=CASE WHEN p_payload->>'outcome'='rejected' THEN 'cancelled' ELSE 'unknown' END,settled_at=now_at,error_code=left(p_payload->>'code',100) WHERE id=a.id;
   RETURN jsonb_build_object('settled',true,'status',CASE WHEN p_payload->>'outcome'='rejected' THEN 'cancelled' ELSE 'unknown' END);
  END IF;
  IF a.status<>'dispatching' OR a.lease_expires_at<=now_at THEN RETURN jsonb_build_object('settled',false,'status',a.status); END IF;
  IF p_payload->>'outcome'='accepted' AND p_payload->>'recipient'=a.message->>'to' AND p_payload->>'messageId'=a.message->>'messageId' THEN
   tid:=public.outreach_canonical_reply_thread(p_org,tid);
   PERFORM 1 FROM public.threads WHERE id=tid AND organization_id=p_org AND mailbox_id=a.account_id AND lower(btrim(participant_email))=a.message->>'to' FOR UPDATE;
   IF NOT FOUND THEN RETURN jsonb_build_object('settled',false,'status',a.status); END IF;
   INSERT INTO public.sent_emails(id,organization_id,campaign_id,email_account_id,lead_id,to_email,from_email,subject,body_text,body_html,message_id,status,sent_at) VALUES(a.id,p_org,a.campaign_id,a.account_id,a.lead_id,a.message->>'to',a.message->>'from',a.message->>'subject',a.message->>'text',a.message->>'html',a.message->>'messageId','sent',now_at);
   INSERT INTO public.thread_messages(id,thread_id,message_id,in_reply_to,direction,from_email,to_email,subject,body_text,body_html,sent_at) VALUES(a.id,tid,a.message->>'messageId',a.message->>'inReplyTo','outbound',a.message->>'from',a.message->>'to',a.message->>'subject',a.message->>'text',a.message->>'html',now_at);
   UPDATE public.email_dispatch_attempts SET status='accepted',settled_at=now_at,receipt=p_payload WHERE id=a.id;
   UPDATE public.threads SET last_message_at=greatest(last_message_at,now_at),message_count=(SELECT count(*) FROM public.thread_messages WHERE thread_id=tid)+(SELECT count(*) FROM public.replies WHERE thread_id=tid),updated_at=now_at WHERE id=tid;
   RETURN jsonb_build_object('settled',true,'status','accepted');
  END IF;
  UPDATE public.email_dispatch_attempts SET status=CASE WHEN p_payload->>'outcome'='rejected' THEN 'rejected' ELSE 'unknown' END,settled_at=now_at,error_code=left(coalesce(p_payload->>'code','receipt_mismatch'),100) WHERE id=a.id;
  RETURN jsonb_build_object('settled',true,'status',CASE WHEN p_payload->>'outcome'='rejected' THEN 'rejected' ELSE 'unknown' END);
 END IF;
 SELECT * INTO r FROM public.replies WHERE organization_id=p_org AND thread_id=tid ORDER BY received_at DESC NULLS LAST,created_at DESC NULLS LAST,id DESC LIMIT 1 FOR UPDATE;
 IF NOT FOUND OR r.message_id IS NULL OR r.body_text IS NULL AND r.body_html IS NULL THEN RETURN jsonb_build_object('ready',false,'allowed',false,'reason','inbound_body_required','control',to_jsonb(ctl)); END IF;
 recipient:=lower(btrim(r.from_email));
 SELECT * INTO l FROM public.leads WHERE organization_id=p_org AND id=coalesce(t.lead_id,r.lead_id) AND lower(btrim(email))=recipient FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('ready',false,'allowed',false,'reason','canonical_lead_required','control',to_jsonb(ctl)); END IF;
 cid:=CASE WHEN p_action='authorize' THEN a.campaign_id ELSE coalesce(t.campaign_id,(p_payload->>'senderProfileId')::uuid) END;
 SELECT * INTO cfg FROM public.email_dispatch_config WHERE organization_id=p_org AND campaign_id=cid;
 IF NOT FOUND THEN RETURN jsonb_build_object('ready',false,'allowed',false,'reason','approved_sender_identity_required','control',to_jsonb(ctl)); END IF;
 SELECT * INTO cred FROM public.winnr_mailbox_credentials WHERE organization_id=p_org AND connection_id=cfg.connection_id AND connection_version=cfg.connection_version AND provider_mailbox_id=cfg.mailbox_id AND account_id=t.mailbox_id AND email=cfg.sender_email;
 IF NOT FOUND OR cfg.killed OR NOT EXISTS(SELECT 1 FROM public.email_accounts WHERE id=cred.account_id AND organization_id=p_org AND lower(btrim(email))=cfg.sender_email) OR lower(btrim(r.to_email))<>cfg.sender_email OR NOT EXISTS(SELECT 1 FROM public.winnr_connections WHERE id=cfg.connection_id AND organization_id=p_org AND version=cfg.connection_version) OR NOT public.winnr_ingestion_is_ready(p_org,cfg.connection_id,cfg.connection_version) THEN RETURN jsonb_build_object('ready',false,'allowed',false,'reason','current_mailbox_ingestion_required','control',to_jsonb(ctl)); END IF;
 IF t.status='archived' OR l.status IN('unsubscribed','bounced','complained') OR EXISTS(SELECT 1 FROM public.outreach_suppressions WHERE organization_id=p_org AND normalized_email=recipient AND (expires_at IS NULL OR expires_at>now_at)) THEN RETURN jsonb_build_object('ready',false,'allowed',false,'reason','suppressed_or_archived','control',to_jsonb(ctl)); END IF;
 IF p_action='readiness' THEN
  IF EXISTS(SELECT 1 FROM public.email_dispatch_attempts WHERE organization_id=p_org AND kind='reply' AND source_reply_id=r.id AND status<>'cancelled') THEN RETURN jsonb_build_object('ready',false,'allowed',false,'reason','response_already_reserved','control',to_jsonb(ctl)); END IF;
  RETURN jsonb_build_object('ready',ctl.mode='human','reason',CASE WHEN ctl.mode<>'human' THEN 'human_takeover_required' ELSE NULL END,'threadId',tid,'sourceReplyId',r.id,'controlRevision',ctl.revision,'control',to_jsonb(ctl),'recipient',recipient,'leadId',l.id,'subject',coalesce(r.subject,t.subject),'inReplyTo',r.message_id,'configuration',to_jsonb(cfg),'mailbox',jsonb_build_object('connectionId',cfg.connection_id,'connectionVersion',cfg.connection_version,'providerMailboxId',cfg.mailbox_id,'email',cfg.sender_email));
 END IF;
 IF p_action='reserve' THEN
  source:=p_payload->>'source';
  IF (p_payload->>'sourceReplyId')::uuid IS DISTINCT FROM r.id OR (p_payload->>'controlRevision')::bigint IS DISTINCT FROM ctl.revision OR p_payload->'configuration' IS DISTINCT FROM to_jsonb(cfg) OR p_payload->'message'->>'to' IS DISTINCT FROM recipient OR p_payload->'message'->>'from' IS DISTINCT FROM cfg.sender_email OR p_payload->'message'->>'inReplyTo' IS DISTINCT FROM r.message_id THEN RETURN jsonb_build_object('allowed',false,'reason','stale_reply_context'); END IF;
  IF source='human' THEN IF ctl.mode<>'human' THEN RETURN jsonb_build_object('allowed',false,'reason','human_takeover_required'); END IF;
  ELSIF source IN('agent','closebot') THEN IF ctl.mode<>'autonomous' OR NOT public.outreach_reply_policy_allows(p_org,tid,r.id,ctl.revision,(p_payload->>'decisionId')::uuid,p_payload->>'fingerprint',now_at) THEN RETURN jsonb_build_object('allowed',false,'reason','automation_not_authorized'); END IF;
  ELSE RAISE EXCEPTION 'reply:invalid_source'; END IF;
  IF EXISTS(SELECT 1 FROM public.email_dispatch_attempts WHERE organization_id=p_org AND message->>'to'=recipient AND status IN('dispatching','unknown')) THEN RETURN jsonb_build_object('allowed',false,'reason','recipient_outcome_held'); END IF;
  INSERT INTO public.email_dispatch_attempts(organization_id,actor_id,campaign_id,lead_id,step_number,revision,sequence_snapshot,settings_snapshot,connection_id,connection_version,mailbox_id,account_id,message,fingerprint,status,lease_expires_at,kind,thread_id,source_reply_id,control_revision,reply_source,policy_decision_id)
  VALUES(p_org,p_actor,cid,l.id,NULL,now_at,'{}',to_jsonb(cfg),cfg.connection_id,cfg.connection_version,cfg.mailbox_id,cred.account_id,p_payload->'message',p_payload->>'fingerprint','reserved',now_at+interval '2 minutes','reply',tid,r.id,ctl.revision,source,(p_payload->>'decisionId')::uuid) ON CONFLICT DO NOTHING RETURNING * INTO a;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','response_already_reserved'); END IF;
  RETURN jsonb_build_object('allowed',true,'attempt',to_jsonb(a));
 END IF;
 IF p_action<>'authorize' OR a.status<>'reserved' OR a.lease_expires_at<=now_at OR a.fingerprint IS DISTINCT FROM p_payload->>'fingerprint' OR a.connection_id::text IS DISTINCT FROM p_payload->>'connectionId' OR a.connection_version IS DISTINCT FROM (p_payload->>'connectionVersion')::int OR a.mailbox_id IS DISTINCT FROM p_payload->>'mailboxId' OR a.source_reply_id IS DISTINCT FROM r.id OR a.control_revision IS DISTINCT FROM ctl.revision OR a.message->>'to' IS DISTINCT FROM recipient OR a.message->>'from' IS DISTINCT FROM cfg.sender_email OR a.message->>'inReplyTo' IS DISTINCT FROM r.message_id OR a.account_id IS DISTINCT FROM cred.account_id OR a.settings_snapshot IS DISTINCT FROM to_jsonb(cfg) THEN RETURN jsonb_build_object('allowed',false,'reason','stale_reply_claim'); END IF;
 IF a.reply_source='human' AND ctl.mode<>'human' OR a.reply_source<>'human' AND (ctl.mode<>'autonomous' OR NOT public.outreach_reply_policy_allows(p_org,tid,r.id,ctl.revision,a.policy_decision_id,a.fingerprint,now_at)) THEN RETURN jsonb_build_object('allowed',false,'reason','control_or_policy_changed'); END IF;
 IF EXISTS(SELECT 1 FROM public.email_dispatch_attempts WHERE organization_id=p_org AND message->>'to'=recipient AND status IN('dispatching','unknown') AND id<>a.id) THEN RETURN jsonb_build_object('allowed',false,'reason','recipient_outcome_held'); END IF;
 SELECT min(mailbox_daily_limit) INTO cap FROM public.email_dispatch_config WHERE organization_id=p_org AND lower(btrim(sender_email))=cfg.sender_email;
 IF (SELECT count(*) FROM public.email_dispatch_attempts WHERE organization_id=p_org AND (account_id=cred.account_id OR lower(btrim(message->>'from'))=cfg.sender_email) AND authorized_at>=date_trunc('day',now_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND status IN('dispatching','accepted','unknown','rejected'))>=cap THEN RETURN jsonb_build_object('allowed',false,'reason','daily_cap'); END IF;
 UPDATE public.email_dispatch_attempts SET status='dispatching',authorized_at=now_at,lease_expires_at=now_at+interval '2 minutes' WHERE id=a.id;
 RETURN jsonb_build_object('allowed',true,'grant',jsonb_build_object('organizationId',p_org,'connectionId',cfg.connection_id,'connectionVersion',cfg.connection_version,'mailboxId',cfg.mailbox_id,'claimToken',a.claim_token,'fingerprint',a.fingerprint,'attemptId',a.id));
END $$;
-- Original campaign semantics remain private; all callers traverse current ingestion readiness.
ALTER FUNCTION public.email_dispatch_mutate(uuid,uuid,text,jsonb) RENAME TO email_dispatch_mutate_024;
REVOKE ALL ON FUNCTION public.email_dispatch_mutate_024(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.email_dispatch_mutate(p_actor uuid,p_org uuid,p_action text,p_payload jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.email_dispatch_attempts;cfg public.email_dispatch_config;cid uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('email-dispatch:'||p_org::text,0));
 PERFORM 1 FROM public.users WHERE id=p_actor AND organization_id=p_org AND role IN('owner','admin') FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'email_dispatch:forbidden'; END IF;
 IF p_action IN('authorize','settle') THEN
  SELECT * INTO a FROM public.email_dispatch_attempts WHERE claim_token=(p_payload->>'claimToken')::uuid AND organization_id=p_org;
  IF a.kind='reply' THEN RETURN public.outreach_reply_mutate(p_actor,p_org,p_action,p_payload); END IF;
  cid:=a.campaign_id;
 ELSE cid:=(p_payload->>'campaignId')::uuid; END IF;
 IF p_action IN('start','resume','readiness','candidates','reserve','authorize','retry') THEN
  SELECT * INTO cfg FROM public.email_dispatch_config WHERE campaign_id=cid AND organization_id=p_org;
  IF cfg.campaign_id IS NOT NULL AND NOT public.winnr_ingestion_is_ready(p_org,cfg.connection_id,cfg.connection_version) THEN RETURN jsonb_build_object('ready',false,'allowed',false,'reason','ingestion_not_configured','configuration',to_jsonb(cfg)); END IF;
  IF p_action='retry' AND EXISTS(SELECT 1 FROM public.email_dispatch_attempts WHERE id=(p_payload->>'attemptId')::uuid AND organization_id=p_org AND kind='reply') THEN RETURN jsonb_build_object('allowed',false,'reason','reply_retry_not_allowed'); END IF;
 END IF;
 RETURN public.email_dispatch_mutate_024(p_actor,p_org,p_action,p_payload);
END $$;
REVOKE ALL ON FUNCTION public.outreach_reply_mutate(uuid,uuid,text,jsonb),public.outreach_reply_policy_allows(uuid,uuid,uuid,bigint,uuid,text,timestamptz),public.email_dispatch_mutate(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.outreach_reply_mutate(uuid,uuid,text,jsonb),public.email_dispatch_mutate(uuid,uuid,text,jsonb) TO service_role;
-- Replies to a manual send stay in the existing controlled conversation.
ALTER FUNCTION public.winnr_correlate_ingested(uuid,uuid) RENAME TO winnr_correlate_ingested_027;
REVOKE ALL ON FUNCTION public.winnr_correlate_ingested_027(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
-- The shared fallback is campaign-only and requires the exact historical connection/version snapshot.
CREATE OR REPLACE FUNCTION public.winnr_correlate_ingested_027(p_org uuid,p_message uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE m public.winnr_ingested_messages; a public.email_dispatch_attempts; t uuid; old_thread uuid; count_matches integer; original text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('email-dispatch:'||p_org::text,0));
 SELECT * INTO m FROM public.winnr_ingested_messages WHERE id=p_message AND organization_id=p_org FOR UPDATE;
 IF NOT FOUND OR m.in_reply_to IS NULL THEN RETURN false; END IF;
 SELECT original_message_id INTO original FROM public.winnr_message_id_maps WHERE organization_id=p_org AND provider_account_id=m.provider_account_id AND account_id=m.account_id AND provider_message_id=m.in_reply_to AND recipient=m.from_email;
 original:=coalesce(original,m.in_reply_to);
 SELECT count(*) INTO count_matches FROM public.email_dispatch_attempts WHERE organization_id=p_org AND kind='campaign' AND account_id=m.account_id AND EXISTS(SELECT 1 FROM public.winnr_ingestion_endpoints h WHERE h.organization_id=p_org AND h.connection_id=email_dispatch_attempts.connection_id AND h.connection_version=email_dispatch_attempts.connection_version AND h.provider_account_id=m.provider_account_id) AND status='accepted' AND message->>'messageId'=original AND lower(message->>'to')=m.from_email AND lower(message->>'from')=m.to_email;
 IF count_matches<>1 THEN RETURN false; END IF;
 SELECT * INTO a FROM public.email_dispatch_attempts WHERE organization_id=p_org AND kind='campaign' AND account_id=m.account_id AND EXISTS(SELECT 1 FROM public.winnr_ingestion_endpoints h WHERE h.organization_id=p_org AND h.connection_id=email_dispatch_attempts.connection_id AND h.connection_version=email_dispatch_attempts.connection_version AND h.provider_account_id=m.provider_account_id) AND status='accepted' AND message->>'messageId'=original AND lower(message->>'to')=m.from_email AND lower(message->>'from')=m.to_email;
 IF NOT EXISTS(SELECT 1 FROM public.sent_emails WHERE id=a.id AND organization_id=p_org AND email_account_id=m.account_id) THEN RETURN false; END IF;
 SELECT id INTO t FROM public.threads WHERE organization_id=p_org AND mailbox_id=m.account_id AND thread_external_id='winnr:'||a.id::text LIMIT 1;
 IF t IS NULL THEN INSERT INTO public.threads(organization_id,mailbox_id,campaign_id,lead_id,thread_external_id,subject,participant_email,message_count,first_message_at,last_message_at,is_read) VALUES(p_org,m.account_id,a.campaign_id,a.lead_id,'winnr:'||a.id::text,coalesce(a.message->>'subject',''),m.from_email,0,least(coalesce(a.settled_at,a.created_at),m.received_at),greatest(coalesce(a.settled_at,a.created_at),m.received_at),false) RETURNING id INTO t; END IF;
 SELECT thread_id INTO old_thread FROM public.replies WHERE id=m.reply_id AND organization_id=p_org;
 UPDATE public.replies SET sent_email_id=a.id,lead_id=a.lead_id,thread_id=t WHERE id=m.reply_id AND organization_id=p_org AND email_account_id=m.account_id;
 INSERT INTO public.thread_messages(id,thread_id,message_id,direction,from_email,to_email,subject,body_text,body_html,sent_at) VALUES(a.id,t,a.message->>'messageId','outbound',a.message->>'from',a.message->>'to',a.message->>'subject',a.message->>'text',a.message->>'html',coalesce(a.settled_at,a.created_at)) ON CONFLICT(id) DO NOTHING;
 UPDATE public.threads SET message_count=(SELECT count(*) FROM public.replies WHERE thread_id=t)+(SELECT count(*) FROM public.thread_messages WHERE thread_id=t),last_message_at=greatest(last_message_at,m.received_at),first_message_at=least(first_message_at,m.received_at),is_read=false,updated_at=now() WHERE id=t;
 IF old_thread IS DISTINCT FROM t THEN DELETE FROM public.threads WHERE id=old_thread AND organization_id=p_org AND NOT EXISTS(SELECT 1 FROM public.replies WHERE thread_id=old_thread) AND NOT EXISTS(SELECT 1 FROM public.thread_messages WHERE thread_id=old_thread); END IF;
 UPDATE public.sent_emails SET replied_at=coalesce(replied_at,m.received_at),status='replied' WHERE id=a.id AND organization_id=p_org;
 RETURN true;
END $$;
CREATE FUNCTION public.winnr_correlate_ingested(p_org uuid,p_message uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE m public.winnr_ingested_messages;a public.email_dispatch_attempts;original text;old_thread uuid;new_thread uuid;matches int;linked boolean;old_control public.outreach_conversation_controls;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('email-dispatch:'||p_org::text,0));
 SELECT * INTO m FROM public.winnr_ingested_messages WHERE id=p_message AND organization_id=p_org FOR UPDATE;
 IF NOT FOUND OR m.in_reply_to IS NULL THEN RETURN false; END IF;
 SELECT original_message_id INTO original FROM public.winnr_message_id_maps WHERE organization_id=p_org AND provider_account_id=m.provider_account_id AND account_id=m.account_id AND provider_message_id=m.in_reply_to AND recipient=m.from_email;
 original:=coalesce(original,m.in_reply_to);
 SELECT thread_id INTO old_thread FROM public.replies WHERE id=m.reply_id AND organization_id=p_org;
 SELECT * INTO old_control FROM public.outreach_conversation_controls WHERE organization_id=p_org AND thread_id=old_thread;
 SELECT count(*) INTO matches FROM public.email_dispatch_attempts WHERE organization_id=p_org AND kind='reply' AND account_id=m.account_id AND EXISTS(SELECT 1 FROM public.winnr_ingestion_endpoints h WHERE h.organization_id=p_org AND h.connection_id=email_dispatch_attempts.connection_id AND h.connection_version=email_dispatch_attempts.connection_version AND h.provider_account_id=m.provider_account_id) AND status='accepted' AND message->>'messageId'=original AND message->>'to'=m.from_email AND message->>'from'=m.to_email;
 IF matches=0 THEN
  linked:=public.winnr_correlate_ingested_027(p_org,p_message);
  IF linked THEN
   SELECT thread_id INTO new_thread FROM public.replies WHERE id=m.reply_id AND organization_id=p_org;
   PERFORM public.outreach_merge_reply_controls(p_org,old_thread,new_thread);
  END IF;
  RETURN linked;
 END IF;
 IF matches<>1 THEN RETURN false; END IF;
 SELECT * INTO a FROM public.email_dispatch_attempts WHERE organization_id=p_org AND kind='reply' AND account_id=m.account_id AND EXISTS(SELECT 1 FROM public.winnr_ingestion_endpoints h WHERE h.organization_id=p_org AND h.connection_id=email_dispatch_attempts.connection_id AND h.connection_version=email_dispatch_attempts.connection_version AND h.provider_account_id=m.provider_account_id) AND status='accepted' AND message->>'messageId'=original AND message->>'to'=m.from_email AND message->>'from'=m.to_email;
 new_thread:=public.outreach_canonical_reply_thread(p_org,a.thread_id);
 IF new_thread IS NULL THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.threads WHERE id=new_thread AND organization_id=p_org AND mailbox_id=m.account_id AND lower(btrim(participant_email))=m.from_email) OR NOT EXISTS(SELECT 1 FROM public.sent_emails WHERE id=a.id AND organization_id=p_org AND email_account_id=m.account_id) OR NOT EXISTS(SELECT 1 FROM public.thread_messages WHERE id=a.id AND thread_id IN(a.thread_id,new_thread) AND direction='outbound') THEN RETURN false; END IF;
 SELECT thread_id INTO old_thread FROM public.replies WHERE id=m.reply_id AND organization_id=p_org;
 PERFORM public.outreach_merge_reply_controls(p_org,old_thread,new_thread);
 UPDATE public.replies SET thread_id=new_thread,lead_id=a.lead_id,sent_email_id=a.id WHERE id=m.reply_id AND organization_id=p_org;
 UPDATE public.threads SET message_count=(SELECT count(*) FROM public.thread_messages WHERE thread_id=new_thread)+(SELECT count(*) FROM public.replies WHERE thread_id=new_thread),last_message_at=greatest(last_message_at,m.received_at),is_read=false,updated_at=now() WHERE id=new_thread;
 UPDATE public.sent_emails SET replied_at=coalesce(replied_at,m.received_at),status='replied' WHERE id=a.id AND organization_id=p_org;
 IF old_thread IS DISTINCT FROM new_thread THEN DELETE FROM public.threads WHERE id=old_thread AND organization_id=p_org AND NOT EXISTS(SELECT 1 FROM public.replies WHERE thread_id=old_thread) AND NOT EXISTS(SELECT 1 FROM public.thread_messages WHERE thread_id=old_thread); END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.winnr_correlate_ingested(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.winnr_correlate_ingested(uuid,uuid) TO service_role;
COMMIT;
