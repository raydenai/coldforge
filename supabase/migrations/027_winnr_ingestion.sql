BEGIN;
CREATE TABLE public.winnr_ingestion_endpoints (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
 connection_id uuid NOT NULL, connection_version integer NOT NULL,
 provider_account_id text NOT NULL, webhook_id text, secret_ciphertext text, verified_events text[] NOT NULL DEFAULT '{}', associated_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,connection_id,connection_version), CHECK(connection_version>0)
);
CREATE TABLE public.winnr_ingestion_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), endpoint_id uuid NOT NULL REFERENCES public.winnr_ingestion_endpoints(id),
 organization_id uuid NOT NULL REFERENCES public.organizations(id), provider_event_id text NOT NULL, fingerprint text NOT NULL,
 message_record_id uuid, payload jsonb NOT NULL, channel text NOT NULL DEFAULT 'webhook' CHECK(channel IN('webhook','sync','lookup')), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,channel,provider_event_id),CHECK(length(fingerprint)=64)
);
CREATE TABLE public.winnr_ingested_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), connection_id uuid NOT NULL,
 connection_version integer NOT NULL, provider_account_id text NOT NULL, account_id uuid NOT NULL REFERENCES public.email_accounts(id), mailbox_id text NOT NULL,
 message_id text NOT NULL, in_reply_to text, from_email text NOT NULL, to_email text NOT NULL, subject text NOT NULL, received_at timestamptz NOT NULL,
 reply_id uuid NOT NULL REFERENCES public.replies(id), provider_uid text, body_status text NOT NULL DEFAULT 'pending' CHECK(body_status IN('pending','ready')),
 UNIQUE(organization_id,account_id,message_id)
);
CREATE TABLE public.winnr_message_id_maps (
 organization_id uuid NOT NULL REFERENCES public.organizations(id), connection_id uuid NOT NULL,
 provider_account_id text NOT NULL, account_id uuid NOT NULL REFERENCES public.email_accounts(id), original_message_id text NOT NULL, provider_message_id text NOT NULL,
 recipient text NOT NULL, PRIMARY KEY(organization_id,provider_account_id,account_id,provider_message_id,recipient)
);
ALTER TABLE public.winnr_ingestion_receipts ADD CONSTRAINT winnr_receipt_message_fkey FOREIGN KEY(message_record_id) REFERENCES public.winnr_ingested_messages(id);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['winnr_ingestion_endpoints','winnr_ingestion_receipts','winnr_ingested_messages','winnr_message_id_maps'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON public.%I TO service_role',t);
 EXECUTE format('CREATE POLICY service_only ON public.%I TO service_role USING(true) WITH CHECK(true)',t);
END LOOP; END $$;
CREATE FUNCTION public.winnr_prepare_ingestion(p_actor uuid,p_org uuid,p_connection uuid,p_version integer,p_webhook text DEFAULT NULL,p_ciphertext text DEFAULT NULL,p_events text[] DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.winnr_connections; e public.winnr_ingestion_endpoints;
BEGIN
 PERFORM 1 FROM public.users WHERE id=p_actor AND organization_id=p_org AND role IN('owner','admin') FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ingestion:forbidden'; END IF;
 SELECT * INTO c FROM public.winnr_connections WHERE id=p_connection AND organization_id=p_org AND version=p_version FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ingestion:stale'; END IF;
 IF p_webhook IS NOT NULL AND (length(p_webhook) NOT BETWEEN 1 AND 998 OR length(coalesce(p_ciphertext,''))<1 OR p_events IS NULL OR cardinality(p_events)<>4 OR NOT p_events @> ARRAY['email.received','message.relayed','email.bounced','email.complained']) THEN RAISE EXCEPTION 'ingestion:invalid'; END IF;
 INSERT INTO public.winnr_ingestion_endpoints(organization_id,connection_id,connection_version,provider_account_id) VALUES(p_org,p_connection,p_version,c.provider_account_id)
 ON CONFLICT(organization_id,connection_id,connection_version) DO NOTHING;
 SELECT * INTO e FROM public.winnr_ingestion_endpoints WHERE organization_id=p_org AND connection_id=p_connection AND connection_version=p_version FOR UPDATE;
 IF p_webhook IS NOT NULL THEN UPDATE public.winnr_ingestion_endpoints SET webhook_id=p_webhook,secret_ciphertext=p_ciphertext,verified_events=p_events,associated_at=clock_timestamp() WHERE id=e.id; END IF;
 RETURN jsonb_build_object('endpointId',e.id,'configured',p_webhook IS NOT NULL OR e.secret_ciphertext IS NOT NULL);
END $$;
-- Historical connection IDs deliberately have no live-credential FK. Disconnect
-- retires secrets, preserving audit receipts, mappings and canonical timelines.
CREATE FUNCTION public.winnr_ingestion_retire_connection() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN UPDATE public.winnr_ingestion_endpoints SET secret_ciphertext=NULL WHERE organization_id=OLD.organization_id AND connection_id=OLD.id; RETURN OLD; END $$;
CREATE TRIGGER winnr_ingestion_retire BEFORE DELETE ON public.winnr_connections FOR EACH ROW EXECUTE FUNCTION public.winnr_ingestion_retire_connection();
CREATE FUNCTION public.winnr_ingestion_is_ready(p_org uuid,p_connection uuid,p_version integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.winnr_connections c JOIN public.winnr_ingestion_endpoints e ON e.organization_id=c.organization_id AND e.connection_id=c.id AND e.connection_version=c.version AND e.provider_account_id=c.provider_account_id
 WHERE c.organization_id=p_org AND c.id=p_connection AND c.version=p_version AND c.permissions @> '["read","write"]'::jsonb AND length(btrim(e.webhook_id))>0 AND length(e.secret_ciphertext)>0 AND e.associated_at IS NOT NULL AND cardinality(e.verified_events)=4 AND e.verified_events @> ARRAY['email.received','message.relayed','email.bounced','email.complained']);
$$;
-- Resolve only exact accepted-message identity, mailbox and opposite participant.
CREATE FUNCTION public.winnr_correlate_ingested(p_org uuid,p_message uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE m public.winnr_ingested_messages; a public.email_dispatch_attempts; t uuid; old_thread uuid; count_matches integer; original text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('email-dispatch:'||p_org::text,0));
 SELECT * INTO m FROM public.winnr_ingested_messages WHERE id=p_message AND organization_id=p_org FOR UPDATE;
 IF NOT FOUND OR m.in_reply_to IS NULL THEN RETURN false; END IF;
 SELECT original_message_id INTO original FROM public.winnr_message_id_maps WHERE organization_id=p_org AND provider_account_id=m.provider_account_id AND account_id=m.account_id AND provider_message_id=m.in_reply_to AND recipient=m.from_email;
 original:=coalesce(original,m.in_reply_to);
 SELECT count(*) INTO count_matches FROM public.email_dispatch_attempts WHERE organization_id=p_org AND account_id=m.account_id AND (connection_id=m.connection_id OR EXISTS(SELECT 1 FROM public.winnr_ingestion_endpoints h WHERE h.organization_id=p_org AND h.connection_id=email_dispatch_attempts.connection_id AND h.provider_account_id=m.provider_account_id)) AND status='accepted' AND message->>'messageId'=original AND lower(message->>'to')=m.from_email AND lower(message->>'from')=m.to_email;
 IF count_matches<>1 THEN RETURN false; END IF;
 SELECT * INTO a FROM public.email_dispatch_attempts WHERE organization_id=p_org AND account_id=m.account_id AND (connection_id=m.connection_id OR EXISTS(SELECT 1 FROM public.winnr_ingestion_endpoints h WHERE h.organization_id=p_org AND h.connection_id=email_dispatch_attempts.connection_id AND h.provider_account_id=m.provider_account_id)) AND status='accepted' AND message->>'messageId'=original AND lower(message->>'to')=m.from_email AND lower(message->>'from')=m.to_email;
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
CREATE FUNCTION public.winnr_receive_event(p_endpoint uuid,p_payload jsonb,p_fingerprint text,p_channel text DEFAULT 'webhook') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.winnr_ingestion_endpoints; c public.winnr_connections; receipt public.winnr_ingestion_receipts; account public.winnr_mailbox_credentials;
 d jsonb:=p_payload->'data'; kind text:=p_payload->>'type'; mailbox text; sender text; target text; occurred timestamptz; reply uuid; thread uuid; lead uuid; m public.winnr_ingested_messages; canonical jsonb; spine jsonb;
BEGIN
 SELECT * INTO e FROM public.winnr_ingestion_endpoints WHERE id=p_endpoint AND secret_ciphertext IS NOT NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'ingestion:unconfigured'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('email-dispatch:'||e.organization_id::text,0));
 SELECT * INTO c FROM public.winnr_connections WHERE id=e.connection_id AND organization_id=e.organization_id AND version=e.connection_version FOR SHARE;
 IF NOT FOUND OR c.provider_account_id<>p_payload->>'account_id' OR e.provider_account_id<>p_payload->>'account_id' THEN RAISE EXCEPTION 'ingestion:account'; END IF;
 IF p_payload->>'id' !~ '^evt_[A-Za-z0-9_-]+$' OR length(p_payload->>'id')>200 OR p_payload->>'object'<>'event' OR kind NOT IN('email.received','message.relayed','email.bounced','email.complained','test.ping') OR length(p_fingerprint)<>64 OR octet_length(p_payload::text)>65536 THEN RAISE EXCEPTION 'ingestion:invalid'; END IF;
 IF p_channel IS NULL OR p_channel NOT IN('webhook','sync','lookup') THEN RAISE EXCEPTION 'ingestion:invalid'; END IF;
 occurred:=(p_payload->>'created')::timestamptz;
 SELECT * INTO receipt FROM public.winnr_ingestion_receipts WHERE organization_id=e.organization_id AND channel=p_channel AND provider_event_id=p_payload->>'id';
 IF FOUND THEN IF receipt.payload IS DISTINCT FROM p_payload THEN RAISE EXCEPTION 'ingestion:event_conflict'; END IF; RETURN jsonb_build_object('duplicate',true,'eventId',receipt.id); END IF;
 INSERT INTO public.winnr_ingestion_receipts(endpoint_id,organization_id,provider_event_id,fingerprint,payload,channel) VALUES(e.id,e.organization_id,p_payload->>'id',p_fingerprint,p_payload,p_channel) RETURNING * INTO receipt;
 IF kind<>'test.ping' THEN
 mailbox:=lower(CASE WHEN kind='email.received' THEN d->>'mailbox' ELSE d->>'sender' END);
 SELECT * INTO account FROM public.winnr_mailbox_credentials WHERE organization_id=e.organization_id AND connection_id=e.connection_id AND connection_version=e.connection_version AND lower(email)=mailbox;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.email_accounts WHERE id=account.account_id AND organization_id=e.organization_id AND lower(email)=mailbox) THEN RAISE EXCEPTION 'ingestion:mailbox'; END IF;
 END IF;
 IF kind='email.received' THEN
 sender:=lower(d->>'from');target:=mailbox;
 IF sender IS NULL OR sender !~ '^[^[:space:]@]+@[^[:space:]@]+$' OR length(sender)>254 OR length(coalesce(d->>'message_id','')) NOT BETWEEN 1 AND 998 THEN RAISE EXCEPTION 'ingestion:invalid'; END IF;
 SELECT CASE WHEN count(*)=1 THEN (array_agg(id))[1] ELSE NULL END INTO lead FROM public.leads WHERE organization_id=e.organization_id AND lower(btrim(email))=sender;
 UPDATE public.campaign_leads cl SET status='replied',next_send_at=NULL FROM public.campaigns ca,public.leads l WHERE cl.campaign_id=ca.id AND ca.organization_id=e.organization_id AND cl.lead_id=l.id AND l.organization_id=e.organization_id AND lower(btrim(l.email))=sender AND cl.status IN('pending','in_progress');
 SELECT * INTO m FROM public.winnr_ingested_messages WHERE organization_id=e.organization_id AND account_id=account.account_id AND message_id=d->>'message_id' FOR UPDATE;
 IF FOUND THEN
 IF m.provider_account_id<>e.provider_account_id OR m.from_email<>sender OR m.to_email<>target OR (m.subject<>'' AND coalesce(d->>'subject','')<>'' AND m.subject<>d->>'subject') OR (m.in_reply_to IS NOT NULL AND d->>'in_reply_to' IS NOT NULL AND m.in_reply_to<>d->>'in_reply_to') THEN RAISE EXCEPTION 'ingestion:message_conflict'; END IF;
 UPDATE public.winnr_ingested_messages SET connection_id=e.connection_id,connection_version=e.connection_version,mailbox_id=account.provider_mailbox_id,in_reply_to=coalesce(in_reply_to,d->>'in_reply_to'),subject=CASE WHEN subject='' THEN coalesce(d->>'subject','') ELSE subject END WHERE id=m.id RETURNING * INTO m;
 UPDATE public.replies SET in_reply_to=m.in_reply_to,subject=CASE WHEN coalesce(subject,'')='' THEN m.subject ELSE subject END WHERE id=m.reply_id AND organization_id=e.organization_id;
 UPDATE public.threads SET subject=m.subject WHERE id=(SELECT thread_id FROM public.replies WHERE id=m.reply_id AND organization_id=e.organization_id) AND organization_id=e.organization_id AND subject='';
 ELSE
 INSERT INTO public.threads(organization_id,mailbox_id,lead_id,thread_external_id,subject,participant_email,message_count,last_message_at,first_message_at,is_read) VALUES(e.organization_id,account.account_id,lead,'winnr:inbound:'||(d->>'message_id'),coalesce(d->>'subject',''),sender,1,coalesce((d->>'received_at')::timestamptz,occurred),coalesce((d->>'received_at')::timestamptz,occurred),false) RETURNING id INTO thread;
 INSERT INTO public.replies(organization_id,email_account_id,mailbox_id,lead_id,from_email,to_email,subject,message_id,in_reply_to,thread_id,received_at) VALUES(e.organization_id,account.account_id,account.account_id,lead,sender,target,d->>'subject',d->>'message_id',d->>'in_reply_to',thread,coalesce((d->>'received_at')::timestamptz,occurred)) RETURNING id INTO reply;
 INSERT INTO public.winnr_ingested_messages(organization_id,connection_id,connection_version,provider_account_id,account_id,mailbox_id,message_id,in_reply_to,from_email,to_email,subject,received_at,reply_id) VALUES(e.organization_id,e.connection_id,e.connection_version,e.provider_account_id,account.account_id,account.provider_mailbox_id,d->>'message_id',d->>'in_reply_to',sender,target,coalesce(d->>'subject',''),coalesce((d->>'received_at')::timestamptz,occurred),reply) RETURNING * INTO m;
 END IF;
 UPDATE public.winnr_ingestion_receipts SET message_record_id=m.id WHERE id=receipt.id;
 PERFORM public.winnr_correlate_ingested(e.organization_id,m.id);
 ELSIF kind='message.relayed' THEN
 IF length(coalesce(d->>'original_message_id','')) NOT BETWEEN 1 AND 998 OR length(coalesce(d->>'provider_message_id','')) NOT BETWEEN 1 AND 998 OR d->>'recipient' IS NULL THEN RAISE EXCEPTION 'ingestion:invalid'; END IF;
 INSERT INTO public.winnr_message_id_maps(organization_id,connection_id,provider_account_id,account_id,original_message_id,provider_message_id,recipient) VALUES(e.organization_id,e.connection_id,e.provider_account_id,account.account_id,d->>'original_message_id',d->>'provider_message_id',lower(d->>'recipient')) ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM public.winnr_message_id_maps WHERE organization_id=e.organization_id AND provider_account_id=e.provider_account_id AND account_id=account.account_id AND provider_message_id=d->>'provider_message_id' AND recipient=lower(d->>'recipient') AND original_message_id=d->>'original_message_id') THEN RAISE EXCEPTION 'ingestion:mapping_conflict'; END IF;
 FOR m IN SELECT * FROM public.winnr_ingested_messages WHERE organization_id=e.organization_id AND provider_account_id=e.provider_account_id AND account_id=account.account_id AND in_reply_to=d->>'provider_message_id' LOOP PERFORM public.winnr_correlate_ingested(e.organization_id,m.id); END LOOP;
 ELSIF kind IN('email.bounced','email.complained') THEN
 UPDATE public.campaign_leads cl SET status='bounced',next_send_at=NULL FROM public.campaigns ca,public.leads l WHERE cl.campaign_id=ca.id AND ca.organization_id=e.organization_id AND cl.lead_id=l.id AND l.organization_id=e.organization_id AND lower(btrim(l.email))=lower(d->>'recipient') AND cl.status IN('pending','in_progress');
 PERFORM public.record_outreach_suppression(e.organization_id,lower(d->>'recipient'),CASE WHEN kind='email.complained' THEN 'complaint' WHEN d->>'bounce_type'='soft' THEN 'soft_bounce' ELSE 'hard_bounce' END,'winnr_webhook',NULL,p_payload->>'id',CASE WHEN d->>'bounce_type'='soft' THEN now()+interval '7 days' ELSE NULL END,NULL);
 END IF;
 canonical:=jsonb_build_object('version',1,'organizationId',e.organization_id,'type',kind,'source',CASE WHEN p_channel='webhook' THEN 'winnr' ELSE 'winnr_api' END,'sourceEventId',p_payload->>'id','occurredAt',to_char(occurred AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'correlationId',NULL,'causationId',NULL,'subject',jsonb_build_object(),'data',jsonb_build_object('receiptId',receipt.id,'connectionId',e.connection_id));
 spine:=public.outreach_append_event(e.organization_id,canonical,CASE WHEN kind='email.received' THEN ARRAY['winnr.ingestion.body'] ELSE ARRAY[]::text[] END,p_fingerprint);
 IF spine->>'result' IN('conflict','fingerprint_mismatch') THEN RAISE EXCEPTION 'ingestion:spine_conflict'; END IF;
 RETURN jsonb_build_object('duplicate',false,'eventId',receipt.id);
END $$;
CREATE FUNCTION public.winnr_save_ingested_body(p_actor uuid,p_org uuid,p_message uuid,p_uid text,p_body text,p_optout boolean,p_connection uuid,p_version integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE m public.winnr_ingested_messages;
BEGIN
 PERFORM 1 FROM public.users WHERE id=p_actor AND organization_id=p_org AND role IN('owner','admin') FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ingestion:forbidden'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('email-dispatch:'||p_org::text,0));
 SELECT * INTO m FROM public.winnr_ingested_messages WHERE id=p_message AND organization_id=p_org FOR UPDATE;
 IF NOT FOUND OR m.connection_id IS DISTINCT FROM p_connection OR m.connection_version IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'ingestion:stale'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.winnr_connections WHERE id=m.connection_id AND organization_id=p_org AND version=m.connection_version AND provider_account_id=m.provider_account_id) OR NOT EXISTS(SELECT 1 FROM public.winnr_mailbox_credentials WHERE organization_id=p_org AND connection_id=m.connection_id AND connection_version=m.connection_version AND account_id=m.account_id AND provider_mailbox_id=m.mailbox_id AND lower(email)=m.to_email) OR length(p_uid) NOT BETWEEN 1 AND 998 OR octet_length(p_body)>1000000 THEN RAISE EXCEPTION 'ingestion:invalid'; END IF;
 IF m.body_status='ready' THEN IF NOT EXISTS(SELECT 1 FROM public.replies WHERE id=m.reply_id AND organization_id=p_org AND body_text=p_body) THEN RAISE EXCEPTION 'ingestion:body_conflict'; END IF; RETURN true; END IF;
 UPDATE public.replies SET body_text=p_body,category=CASE WHEN p_optout THEN 'unsubscribe' ELSE category END WHERE id=m.reply_id AND organization_id=p_org;
 UPDATE public.winnr_ingested_messages SET provider_uid=p_uid,body_status='ready' WHERE id=m.id;
 IF p_optout THEN PERFORM public.record_outreach_suppression(p_org,m.from_email,'unsubscribe','winnr_inbox',NULL,m.message_id,NULL,NULL); END IF;
 PERFORM public.winnr_correlate_ingested(p_org,m.id);
 RETURN true;
END $$;
DO $$ DECLARE f regprocedure; BEGIN FOR f IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('winnr_prepare_ingestion','winnr_correlate_ingested','winnr_receive_event','winnr_save_ingested_body','winnr_ingestion_is_ready','winnr_ingestion_retire_connection') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f); END LOOP; END $$;
COMMIT;
