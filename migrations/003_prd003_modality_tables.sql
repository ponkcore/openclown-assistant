-- PRD-003@0.1.3 modality data model tables per ARCH-001@0.6.1 §5.3.
-- Seven new tables: water_events, sleep_records, sleep_pairing_state,
--   workout_events, mood_events, modality_settings, modality_settings_audit.
-- Idempotent (IF NOT EXISTS). RLS enabled per ADR-001@0.1.0 pattern.
-- Indexes per ADR-017@0.1.0 §Decision + ARCH-001@0.6.1 §5.3.

-- New enum types for modality tables
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'water_event_source') THEN
    CREATE TYPE water_event_source AS ENUM ('text', 'voice', 'keyboard');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workout_type') THEN
    CREATE TYPE workout_type AS ENUM ('strength', 'running', 'cycling', 'swimming', 'walking', 'yoga', 'hiit', 'other');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workout_event_source') THEN
    CREATE TYPE workout_event_source AS ENUM ('text', 'voice', 'photo');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'mood_event_source') THEN
    CREATE TYPE mood_event_source AS ENUM ('keyboard', 'text', 'voice', 'inferred');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'modality_name') THEN
    CREATE TYPE modality_name AS ENUM ('water', 'sleep', 'workout', 'mood');
  END IF;
END $$;

-- water_events (ARCH-001@0.6.1 §5.3 / PRD-003@0.1.3 §2 G1)
CREATE TABLE IF NOT EXISTS water_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts_utc TIMESTAMPTZ NOT NULL,
  volume_ml INTEGER NOT NULL CHECK (volume_ml > 0 AND volume_ml <= 5000),
  source water_event_source NOT NULL,
  raw_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS water_events_user_ts_idx ON water_events (user_id, ts_utc DESC);

-- sleep_records (ARCH-001@0.6.1 §5.3 / ADR-017@0.1.0 §Decision)
CREATE TABLE IF NOT EXISTS sleep_records (
  record_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_ts_utc TIMESTAMPTZ NOT NULL,
  end_ts_utc TIMESTAMPTZ NOT NULL,
  duration_min INTEGER NOT NULL CHECK (duration_min >= 30 AND duration_min <= 1440),
  attribution_date_local DATE NOT NULL,
  attribution_tz TEXT NOT NULL,
  is_nap BOOLEAN NOT NULL,
  is_paired_origin BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Mandatory index per ADR-017@0.1.0 §Decision
CREATE INDEX IF NOT EXISTS sleep_records_user_date_nap_idx ON sleep_records (user_id, attribution_date_local, is_nap);

-- sleep_pairing_state (ARCH-001@0.6.1 §5.3 / ADR-017@0.1.0 §Decision)
-- One outstanding "лёг" per user max; PK is user_id
CREATE TABLE IF NOT EXISTS sleep_pairing_state (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  leg_event_ts_utc TIMESTAMPTZ NOT NULL,
  expires_at_utc TIMESTAMPTZ NOT NULL
);

-- workout_events (ARCH-001@0.6.1 §5.3 / PRD-003@0.1.3 §2 G3)
CREATE TABLE IF NOT EXISTS workout_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts_utc TIMESTAMPTZ NOT NULL,
  type workout_type NOT NULL,
  duration_min INTEGER CHECK (duration_min IS NULL OR duration_min > 0),
  distance_km NUMERIC(6,2) CHECK (distance_km IS NULL OR distance_km > 0),
  weight_kg NUMERIC(6,2),
  reps INTEGER,
  sets INTEGER,
  source workout_event_source NOT NULL,
  raw_workout_text TEXT,
  raw_description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workout_events_user_ts_idx ON workout_events (user_id, ts_utc DESC);

-- mood_events (ARCH-001@0.6.1 §5.3 / PRD-003@0.1.3 §2 G4)
CREATE TABLE IF NOT EXISTS mood_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts_utc TIMESTAMPTZ NOT NULL,
  score INTEGER NOT NULL CHECK (score >= 1 AND score <= 10),
  comment_text TEXT CHECK (comment_text IS NULL OR length(comment_text) <= 280),
  source mood_event_source NOT NULL,
  inferred_from_text BOOLEAN NOT NULL DEFAULT false,
  raw_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mood_events_user_ts_idx ON mood_events (user_id, ts_utc DESC);

-- modality_settings (ARCH-001@0.6.1 §5.3 / PRD-003@0.1.3 §2 G5)
-- One row per user; PK is user_id
CREATE TABLE IF NOT EXISTS modality_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  water_on BOOLEAN NOT NULL DEFAULT true,
  sleep_on BOOLEAN NOT NULL DEFAULT true,
  workout_on BOOLEAN NOT NULL DEFAULT true,
  mood_on BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- modality_settings_audit (ARCH-001@0.6.1 §5.3 / PRD-003@0.1.3 §2 G5)
CREATE TABLE IF NOT EXISTS modality_settings_audit (
  audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  modality modality_name NOT NULL,
  old_value BOOLEAN NOT NULL,
  new_value BOOLEAN NOT NULL,
  ts_utc TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS modality_settings_audit_user_ts_idx ON modality_settings_audit (user_id, ts_utc DESC);

-- RLS: Enable row-level security on all seven new tables per ADR-001@0.1.0 pattern
ALTER TABLE water_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE sleep_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE sleep_pairing_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE workout_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mood_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE modality_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE modality_settings_audit ENABLE ROW LEVEL SECURITY;

-- RLS policies: per-user_id isolation matching ADR-001@0.1.0 pattern
-- (current_setting('app.user_id')::uuid = user_id) FOR ALL USING + WITH CHECK
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'water_events' AND policyname = 'water_events_user_id_isolation') THEN
    CREATE POLICY water_events_user_id_isolation ON water_events FOR ALL USING (current_setting('app.user_id')::uuid = user_id) WITH CHECK (current_setting('app.user_id')::uuid = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sleep_records' AND policyname = 'sleep_records_user_id_isolation') THEN
    CREATE POLICY sleep_records_user_id_isolation ON sleep_records FOR ALL USING (current_setting('app.user_id')::uuid = user_id) WITH CHECK (current_setting('app.user_id')::uuid = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sleep_pairing_state' AND policyname = 'sleep_pairing_state_user_id_isolation') THEN
    CREATE POLICY sleep_pairing_state_user_id_isolation ON sleep_pairing_state FOR ALL USING (current_setting('app.user_id')::uuid = user_id) WITH CHECK (current_setting('app.user_id')::uuid = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'workout_events' AND policyname = 'workout_events_user_id_isolation') THEN
    CREATE POLICY workout_events_user_id_isolation ON workout_events FOR ALL USING (current_setting('app.user_id')::uuid = user_id) WITH CHECK (current_setting('app.user_id')::uuid = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'mood_events' AND policyname = 'mood_events_user_id_isolation') THEN
    CREATE POLICY mood_events_user_id_isolation ON mood_events FOR ALL USING (current_setting('app.user_id')::uuid = user_id) WITH CHECK (current_setting('app.user_id')::uuid = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'modality_settings' AND policyname = 'modality_settings_user_id_isolation') THEN
    CREATE POLICY modality_settings_user_id_isolation ON modality_settings FOR ALL USING (current_setting('app.user_id')::uuid = user_id) WITH CHECK (current_setting('app.user_id')::uuid = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'modality_settings_audit' AND policyname = 'modality_settings_audit_user_id_isolation') THEN
    CREATE POLICY modality_settings_audit_user_id_isolation ON modality_settings_audit FOR ALL USING (current_setting('app.user_id')::uuid = user_id) WITH CHECK (current_setting('app.user_id')::uuid = user_id);
  END IF;
END $$;

-- Grants: app role gets full CRUD, audit role gets SELECT
GRANT SELECT, INSERT, UPDATE, DELETE ON water_events, sleep_records, sleep_pairing_state, workout_events, mood_events, modality_settings, modality_settings_audit TO kbju_app;
GRANT SELECT ON water_events, sleep_records, sleep_pairing_state, workout_events, mood_events, modality_settings, modality_settings_audit TO kbju_audit;
