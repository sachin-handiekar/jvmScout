
ALTER TABLE public.alert_rules
  ADD COLUMN IF NOT EXISTS trigger_type text NOT NULL DEFAULT 'new_event',
  ADD COLUMN IF NOT EXISTS application_id uuid REFERENCES public.applications(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS deployment_id uuid REFERENCES public.deployments(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_triggered_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS alert_rules_application_id_idx ON public.alert_rules(application_id);
CREATE INDEX IF NOT EXISTS alert_rules_deployment_id_idx ON public.alert_rules(deployment_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.alert_rules TO anon, authenticated;
GRANT ALL ON public.alert_rules TO service_role;

DROP POLICY IF EXISTS "manage alert_rules" ON public.alert_rules;
CREATE POLICY "manage alert_rules"
  ON public.alert_rules
  FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS update_alert_rules_updated_at ON public.alert_rules;
CREATE TRIGGER update_alert_rules_updated_at
  BEFORE UPDATE ON public.alert_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
