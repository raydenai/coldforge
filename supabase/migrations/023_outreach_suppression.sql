-- Additive email-first opt-out contract. Historical workspace tables are unused.
BEGIN;
CREATE TABLE public.outreach_suppressions (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  normalized_email text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('hard_bounce','soft_bounce','complaint','unsubscribe','spam_trap','invalid','role_based','manual')),
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 100),
  notes text CHECK (length(notes) <= 1000),
  original_event_id text CHECK (length(original_event_id) <= 200),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, normalized_email),
  CHECK (normalized_email = lower(btrim(normalized_email)) AND length(normalized_email) <= 254 AND normalized_email ~ '^[a-z0-9.!#$%&*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$'),
  CHECK (reason = 'soft_bounce' OR expires_at IS NULL)
);
ALTER TABLE public.outreach_suppressions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.outreach_suppressions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.outreach_suppressions TO service_role;
CREATE FUNCTION public.record_outreach_suppression(p_organization_id uuid, p_email text, p_reason text, p_source text, p_notes text DEFAULT NULL, p_original_event_id text DEFAULT NULL, p_expires_at timestamptz DEFAULT NULL, p_lead_id uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE normalized text := lower(btrim(p_email)); lead_status text;
BEGIN
  IF p_organization_id IS NULL OR normalized IS NULL OR length(normalized) > 254 OR normalized !~ '^[a-z0-9.!#$%&*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$' OR normalized LIKE '%..%' OR split_part(normalized,'@',1) LIKE '.%' OR split_part(normalized,'@',1) LIKE '%.' THEN
    RAISE EXCEPTION 'invalid suppression input' USING ERRCODE='22023';
  END IF;
  IF p_lead_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.leads WHERE id=p_lead_id AND organization_id=p_organization_id AND lower(btrim(email))=normalized) THEN
    RAISE EXCEPTION 'lead does not belong to suppression organization' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.outreach_suppressions(organization_id,normalized_email,reason,source,notes,original_event_id,expires_at)
  VALUES(p_organization_id,normalized,p_reason,p_source,p_notes,p_original_event_id,p_expires_at)
  ON CONFLICT (organization_id,normalized_email) DO UPDATE SET
    reason=CASE WHEN outreach_suppressions.reason IN ('complaint','spam_trap','hard_bounce','invalid') THEN outreach_suppressions.reason WHEN EXCLUDED.reason='soft_bounce' AND outreach_suppressions.reason<>'soft_bounce' THEN outreach_suppressions.reason ELSE EXCLUDED.reason END,
    expires_at=CASE WHEN outreach_suppressions.reason<>'soft_bounce' THEN NULL ELSE EXCLUDED.expires_at END,
    updated_at=now();
  SELECT CASE WHEN reason IN ('complaint','spam_trap') THEN 'complained' WHEN reason IN ('hard_bounce','invalid') THEN 'bounced' ELSE 'unsubscribed' END INTO lead_status FROM public.outreach_suppressions WHERE organization_id=p_organization_id AND normalized_email=normalized AND reason<>'soft_bounce';
  IF lead_status IS NOT NULL THEN
    UPDATE public.leads SET status=lead_status,updated_at=now() WHERE organization_id=p_organization_id AND lower(btrim(email))=normalized;
    UPDATE public.campaign_leads cl SET status=CASE WHEN lead_status='bounced' THEN 'bounced' ELSE 'unsubscribed' END,next_send_at=NULL
    FROM public.campaigns c, public.leads l
    WHERE cl.campaign_id=c.id AND c.organization_id=p_organization_id AND cl.lead_id=l.id AND l.organization_id=p_organization_id AND lower(btrim(l.email))=normalized;
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.record_outreach_suppression(uuid,text,text,text,text,text,timestamptz,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_outreach_suppression(uuid,text,text,text,text,text,timestamptz,uuid) TO service_role;
COMMIT;
