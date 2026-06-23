
-- Enums
CREATE TYPE public.app_environment AS ENUM ('production','staging','development');
CREATE TYPE public.server_status AS ENUM ('active','dormant','offline');
CREATE TYPE public.event_type AS ENUM ('uncaught_exception','caught_exception','logged_error','logged_warning','http_error');
CREATE TYPE public.event_status AS ENUM ('active','resolved','hidden');
CREATE TYPE public.event_severity AS ENUM ('critical','error','warning','info');
CREATE TYPE public.log_level AS ENUM ('TRACE','DEBUG','INFO','WARN','ERROR');

-- applications
CREATE TABLE public.applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  environment public.app_environment NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.applications TO authenticated, anon;
GRANT ALL ON public.applications TO service_role;
ALTER TABLE public.applications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read applications" ON public.applications FOR SELECT USING (true);

-- servers
CREATE TABLE public.servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hostname text NOT NULL,
  agent_version text NOT NULL,
  status public.server_status NOT NULL DEFAULT 'active',
  last_seen timestamptz NOT NULL DEFAULT now(),
  application_id uuid NOT NULL REFERENCES public.applications(id) ON DELETE CASCADE
);
CREATE INDEX idx_servers_application ON public.servers(application_id);
GRANT SELECT ON public.servers TO authenticated, anon;
GRANT ALL ON public.servers TO service_role;
ALTER TABLE public.servers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read servers" ON public.servers FOR SELECT USING (true);

-- deployments
CREATE TABLE public.deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  application_id uuid NOT NULL REFERENCES public.applications(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_deployments_application ON public.deployments(application_id);
GRANT SELECT ON public.deployments TO authenticated, anon;
GRANT ALL ON public.deployments TO service_role;
ALTER TABLE public.deployments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read deployments" ON public.deployments FOR SELECT USING (true);

-- events
CREATE TABLE public.events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES public.applications(id) ON DELETE CASCADE,
  type public.event_type NOT NULL,
  name text NOT NULL,
  location text NOT NULL,
  introduced_by_deployment_id uuid REFERENCES public.deployments(id) ON DELETE SET NULL,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  status public.event_status NOT NULL DEFAULT 'active',
  severity public.event_severity NOT NULL DEFAULT 'error',
  hit_count integer NOT NULL DEFAULT 0
);
CREATE INDEX idx_events_application ON public.events(application_id);
CREATE INDEX idx_events_last_seen ON public.events(last_seen DESC);
CREATE INDEX idx_events_deployment ON public.events(introduced_by_deployment_id);
GRANT SELECT ON public.events TO authenticated, anon;
GRANT ALL ON public.events TO service_role;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read events" ON public.events FOR SELECT USING (true);

-- snapshots
CREATE TABLE public.snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  timestamp timestamptz NOT NULL DEFAULT now(),
  server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
  deployment_id uuid NOT NULL REFERENCES public.deployments(id) ON DELETE CASCADE,
  thread_name text NOT NULL,
  message text NOT NULL
);
CREATE INDEX idx_snapshots_event ON public.snapshots(event_id);
GRANT SELECT ON public.snapshots TO authenticated, anon;
GRANT ALL ON public.snapshots TO service_role;
ALTER TABLE public.snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read snapshots" ON public.snapshots FOR SELECT USING (true);

-- stack_frames
CREATE TABLE public.stack_frames (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL REFERENCES public.snapshots(id) ON DELETE CASCADE,
  frame_index integer NOT NULL,
  class_name text NOT NULL,
  method text NOT NULL,
  file text NOT NULL,
  line integer NOT NULL,
  in_user_code boolean NOT NULL DEFAULT false,
  source_snippet text
);
CREATE INDEX idx_frames_snapshot ON public.stack_frames(snapshot_id);
GRANT SELECT ON public.stack_frames TO authenticated, anon;
GRANT ALL ON public.stack_frames TO service_role;
ALTER TABLE public.stack_frames ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read stack_frames" ON public.stack_frames FOR SELECT USING (true);

-- variables
CREATE TABLE public.variables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  frame_id uuid NOT NULL REFERENCES public.stack_frames(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL,
  value text,
  redacted boolean NOT NULL DEFAULT false
);
CREATE INDEX idx_variables_frame ON public.variables(frame_id);
GRANT SELECT ON public.variables TO authenticated, anon;
GRANT ALL ON public.variables TO service_role;
ALTER TABLE public.variables ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read variables" ON public.variables FOR SELECT USING (true);

-- log_lines
CREATE TABLE public.log_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL REFERENCES public.snapshots(id) ON DELETE CASCADE,
  timestamp timestamptz NOT NULL DEFAULT now(),
  level public.log_level NOT NULL,
  message text NOT NULL
);
CREATE INDEX idx_log_lines_snapshot ON public.log_lines(snapshot_id);
GRANT SELECT ON public.log_lines TO authenticated, anon;
GRANT ALL ON public.log_lines TO service_role;
ALTER TABLE public.log_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read log_lines" ON public.log_lines FOR SELECT USING (true);

-- alert_rules
CREATE TABLE public.alert_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  condition text NOT NULL,
  target text NOT NULL,
  channel text NOT NULL,
  enabled boolean NOT NULL DEFAULT true
);
GRANT SELECT ON public.alert_rules TO authenticated, anon;
GRANT ALL ON public.alert_rules TO service_role;
ALTER TABLE public.alert_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read alert_rules" ON public.alert_rules FOR SELECT USING (true);

-- integrations
CREATE TABLE public.integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  status text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb
);
GRANT SELECT ON public.integrations TO authenticated, anon;
GRANT ALL ON public.integrations TO service_role;
ALTER TABLE public.integrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read integrations" ON public.integrations FOR SELECT USING (true);
