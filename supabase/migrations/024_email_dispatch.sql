-- Authoritative campaign touch ledger. SMTP026 may be installed after this file.
BEGIN;
CREATE TABLE public.email_dispatch_config (
 campaign_id uuid PRIMARY KEY REFERENCES public.campaigns(id), organization_id uuid NOT NULL REFERENCES public.organizations(id),
 sender_name text NOT NULL CHECK(length(btrim(sender_name)) BETWEEN 1 AND 100), sender_company text NOT NULL CHECK(length(btrim(sender_company)) BETWEEN 1 AND 200),
 business_address text NOT NULL CHECK(length(btrim(business_address)) BETWEEN 1 AND 1000), sender_email text NOT NULL CHECK(length(sender_email)<=254 AND sender_email=lower(btrim(sender_email))),
 mailbox_id text NOT NULL CHECK(length(mailbox_id) BETWEEN 1 AND 200), mailbox_daily_limit integer NOT NULL CHECK(mailbox_daily_limit BETWEEN 1 AND 1000),
 connection_id uuid NOT NULL, connection_version integer NOT NULL CHECK(connection_version>0), killed boolean NOT NULL DEFAULT false
);
CREATE TABLE public.email_dispatch_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), actor_id uuid NOT NULL,
 campaign_id uuid NOT NULL REFERENCES public.campaigns(id), enrollment_id uuid NOT NULL REFERENCES public.campaign_leads(id), lead_id uuid NOT NULL REFERENCES public.leads(id),
 step_number integer NOT NULL, revision timestamptz NOT NULL, sequence_snapshot jsonb NOT NULL, settings_snapshot jsonb NOT NULL,
 connection_id uuid NOT NULL, connection_version integer NOT NULL, mailbox_id text NOT NULL, account_id uuid,
 message jsonb NOT NULL CHECK(jsonb_typeof(message)='object'), fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 claim_token uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(), status text NOT NULL CHECK(status IN ('reserved','dispatching','accepted','rejected','cancelled','unknown')),
 lease_expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), authorized_at timestamptz, settled_at timestamptz, receipt jsonb, error_code text,
 UNIQUE(campaign_id,lead_id,step_number)
);
CREATE UNIQUE INDEX email_dispatch_recipient_touch ON public.email_dispatch_attempts(campaign_id,(message->>'to'),step_number);
CREATE INDEX email_dispatch_status ON public.email_dispatch_attempts(organization_id,status,lease_expires_at);
ALTER TABLE public.email_dispatch_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_dispatch_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_dispatch_config,public.email_dispatch_attempts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.email_dispatch_config,public.email_dispatch_attempts TO service_role;

-- Controls and final authorization share an organization serialization point.
CREATE FUNCTION public.email_dispatch_control_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE org uuid; cid uuid;
BEGIN
 IF TG_TABLE_NAME='campaign_sequences' THEN
  cid:=CASE WHEN TG_OP='DELETE' THEN OLD.campaign_id ELSE NEW.campaign_id END;
  SELECT organization_id INTO org FROM public.campaigns WHERE id=cid;
 ELSIF TG_TABLE_NAME='campaign_leads' THEN
  cid:=CASE WHEN TG_OP='DELETE' THEN OLD.campaign_id ELSE NEW.campaign_id END;
  SELECT organization_id INTO org FROM public.campaigns WHERE id=cid;
 ELSE org:=CASE WHEN TG_OP='DELETE' THEN OLD.organization_id ELSE NEW.organization_id END; END IF;
 IF org IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('email-dispatch:'||org::text,0)); END IF;
 IF TG_TABLE_NAME='replies' THEN
  UPDATE public.campaign_leads cl SET status='replied',next_send_at=NULL FROM public.campaigns cc,public.leads ll
  WHERE cl.campaign_id=cc.id AND cc.organization_id=org AND cl.lead_id=ll.id AND ll.organization_id=org AND cl.status IN ('pending','in_progress') AND (ll.id=NEW.lead_id OR lower(btrim(ll.email))=lower(btrim(NEW.from_email)));
 END IF;
 IF TG_TABLE_NAME='campaigns' THEN
  cid:=OLD.id;
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND NEW.settings IS DISTINCT FROM OLD.settings) THEN
   IF EXISTS(SELECT 1 FROM public.email_dispatch_attempts WHERE campaign_id=cid AND status IN ('reserved','dispatching','unknown')) THEN RAISE EXCEPTION 'email_dispatch:unresolved_touch'; END IF;
  END IF;
 ELSIF TG_TABLE_NAME='campaign_sequences' THEN
  IF EXISTS(SELECT 1 FROM public.email_dispatch_attempts WHERE campaign_id=cid AND status IN ('reserved','dispatching','unknown')) THEN RAISE EXCEPTION 'email_dispatch:unresolved_touch'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER email_dispatch_campaign_guard BEFORE UPDATE OR DELETE ON public.campaigns FOR EACH ROW EXECUTE FUNCTION public.email_dispatch_control_guard();
CREATE TRIGGER email_dispatch_sequence_guard BEFORE INSERT OR UPDATE OR DELETE ON public.campaign_sequences FOR EACH ROW EXECUTE FUNCTION public.email_dispatch_control_guard();
CREATE TRIGGER email_dispatch_lead_guard BEFORE UPDATE ON public.leads FOR EACH ROW EXECUTE FUNCTION public.email_dispatch_control_guard();
CREATE TRIGGER email_dispatch_enrollment_guard BEFORE UPDATE OR DELETE ON public.campaign_leads FOR EACH ROW EXECUTE FUNCTION public.email_dispatch_control_guard();
CREATE TRIGGER email_dispatch_reply_guard BEFORE INSERT OR UPDATE ON public.replies FOR EACH ROW EXECUTE FUNCTION public.email_dispatch_control_guard();
CREATE TRIGGER email_dispatch_connection_guard BEFORE UPDATE OR DELETE ON public.winnr_connections FOR EACH ROW EXECUTE FUNCTION public.email_dispatch_control_guard();
CREATE TRIGGER email_dispatch_suppression_guard BEFORE INSERT OR UPDATE ON public.outreach_suppressions FOR EACH ROW EXECUTE FUNCTION public.email_dispatch_control_guard();

--028 owns proof storage. Absence is fail-closed, including installations before028.
CREATE FUNCTION public.email_dispatch_validation_current(p_org uuid,p_lead uuid,p_email text,p_now timestamptz) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE current_proof boolean;
BEGIN
 IF to_regprocedure('public.lead_validation_is_current(uuid,uuid,text,timestamp with time zone)') IS NULL THEN RETURN false; END IF;
 EXECUTE 'SELECT public.lead_validation_is_current($1,$2,$3,$4)' INTO current_proof USING p_org,p_lead,p_email,p_now;
 RETURN coalesce(current_proof,false);
END $$;
REVOKE ALL ON FUNCTION public.email_dispatch_validation_current(uuid,uuid,text,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.email_dispatch_validation_current(uuid,uuid,text,timestamptz) TO service_role;

CREATE FUNCTION public.email_dispatch_mutate(p_actor uuid,p_org uuid,p_action text,p_payload jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.campaigns%ROWTYPE; cfg public.email_dispatch_config%ROWTYPE; e public.campaign_leads%ROWTYPE; l public.leads%ROWTYPE; s public.campaign_sequences%ROWTYPE; a public.email_dispatch_attempts%ROWTYPE;
 actor_role text; cid uuid; now_at timestamptz:=clock_timestamp(); local_at timestamp; tz text; day_start timestamptz; cap integer; sender text; recipient text; account uuid; next_step public.campaign_sequences%ROWTYPE; result jsonb; pending jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('email-dispatch:'||p_org::text,0));
 SELECT role INTO actor_role FROM public.users WHERE id=p_actor AND organization_id=p_org FOR SHARE;
 IF actor_role IS NULL OR actor_role NOT IN ('owner','admin') THEN RAISE EXCEPTION 'email_dispatch:forbidden'; END IF;
 now_at:=clock_timestamp();
 UPDATE public.email_dispatch_attempts SET status='unknown',error_code='lease_expired',settled_at=now_at WHERE organization_id=p_org AND status='dispatching' AND lease_expires_at<=now_at;
 UPDATE public.email_dispatch_attempts SET status='cancelled',error_code='preflight_lease_expired',settled_at=now_at WHERE organization_id=p_org AND status='reserved' AND lease_expires_at<=now_at;
 IF p_action='authorize' OR p_action='settle' THEN
  SELECT * INTO a FROM public.email_dispatch_attempts WHERE claim_token=(p_payload->>'claimToken')::uuid AND organization_id=p_org FOR UPDATE;
  IF NOT FOUND OR a.actor_id<>p_actor THEN RETURN jsonb_build_object('allowed',false,'reason','claim_not_found'); END IF;
  cid:=a.campaign_id;
 ELSE cid:=(p_payload->>'campaignId')::uuid; END IF;
 SELECT * INTO c FROM public.campaigns WHERE id=cid AND organization_id=p_org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'email_dispatch:not_found'; END IF;
 IF p_action='configure' THEN
  IF c.status NOT IN ('draft','paused') OR EXISTS(SELECT 1 FROM public.email_dispatch_attempts WHERE campaign_id=cid AND status IN ('reserved','dispatching','unknown')) THEN RAISE EXCEPTION 'email_dispatch:not_editable'; END IF;
  IF NOT coalesce(c.settings->'mailboxIds','[]') ? (p_payload->>'mailboxId') THEN RAISE EXCEPTION 'email_dispatch:sender_binding'; END IF;
  INSERT INTO public.email_dispatch_config(campaign_id,organization_id,sender_name,sender_company,business_address,sender_email,mailbox_id,mailbox_daily_limit,connection_id,connection_version)
   VALUES(cid,p_org,p_payload->>'senderName',p_payload->>'senderCompany',p_payload->>'businessAddress',lower(btrim(p_payload->>'senderEmail')),p_payload->>'mailboxId',(p_payload->>'mailboxDailyLimit')::int,(c.settings->>'senderConnectionId')::uuid,(c.settings->>'senderConnectionVersion')::int)
   ON CONFLICT(campaign_id) DO UPDATE SET sender_name=EXCLUDED.sender_name,sender_company=EXCLUDED.sender_company,business_address=EXCLUDED.business_address,sender_email=EXCLUDED.sender_email,mailbox_id=EXCLUDED.mailbox_id,mailbox_daily_limit=EXCLUDED.mailbox_daily_limit,connection_id=EXCLUDED.connection_id,connection_version=EXCLUDED.connection_version;
  RETURN jsonb_build_object('configured',true);
 END IF;
 SELECT * INTO cfg FROM public.email_dispatch_config WHERE campaign_id=cid AND organization_id=p_org FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('ready',false,'reason','sender_identity_required'); END IF;
 IF p_action='kill' THEN UPDATE public.email_dispatch_config SET killed=true WHERE campaign_id=cid; UPDATE public.campaigns SET status='paused' WHERE id=cid; RETURN jsonb_build_object('killed',true); END IF;
 IF p_action='settle' THEN
  IF a.status='reserved' AND p_payload->>'outcome' IN ('rejected','unknown') THEN
   UPDATE public.email_dispatch_attempts SET status=CASE WHEN p_payload->>'outcome'='unknown' THEN 'unknown' ELSE 'cancelled' END,error_code=left(p_payload->>'code',100),settled_at=now_at WHERE id=a.id;
   RETURN jsonb_build_object('settled',true,'status',CASE WHEN p_payload->>'outcome'='unknown' THEN 'unknown' ELSE 'cancelled' END);
  END IF;
  IF a.status<>'dispatching' OR a.lease_expires_at<=now_at THEN RETURN jsonb_build_object('settled',false,'status',a.status); END IF;
  IF p_payload->>'outcome'='accepted' AND p_payload->>'messageId'=a.message->>'messageId' AND p_payload->>'recipient'=a.message->>'to' THEN
   UPDATE public.email_dispatch_attempts SET status='accepted',receipt=jsonb_build_object('messageId',p_payload->>'messageId','recipient',p_payload->>'recipient'),settled_at=now_at WHERE id=a.id;
   INSERT INTO public.sent_emails(id,organization_id,campaign_id,campaign_lead_id,lead_id,email_account_id,from_email,to_email,subject,body_text,body_html,message_id,status,sent_at)
   VALUES(a.id,p_org,cid,a.enrollment_id,a.lead_id,a.account_id,a.message->>'from',a.message->>'to',a.message->>'subject',a.message->>'text',a.message->>'html',p_payload->>'messageId','sent',now_at);
   SELECT * INTO next_step FROM public.campaign_sequences WHERE campaign_id=cid AND step_number>a.step_number ORDER BY step_number LIMIT 1;
   UPDATE public.campaign_leads SET current_step=a.step_number,last_sent_at=now_at,status=CASE WHEN status IN ('pending','in_progress') THEN CASE WHEN next_step.id IS NULL THEN 'completed' ELSE 'in_progress' END ELSE status END,
    next_send_at=CASE WHEN next_step.id IS NOT NULL AND status IN ('pending','in_progress') THEN now_at+make_interval(days=>coalesce(next_step.delay_days,0),hours=>coalesce(next_step.delay_hours,0)) ELSE NULL END WHERE id=a.enrollment_id;
   RETURN jsonb_build_object('settled',true,'status','accepted','attemptId',a.id);
  END IF;
  UPDATE public.email_dispatch_attempts SET status=CASE WHEN p_payload->>'outcome'='rejected' THEN 'rejected' ELSE 'unknown' END,receipt=jsonb_strip_nulls(jsonb_build_object('messageId',p_payload->>'messageId','recipient',p_payload->>'recipient')),error_code=left(coalesce(p_payload->>'code','receipt_mismatch'),100),settled_at=now_at WHERE id=a.id;
  RETURN jsonb_build_object('settled',true,'status',CASE WHEN p_payload->>'outcome'='rejected' THEN 'rejected' ELSE 'unknown' END);
 END IF;
 IF to_regprocedure('public.lead_validation_is_current(uuid,uuid,text,timestamp with time zone)') IS NULL THEN RETURN jsonb_build_object('ready',false,'reason','validation_unavailable','configuration',to_jsonb(cfg)); END IF;
 -- Readiness is grounded in current connection + nonsecret SMTP026 observations.
 IF cfg.killed OR cfg.connection_id IS DISTINCT FROM (c.settings->>'senderConnectionId')::uuid OR cfg.connection_version IS DISTINCT FROM (c.settings->>'senderConnectionVersion')::int OR NOT coalesce(c.settings->'mailboxIds','[]') ? cfg.mailbox_id
  OR NOT EXISTS(SELECT 1 FROM public.winnr_connections WHERE id=cfg.connection_id AND organization_id=p_org AND version=cfg.connection_version) THEN RETURN jsonb_build_object('ready',false,'reason','sender_binding','configuration',to_jsonb(cfg)); END IF;
 IF to_regclass('public.winnr_mailbox_credentials') IS NULL THEN RETURN jsonb_build_object('ready',false,'reason','smtp_not_configured','configuration',to_jsonb(cfg)); END IF;
 EXECUTE 'SELECT email,account_id FROM public.winnr_mailbox_credentials WHERE organization_id=$1 AND connection_id=$2 AND connection_version=$3 AND provider_mailbox_id=$4' INTO sender,account USING p_org,cfg.connection_id,cfg.connection_version,cfg.mailbox_id;
 IF sender IS NULL OR sender<>cfg.sender_email THEN RETURN jsonb_build_object('ready',false,'reason','smtp_not_configured','configuration',to_jsonb(cfg)); END IF;
 IF NOT EXISTS(SELECT 1 FROM public.email_accounts WHERE id=account AND organization_id=p_org AND lower(btrim(email))=sender) THEN RETURN jsonb_build_object('ready',false,'reason','canonical_sender_missing','configuration',to_jsonb(cfg)); END IF;
 IF NOT EXISTS(SELECT 1 FROM public.campaign_sequences WHERE campaign_id=cid) OR (SELECT min(step_number)<>1 OR max(step_number)<>count(*) FROM public.campaign_sequences WHERE campaign_id=cid) OR EXISTS(SELECT 1 FROM public.campaign_sequences WHERE campaign_id=cid AND coalesce(condition_type,'always') NOT IN ('always','not_replied')) THEN RETURN jsonb_build_object('ready',false,'reason','unsupported_sequence','configuration',to_jsonb(cfg)); END IF;
 tz:=coalesce(c.settings->>'timezone','');
 IF NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=tz) OR coalesce((c.settings->>'dailyLimit')::int,0) NOT BETWEEN 1 AND 1000 OR coalesce((c.settings->>'sendingWindowStart')::int,-1) NOT BETWEEN 0 AND 23 OR coalesce((c.settings->>'sendingWindowEnd')::int,-1) NOT BETWEEN 1 AND 24 OR (c.settings->>'sendingWindowStart')::int >= (c.settings->>'sendingWindowEnd')::int THEN RETURN jsonb_build_object('ready',false,'reason','invalid_schedule','configuration',to_jsonb(cfg)); END IF;
 IF c.settings ? 'sendingDays' AND (jsonb_typeof(c.settings->'sendingDays')<>'array' OR jsonb_array_length(c.settings->'sendingDays')=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(c.settings->'sendingDays') d WHERE d.value !~ '^[0-6]$')) THEN RETURN jsonb_build_object('ready',false,'reason','invalid_schedule','configuration',to_jsonb(cfg)); END IF;
 IF p_action IN ('start','resume') AND EXISTS(SELECT 1 FROM public.email_dispatch_attempts WHERE campaign_id=cid AND status='unknown') THEN RETURN jsonb_build_object('ready',false,'reason','unknown_touch_requires_reconciliation','configuration',to_jsonb(cfg)); END IF;
 IF p_action='readiness' THEN RETURN jsonb_build_object('ready',true,'configuration',to_jsonb(cfg),'steps',(SELECT jsonb_agg(to_jsonb(cs)) FROM public.campaign_sequences cs WHERE campaign_id=cid)); END IF;
 IF p_action IN ('start','resume') THEN
  IF NOT EXISTS(SELECT 1 FROM public.campaign_leads cl JOIN public.leads ll ON ll.id=cl.lead_id AND ll.organization_id=p_org WHERE cl.campaign_id=cid AND cl.status IN ('pending','in_progress') AND ll.status='active' AND public.email_dispatch_validation_current(p_org,ll.id,lower(btrim(ll.email)),now_at) AND NOT EXISTS(SELECT 1 FROM public.outreach_suppressions WHERE organization_id=p_org AND normalized_email=lower(btrim(ll.email)) AND (expires_at IS NULL OR expires_at>now_at)) AND NOT EXISTS(SELECT 1 FROM public.replies WHERE organization_id=p_org AND (lead_id=ll.id OR lower(btrim(from_email))=lower(btrim(ll.email))))) THEN RETURN jsonb_build_object('ready',false,'reason','eligible_audience_required','configuration',to_jsonb(cfg)); END IF;
  IF c.status NOT IN ('draft','paused') THEN RAISE EXCEPTION 'email_dispatch:invalid_transition'; END IF;
  UPDATE public.campaigns SET status='active',updated_at=now_at WHERE id=cid RETURNING * INTO c;
  UPDATE public.campaign_leads SET next_send_at=now_at+make_interval(days=>coalesce(first.delay_days,0),hours=>coalesce(first.delay_hours,0)) FROM public.campaign_sequences first WHERE campaign_leads.campaign_id=cid AND first.campaign_id=cid AND first.step_number=1 AND coalesce(campaign_leads.current_step,0)=0 AND campaign_leads.next_send_at IS NULL AND campaign_leads.status='pending';
  RETURN jsonb_build_object('ready',true,'campaign',to_jsonb(c));
 END IF;
 IF p_action='retry' THEN
  SELECT * INTO a FROM public.email_dispatch_attempts WHERE id=(p_payload->>'attemptId')::uuid AND organization_id=p_org AND campaign_id=cid FOR UPDATE;
  IF NOT FOUND OR a.status<>'cancelled' OR a.authorized_at IS NOT NULL OR c.status<>'active' THEN RETURN jsonb_build_object('allowed',false,'reason','retry_not_proven_safe'); END IF;
  SELECT * INTO s FROM public.campaign_sequences WHERE campaign_id=cid AND step_number=a.step_number;
  IF a.sequence_snapshot IS DISTINCT FROM to_jsonb(s) OR a.settings_snapshot IS DISTINCT FROM c.settings OR a.connection_id<>cfg.connection_id OR a.connection_version<>cfg.connection_version OR a.mailbox_id<>cfg.mailbox_id THEN RETURN jsonb_build_object('allowed',false,'reason','configuration_changed'); END IF;
  UPDATE public.email_dispatch_attempts SET status='reserved',actor_id=p_actor,claim_token=gen_random_uuid(),lease_expires_at=now_at+interval '2 minutes',error_code=NULL,settled_at=NULL WHERE id=a.id RETURNING * INTO a;
  RETURN jsonb_build_object('allowed',true,'attempt',to_jsonb(a),'configuration',to_jsonb(cfg));
 END IF;
 IF p_action='candidates' THEN
  SELECT coalesce(jsonb_agg(row),'[]') INTO pending FROM (
   SELECT cl.id AS "enrollmentId",to_jsonb(l0) AS lead,to_jsonb(s0) AS step,to_jsonb(cfg) AS configuration
   FROM public.campaign_leads cl JOIN public.leads l0 ON l0.id=cl.lead_id AND l0.organization_id=p_org
   JOIN public.campaign_sequences s0 ON s0.campaign_id=cid AND s0.step_number=coalesce(cl.current_step,0)+1
   WHERE c.status='active' AND cl.campaign_id=cid AND cl.status IN ('pending','in_progress') AND (cl.next_send_at IS NULL OR cl.next_send_at<=now_at)
    AND l0.status='active' AND public.email_dispatch_validation_current(p_org,l0.id,lower(btrim(l0.email)),now_at)
    AND NOT EXISTS(SELECT 1 FROM public.outreach_suppressions WHERE organization_id=p_org AND normalized_email=lower(btrim(l0.email)) AND (expires_at IS NULL OR expires_at>now_at))
    AND NOT EXISTS(SELECT 1 FROM public.replies WHERE organization_id=p_org AND (lead_id=l0.id OR lower(btrim(from_email))=lower(btrim(l0.email))))
    AND NOT EXISTS(SELECT 1 FROM public.email_dispatch_attempts a0 WHERE a0.campaign_id=cid AND (a0.lead_id=cl.lead_id OR a0.message->>'to'=lower(btrim(l0.email))) AND a0.step_number=s0.step_number)
    AND NOT EXISTS(SELECT 1 FROM public.email_dispatch_attempts WHERE organization_id=p_org AND message->>'to'=lower(btrim(l0.email)) AND status IN ('dispatching','unknown'))
    AND extract(hour FROM now_at AT TIME ZONE tz)>=(c.settings->>'sendingWindowStart')::int AND extract(hour FROM now_at AT TIME ZONE tz)<(c.settings->>'sendingWindowEnd')::int
    AND (NOT coalesce((c.settings->>'skipWeekends')::boolean,true) OR extract(isodow FROM now_at AT TIME ZONE tz)<=5)
    AND (NOT c.settings ? 'sendingDays' OR c.settings->'sendingDays' @> jsonb_build_array(extract(dow FROM now_at AT TIME ZONE tz)::int))
   ORDER BY cl.id LIMIT least(greatest(coalesce((p_payload->>'limit')::int,1),1),20)
  ) row;
  RETURN jsonb_build_object('ready',true,'candidates',pending);
 END IF;
 IF p_action='reserve' THEN
  SELECT * INTO e FROM public.campaign_leads WHERE id=(p_payload->>'enrollmentId')::uuid AND campaign_id=cid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'email_dispatch:not_found'; END IF;
  SELECT * INTO s FROM public.campaign_sequences WHERE campaign_id=cid AND step_number=coalesce(e.current_step,0)+1;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','no_next_step'); END IF;
  SELECT * INTO l FROM public.leads WHERE id=e.lead_id AND organization_id=p_org FOR UPDATE;
  IF p_payload->'step' IS DISTINCT FROM to_jsonb(s) OR p_payload->'configuration' IS DISTINCT FROM to_jsonb(cfg) THEN RETURN jsonb_build_object('allowed',false,'reason','stale_snapshot'); END IF;
  IF NOT FOUND OR (p_payload->'message'->>'to') IS DISTINCT FROM lower(btrim(l.email)) OR (p_payload->'message'->>'from') IS DISTINCT FROM cfg.sender_email THEN RAISE EXCEPTION 'email_dispatch:message_binding'; END IF;
  a.step_number:=s.step_number; a.id:=gen_random_uuid(); recipient:=p_payload->'message'->>'to';

 ELSE
  IF p_action<>'authorize' OR a.status<>'reserved' OR a.lease_expires_at<=now_at OR a.fingerprint<>p_payload->>'fingerprint' OR a.connection_id::text<>p_payload->>'connectionId' OR a.connection_version<>(p_payload->>'connectionVersion')::int OR a.mailbox_id<>p_payload->>'mailboxId' THEN RETURN jsonb_build_object('allowed',false,'reason','invalid_claim'); END IF;
  SELECT * INTO e FROM public.campaign_leads WHERE id=a.enrollment_id AND campaign_id=cid FOR UPDATE;
  SELECT * INTO l FROM public.leads WHERE id=a.lead_id AND organization_id=p_org FOR UPDATE;
  SELECT * INTO s FROM public.campaign_sequences WHERE campaign_id=cid AND step_number=a.step_number;
  recipient:=a.message->>'to';
  IF recipient IS DISTINCT FROM lower(btrim(l.email)) OR (a.message->>'from') IS DISTINCT FROM cfg.sender_email OR a.account_id IS DISTINCT FROM account THEN RETURN jsonb_build_object('allowed',false,'reason','message_binding'); END IF;
  IF s.id IS NULL OR a.sequence_snapshot IS DISTINCT FROM to_jsonb(s) OR a.settings_snapshot IS DISTINCT FROM c.settings THEN RETURN jsonb_build_object('allowed',false,'reason','configuration_changed'); END IF;
 END IF;
 now_at:=clock_timestamp();
 IF p_action='authorize' AND a.lease_expires_at<=now_at THEN RETURN jsonb_build_object('allowed',false,'reason','lease_expired'); END IF;
 local_at:=now_at AT TIME ZONE tz; day_start:=date_trunc('day',local_at) AT TIME ZONE tz;
 IF c.status<>'active' OR e.status NOT IN ('pending','in_progress') OR coalesce(e.current_step,0)+1<>a.step_number OR l.status IS DISTINCT FROM 'active' OR NOT public.email_dispatch_validation_current(p_org,l.id,recipient,now_at) OR (e.next_send_at IS NOT NULL AND e.next_send_at>now_at)
  OR EXISTS(SELECT 1 FROM public.replies WHERE organization_id=p_org AND (lead_id=l.id OR lower(btrim(from_email))=recipient))
  OR EXISTS(SELECT 1 FROM public.outreach_suppressions WHERE organization_id=p_org AND normalized_email=recipient AND (expires_at IS NULL OR expires_at>now_at))
  OR extract(hour FROM local_at)<(c.settings->>'sendingWindowStart')::int OR extract(hour FROM local_at)>=(c.settings->>'sendingWindowEnd')::int
  OR (coalesce((c.settings->>'skipWeekends')::boolean,true) AND extract(isodow FROM local_at)>5)
  OR EXISTS(SELECT 1 FROM public.email_dispatch_attempts WHERE organization_id=p_org AND message->>'to'=recipient AND status IN ('dispatching','unknown') AND id<>a.id)
  OR (c.settings ? 'sendingDays' AND NOT (c.settings->'sendingDays' @> jsonb_build_array(extract(dow FROM local_at)::int)))
 THEN RETURN jsonb_build_object('allowed',false,'reason','ineligible'); END IF;
 IF p_action='reserve' THEN
  INSERT INTO public.email_dispatch_attempts(organization_id,actor_id,campaign_id,enrollment_id,lead_id,step_number,revision,sequence_snapshot,settings_snapshot,connection_id,connection_version,mailbox_id,message,fingerprint,status,lease_expires_at,account_id)
   VALUES(p_org,p_actor,cid,e.id,l.id,s.step_number,c.updated_at,to_jsonb(s),c.settings,cfg.connection_id,cfg.connection_version,cfg.mailbox_id,p_payload->'message',p_payload->>'fingerprint','reserved',now_at+interval '2 minutes',account)
   ON CONFLICT DO NOTHING RETURNING * INTO a;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','duplicate_touch'); END IF;
  RETURN jsonb_build_object('allowed',true,'attempt',to_jsonb(a));
 END IF;
 SELECT min(mailbox_daily_limit) INTO cap FROM public.email_dispatch_config WHERE organization_id=p_org AND lower(btrim(sender_email))=cfg.sender_email;
 IF (SELECT count(*) FROM public.email_dispatch_attempts WHERE organization_id=p_org AND message->>'to'=a.message->>'to' AND authorized_at>=now_at-interval '7 days' AND status IN ('dispatching','accepted','unknown','rejected')) >= 3 THEN RETURN jsonb_build_object('allowed',false,'reason','frequency_cap'); END IF;
 IF (SELECT count(*) FROM public.email_dispatch_attempts WHERE campaign_id=cid AND authorized_at>=day_start AND status IN ('dispatching','accepted','unknown','rejected')) >= (c.settings->>'dailyLimit')::int
  OR (SELECT count(*) FROM public.email_dispatch_attempts WHERE organization_id=p_org AND (account_id=account OR lower(btrim(message->>'from'))=cfg.sender_email) AND authorized_at>=date_trunc('day',now_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND status IN ('dispatching','accepted','unknown','rejected')) >= cap THEN RETURN jsonb_build_object('allowed',false,'reason','daily_cap'); END IF;
 UPDATE public.email_dispatch_attempts SET status='dispatching',authorized_at=now_at,lease_expires_at=now_at+interval '2 minutes' WHERE id=a.id;
 RETURN jsonb_build_object('allowed',true,'grant',jsonb_build_object('organizationId',p_org,'connectionId',cfg.connection_id,'connectionVersion',cfg.connection_version,'mailboxId',cfg.mailbox_id,'claimToken',a.claim_token,'fingerprint',a.fingerprint,'attemptId',a.id));
END $$;
REVOKE ALL ON FUNCTION public.email_dispatch_mutate(uuid,uuid,text,jsonb),public.email_dispatch_control_guard() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.email_dispatch_mutate(uuid,uuid,text,jsonb) TO service_role;
COMMIT;
