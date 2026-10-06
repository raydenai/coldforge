BEGIN;
UPDATE public.campaigns SET updated_at=clock_timestamp() WHERE updated_at IS NULL;

-- Only the service boundary may call this function. It rechecks the cookie-derived
-- user's current organization/role and serializes every mutation on the campaign.
-- Existing campaigns/settings and row-based sequence tables remain authoritative.
CREATE OR REPLACE FUNCTION public.campaign_core_mutate(
  p_actor uuid, p_org uuid, p_campaign uuid, p_operation text,
  p_payload jsonb DEFAULT '{}'::jsonb, p_expected_updated_at timestamptz DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  c public.campaigns%ROWTYPE;
  v_role text;
  v_settings jsonb;
  v_step jsonb;
  v_ids uuid[];
  v_lists uuid[];
  v_added integer := 0;
  v_next text;
  v_connection uuid;
BEGIN
  SELECT role INTO v_role FROM public.users WHERE id=p_actor AND organization_id=p_org FOR SHARE;
  IF v_role IS NULL OR v_role NOT IN ('owner','admin') THEN RAISE EXCEPTION 'campaign_core:forbidden'; END IF;
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'campaign_core:invalid_input'; END IF;
  IF p_operation='create' THEN
    IF length(trim(p_payload->>'name')) NOT BETWEEN 1 AND 200 OR p_payload->>'name' IS NULL THEN RAISE EXCEPTION 'campaign_core:invalid_input'; END IF;
    v_settings := coalesce(p_payload->'settings','{}'::jsonb);
    -- All configuration is in settings; there are no mailbox_ids/lead_list_ids/type columns.
    v_settings := v_settings || jsonb_build_object('type',coalesce(p_payload->>'type','cold_email'));
    INSERT INTO public.campaigns(organization_id,name,status,settings,stats)
      VALUES(p_org,trim(p_payload->>'name'),'draft',v_settings,'{}') RETURNING * INTO c;
  ELSE
    SELECT * INTO c FROM public.campaigns WHERE id=p_campaign AND organization_id=p_org FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'campaign_core:not_found'; END IF;
  END IF;

  IF p_operation IN ('settings','sequence') THEN
    IF c.status NOT IN ('draft','paused') THEN RAISE EXCEPTION 'campaign_core:not_editable'; END IF;
    IF p_expected_updated_at IS NULL OR c.updated_at IS DISTINCT FROM p_expected_updated_at THEN RAISE EXCEPTION 'campaign_core:stale_revision'; END IF;
  END IF;

  IF p_operation IN ('create','settings') THEN
    v_settings := coalesce(c.settings,'{}') || coalesce(p_payload->'settings','{}');
    IF jsonb_typeof(v_settings) <> 'object' THEN RAISE EXCEPTION 'campaign_core:invalid_input'; END IF;
    IF (coalesce(v_settings->>'sendingWindowStart','9'))::int >= (coalesce(v_settings->>'sendingWindowEnd','17'))::int THEN RAISE EXCEPTION 'campaign_core:invalid_input'; END IF;
    IF p_payload ? 'name' AND (length(trim(p_payload->>'name')) NOT BETWEEN 1 AND 200 OR p_payload->>'name' IS NULL) THEN RAISE EXCEPTION 'campaign_core:invalid_input'; END IF;
    IF p_payload ? 'type' THEN v_settings := v_settings || jsonb_build_object('type',p_payload->>'type'); END IF;
    IF p_payload ? 'leadListIds' THEN
      SELECT coalesce(array_agg(DISTINCT value::uuid),'{}') INTO v_lists FROM jsonb_array_elements_text(p_payload->'leadListIds');
      IF EXISTS(SELECT 1 FROM unnest(v_lists) requested(resource_id) WHERE NOT EXISTS(SELECT 1 FROM public.lead_lists l WHERE l.id=requested.resource_id AND l.organization_id=p_org)) THEN RAISE EXCEPTION 'campaign_core:foreign_resource'; END IF;
      v_settings := v_settings || jsonb_build_object('leadListIds',to_jsonb(v_lists));
    END IF;
    IF p_payload ? 'mailboxIds' THEN
      IF jsonb_array_length(p_payload->'mailboxIds') > 0 THEN
        -- The HTTP boundary verifies provider ownership; bind that observation to
        -- the same current organization connection while saving configuration.
        SELECT id INTO v_connection FROM public.winnr_connections
          WHERE id=(p_payload->>'senderConnectionId')::uuid AND organization_id=p_org
          AND version=(p_payload->>'senderConnectionVersion')::int FOR SHARE;
        IF NOT FOUND THEN RAISE EXCEPTION 'campaign_core:stale_sender_connection'; END IF;
      END IF;
      v_settings := v_settings || jsonb_build_object('mailboxIds',p_payload->'mailboxIds',
        'senderConnectionId',p_payload->'senderConnectionId','senderConnectionVersion',p_payload->'senderConnectionVersion');
    END IF;
    UPDATE public.campaigns SET name=coalesce(trim(p_payload->>'name'),name),settings=v_settings WHERE id=c.id;
  ELSIF p_operation='sequence' THEN
    IF jsonb_typeof(p_payload->'steps') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'steps')>100 THEN RAISE EXCEPTION 'campaign_core:invalid_input'; END IF;
    DELETE FROM public.campaign_sequences WHERE campaign_id=c.id;
    FOR v_step IN SELECT value FROM jsonb_array_elements(p_payload->'steps') LOOP
      IF (v_step->>'step_number')::int < 1 OR (v_step->>'step_number')::int > 100
        OR length(trim(v_step->>'subject')) NOT BETWEEN 1 AND 998 OR v_step->>'subject' IS NULL
        OR (coalesce(v_step->>'delay_days','0'))::int NOT BETWEEN 0 AND 365
        OR (coalesce(v_step->>'delay_hours','0'))::int NOT BETWEEN 0 AND 23
        OR coalesce(v_step->>'condition_type','always') NOT IN ('always','not_opened','not_replied','not_clicked')
        OR (coalesce(v_step->>'body_html','')='' AND coalesce(v_step->>'body_text','')='')
        THEN RAISE EXCEPTION 'campaign_core:invalid_input'; END IF;
      INSERT INTO public.campaign_sequences(campaign_id,step_number,subject,body_html,body_text,delay_days,delay_hours,condition_type)
        VALUES(c.id,(v_step->>'step_number')::int,v_step->>'subject',coalesce(v_step->>'body_html',''),v_step->>'body_text',
          coalesce((v_step->>'delay_days')::int,0),coalesce((v_step->>'delay_hours')::int,0),coalesce(v_step->>'condition_type','always'));
    END LOOP;
    IF EXISTS(SELECT step_number FROM public.campaign_sequences WHERE campaign_id=c.id GROUP BY step_number HAVING count(*)>1) THEN RAISE EXCEPTION 'campaign_core:invalid_input'; END IF;
  ELSIF p_operation='enroll' THEN
    IF c.status NOT IN ('draft','paused') THEN RAISE EXCEPTION 'campaign_core:not_editable'; END IF;
    SELECT coalesce(array_agg(DISTINCT value::uuid),'{}') INTO v_ids FROM jsonb_array_elements_text(coalesce(p_payload->'leadIds','[]'));
    SELECT coalesce(array_agg(DISTINCT value::uuid),'{}') INTO v_lists FROM jsonb_array_elements_text(coalesce(p_payload->'listIds','[]'));
    IF EXISTS(SELECT 1 FROM unnest(v_lists) requested(resource_id) WHERE NOT EXISTS(SELECT 1 FROM public.lead_lists l WHERE l.id=requested.resource_id AND l.organization_id=p_org))
      OR EXISTS(SELECT 1 FROM unnest(v_ids) requested(resource_id) WHERE NOT EXISTS(SELECT 1 FROM public.leads l WHERE l.id=requested.resource_id AND l.organization_id=p_org AND l.validation_status='valid')) THEN RAISE EXCEPTION 'campaign_core:foreign_resource'; END IF;
    INSERT INTO public.campaign_leads(campaign_id,lead_id,status,current_step)
      SELECT c.id,l.id,'pending',0 FROM public.leads l
      WHERE l.organization_id=p_org AND l.validation_status='valid' AND (l.id=ANY(v_ids) OR l.list_id=ANY(v_lists))
      AND NOT EXISTS(SELECT 1 FROM public.campaign_leads cl WHERE cl.campaign_id=c.id AND cl.lead_id=l.id);
    GET DIAGNOSTICS v_added=ROW_COUNT;
  ELSIF p_operation IN ('start','resume') THEN
    -- A status change cannot substitute for a durable dispatch/receipt ledger.
    RAISE EXCEPTION 'campaign_core:execution_not_ready';
  ELSIF p_operation IN ('pause','complete','archive') THEN
    IF p_operation='pause' AND c.status='active' THEN v_next := 'paused';
    ELSIF p_operation='complete' AND c.status IN ('active','paused') THEN v_next := 'completed';
    ELSIF p_operation='archive' AND c.status IN ('draft','paused','completed') THEN v_next := 'archived';
    ELSE RAISE EXCEPTION 'campaign_core:invalid_transition'; END IF;
    UPDATE public.campaigns SET status=v_next WHERE id=c.id;
  ELSIF p_operation='delete' THEN
    IF c.status='active' THEN RAISE EXCEPTION 'campaign_core:not_editable'; END IF;
    DELETE FROM public.campaigns WHERE id=c.id;
    RETURN jsonb_build_object('deleted',true);
  ELSE RAISE EXCEPTION 'campaign_core:invalid_input'; END IF;
  UPDATE public.campaigns SET updated_at=greatest(clock_timestamp(),coalesce(c.updated_at,clock_timestamp())+interval '1 microsecond') WHERE id=c.id RETURNING * INTO c;
  RETURN jsonb_build_object('campaign',to_jsonb(c),'added',v_added);
END;
$$;
REVOKE ALL ON FUNCTION public.campaign_core_mutate(uuid,uuid,uuid,text,jsonb,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.campaign_core_mutate(uuid,uuid,uuid,text,jsonb,timestamptz) TO service_role;
COMMIT;
