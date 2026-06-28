
CREATE TABLE public.redaction_rules (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('pattern','identifier')),
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.redaction_rules TO anon, authenticated;
GRANT ALL ON public.redaction_rules TO service_role;
ALTER TABLE public.redaction_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "open redaction_rules" ON public.redaction_rules FOR ALL USING (true) WITH CHECK (true);

CREATE TABLE public.api_tokens (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.api_tokens TO anon, authenticated;
GRANT ALL ON public.api_tokens TO service_role;
ALTER TABLE public.api_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "open api_tokens" ON public.api_tokens FOR ALL USING (true) WITH CHECK (true);

CREATE TABLE public.team_members (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member','viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.team_members TO anon, authenticated;
GRANT ALL ON public.team_members TO service_role;
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "open team_members" ON public.team_members FOR ALL USING (true) WITH CHECK (true);

CREATE TABLE public.workspace_settings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  install_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspace_settings TO anon, authenticated;
GRANT ALL ON public.workspace_settings TO service_role;
ALTER TABLE public.workspace_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "open workspace_settings" ON public.workspace_settings FOR ALL USING (true) WITH CHECK (true);

INSERT INTO public.workspace_settings (install_key) VALUES ('sk_install_' || replace(gen_random_uuid()::text, '-', ''));

INSERT INTO public.redaction_rules (kind, name, value, enabled) VALUES
  ('pattern','Credit card numbers','\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}',true),
  ('pattern','Email addresses','[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}',true),
  ('pattern','JWT tokens','eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+',true),
  ('identifier','Password fields','password',true),
  ('identifier','API keys','apiKey',true),
  ('identifier','Auth headers','authorization',false);

INSERT INTO public.team_members (email, name, role, status) VALUES
  ('alex@jvmscout.dev','Alex Chen','admin','active'),
  ('jordan@jvmscout.dev','Jordan Park','member','active'),
  ('sam@jvmscout.dev','Sam Rivera','viewer','active'),
  ('pat@jvmscout.dev','Pat Morgan','member','invited');
