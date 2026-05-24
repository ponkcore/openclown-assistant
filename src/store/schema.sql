-- Canonical C3 tenant-scoped PostgreSQL schema for TKT-002@0.1.0.
-- The application role (kbju_app) is deliberately non-owner and must not have BYPASSRLS.
-- The kbju_audit role is the only BYPASSRLS role and is reserved for the C11 K4 audit job via AUDIT_DB_URL.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kbju_app') THEN
    CREATE ROLE kbju_app LOGIN;
  END IF;
  ALTER ROLE kbju_app NOBYPASSRLS;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kbju_audit') THEN
    CREATE ROLE kbju_audit LOGIN BYPASSRLS;
  ELSE
    ALTER ROLE kbju_audit BYPASSRLS;
  END IF;

  IF pg_has_role('kbju_app', 'kbju_audit', 'member') THEN
    REVOKE kbju_audit FROM kbju_app;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'onboarding_status') THEN
    CREATE TYPE onboarding_status AS ENUM ('pending', 'awaiting_target_confirmation', 'active');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'sex') THEN
    CREATE TYPE sex AS ENUM ('male', 'female');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'activity_level') THEN
    CREATE TYPE activity_level AS ENUM ('sedentary', 'light', 'moderate', 'active', 'very_active');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'weight_goal') THEN
    CREATE TYPE weight_goal AS ENUM ('lose', 'maintain', 'gain');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'period_type') THEN
    CREATE TYPE period_type AS ENUM ('daily', 'weekly', 'monthly');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'meal_draft_source') THEN
    CREATE TYPE meal_draft_source AS ENUM ('text', 'voice', 'photo', 'manual', 'correction');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'confirmed_meal_source') THEN
    CREATE TYPE confirmed_meal_source AS ENUM ('text', 'voice', 'photo', 'manual');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'meal_draft_status') THEN
    CREATE TYPE meal_draft_status AS ENUM ('estimating', 'awaiting_confirmation', 'confirmed', 'abandoned', 'failed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'meal_item_source') THEN
    CREATE TYPE meal_item_source AS ENUM ('open_food_facts', 'usda_fdc', 'llm_fallback', 'manual');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'recommendation_mode') THEN
    CREATE TYPE recommendation_mode AS ENUM ('llm_validated', 'deterministic_fallback', 'no_meal_nudge');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'audit_event_type') THEN
    CREATE TYPE audit_event_type AS ENUM ('meal_created', 'meal_edited', 'meal_deleted', 'profile_created', 'right_to_delete_confirmed', 'right_to_delete_completed', 'summary_blocked');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'component_id') THEN
    CREATE TYPE component_id AS ENUM ('C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'metric_outcome') THEN
    CREATE TYPE metric_outcome AS ENUM ('success', 'user_fallback', 'provider_failure', 'validation_blocked', 'budget_blocked');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'call_type') THEN
    CREATE TYPE call_type AS ENUM ('text_llm', 'vision_llm', 'transcription', 'lookup');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'billing_unit') THEN
    CREATE TYPE billing_unit AS ENUM ('token', 'audio_second', 'request');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tenant_audit_run_type') THEN
    CREATE TYPE tenant_audit_run_type AS ENUM ('end_of_pilot_k4');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'accuracy_labeler') THEN
    CREATE TYPE accuracy_labeler AS ENUM ('po', 'partner', 'reviewer');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'accuracy_sample_reason') THEN
    CREATE TYPE accuracy_sample_reason AS ENUM ('random_pilot_sample', 'low_confidence_review', 'user_corrected');
  END IF;
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

CREATE TABLE IF NOT EXISTS schema_migrations (
  component TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id TEXT NOT NULL UNIQUE,
  telegram_chat_id TEXT NOT NULL,
  language_code TEXT,
  timezone TEXT NOT NULL,
  onboarding_status onboarding_status NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sex sex NOT NULL,
  age_years INTEGER NOT NULL CHECK (age_years BETWEEN 10 AND 120),
  height_cm NUMERIC(5,2) NOT NULL CHECK (height_cm BETWEEN 100 AND 250),
  weight_kg NUMERIC(5,2) NOT NULL CHECK (weight_kg BETWEEN 20 AND 300),
  activity_level activity_level NOT NULL,
  weight_goal weight_goal NOT NULL,
  pace_kg_per_week NUMERIC(3,2) CHECK (pace_kg_per_week IS NULL OR pace_kg_per_week BETWEEN 0.10 AND 2.00),
  default_pace_applied BOOLEAN NOT NULL,
  formula_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id)
);

CREATE TABLE IF NOT EXISTS user_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL,
  bmr_kcal INTEGER NOT NULL,
  activity_multiplier NUMERIC(4,3) NOT NULL,
  maintenance_kcal INTEGER NOT NULL,
  goal_delta_kcal_per_day INTEGER NOT NULL,
  calories_kcal INTEGER NOT NULL,
  protein_g INTEGER NOT NULL,
  fat_g INTEGER NOT NULL,
  carbs_g INTEGER NOT NULL,
  formula_version TEXT NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  CONSTRAINT user_targets_profile_owner_fk FOREIGN KEY (user_id, profile_id) REFERENCES user_profiles(user_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS summary_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_type period_type NOT NULL,
  local_time TEXT NOT NULL,
  timezone TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_due_period_start DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id)
);

CREATE TABLE IF NOT EXISTS onboarding_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  current_step TEXT NOT NULL,
  partial_answers JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(partial_answers) = 'object'),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id)
);

CREATE TABLE IF NOT EXISTS transcripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  telegram_message_id TEXT NOT NULL,
  provider_alias TEXT NOT NULL,
  audio_duration_seconds INTEGER NOT NULL CHECK (audio_duration_seconds > 0 AND audio_duration_seconds <= 15),
  transcript_text TEXT NOT NULL,
  confidence NUMERIC(4,3) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id)
);

CREATE TABLE IF NOT EXISTS meal_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source meal_draft_source NOT NULL,
  transcript_id UUID,
  status meal_draft_status NOT NULL,
  normalized_input_text TEXT,
  photo_confidence_0_1 NUMERIC(4,3) CHECK (photo_confidence_0_1 IS NULL OR photo_confidence_0_1 BETWEEN 0 AND 1),
  low_confidence_label_shown BOOLEAN NOT NULL DEFAULT false,
  total_calories_kcal INTEGER,
  total_protein_g NUMERIC(8,2),
  total_fat_g NUMERIC(8,2),
  total_carbs_g NUMERIC(8,2),
  confidence_0_1 NUMERIC(4,3) CHECK (confidence_0_1 IS NULL OR confidence_0_1 BETWEEN 0 AND 1),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  CONSTRAINT meal_drafts_transcript_owner_fk FOREIGN KEY (user_id, transcript_id) REFERENCES transcripts(user_id, id)
);

CREATE TABLE IF NOT EXISTS meal_draft_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  draft_id UUID NOT NULL,
  item_name_ru TEXT NOT NULL,
  portion_text_ru TEXT NOT NULL,
  portion_grams NUMERIC(8,2),
  calories_kcal INTEGER NOT NULL,
  protein_g NUMERIC(8,2) NOT NULL,
  fat_g NUMERIC(8,2) NOT NULL,
  carbs_g NUMERIC(8,2) NOT NULL,
  source meal_item_source NOT NULL,
  source_ref TEXT,
  confidence_0_1 NUMERIC(4,3) CHECK (confidence_0_1 IS NULL OR confidence_0_1 BETWEEN 0 AND 1),
  UNIQUE (user_id, id),
  CONSTRAINT meal_draft_items_draft_owner_fk FOREIGN KEY (user_id, draft_id) REFERENCES meal_drafts(user_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS confirmed_meals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source confirmed_meal_source NOT NULL,
  draft_id UUID,
  meal_local_date DATE NOT NULL,
  meal_logged_at TIMESTAMPTZ NOT NULL,
  total_calories_kcal INTEGER NOT NULL,
  total_protein_g NUMERIC(8,2) NOT NULL,
  total_fat_g NUMERIC(8,2) NOT NULL,
  total_carbs_g NUMERIC(8,2) NOT NULL,
  manual_entry BOOLEAN NOT NULL DEFAULT false,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  CONSTRAINT confirmed_meals_draft_owner_fk FOREIGN KEY (user_id, draft_id) REFERENCES meal_drafts(user_id, id)
);

CREATE TABLE IF NOT EXISTS meal_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  meal_id UUID NOT NULL,
  item_name_ru TEXT NOT NULL,
  portion_text_ru TEXT NOT NULL,
  portion_grams NUMERIC(8,2),
  calories_kcal INTEGER NOT NULL,
  protein_g NUMERIC(8,2) NOT NULL,
  fat_g NUMERIC(8,2) NOT NULL,
  carbs_g NUMERIC(8,2) NOT NULL,
  source meal_item_source NOT NULL,
  source_ref TEXT,
  UNIQUE (user_id, id),
  CONSTRAINT meal_items_meal_owner_fk FOREIGN KEY (user_id, meal_id) REFERENCES confirmed_meals(user_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS summary_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_type period_type NOT NULL,
  period_start_local_date DATE NOT NULL,
  period_end_local_date DATE NOT NULL,
  idempotency_key TEXT NOT NULL,
  totals JSONB NOT NULL CHECK (jsonb_typeof(totals) = 'object'),
  deltas_vs_target JSONB NOT NULL CHECK (jsonb_typeof(deltas_vs_target) = 'object'),
  previous_period_comparison JSONB CHECK (previous_period_comparison IS NULL OR jsonb_typeof(previous_period_comparison) = 'object'),
  recommendation_text_ru TEXT,
  recommendation_mode recommendation_mode NOT NULL,
  blocked_reason TEXT,
  delivered_at TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, id),
  UNIQUE (user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type audit_event_type NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  before_snapshot JSONB CHECK (before_snapshot IS NULL OR jsonb_typeof(before_snapshot) = 'object'),
  after_snapshot JSONB CHECK (after_snapshot IS NULL OR jsonb_typeof(after_snapshot) = 'object'),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id)
);

CREATE TABLE IF NOT EXISTS metric_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  component component_id NOT NULL,
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  outcome metric_outcome NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id)
);

CREATE TABLE IF NOT EXISTS cost_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  provider_alias TEXT NOT NULL,
  model_alias TEXT NOT NULL,
  call_type call_type NOT NULL,
  estimated_cost_usd NUMERIC(12,6) NOT NULL CHECK (estimated_cost_usd >= 0),
  actual_cost_usd NUMERIC(12,6) CHECK (actual_cost_usd IS NULL OR actual_cost_usd >= 0),
  input_units INTEGER CHECK (input_units IS NULL OR input_units >= 0),
  output_units INTEGER CHECK (output_units IS NULL OR output_units >= 0),
  billing_unit billing_unit NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id)
);

CREATE TABLE IF NOT EXISTS monthly_spend_counters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month_utc TEXT NOT NULL,
  estimated_spend_usd NUMERIC(12,6) NOT NULL CHECK (estimated_spend_usd >= 0),
  actual_spend_usd NUMERIC(12,6) CHECK (actual_spend_usd IS NULL OR actual_spend_usd >= 0),
  degrade_mode_enabled BOOLEAN NOT NULL DEFAULT false,
  po_alert_sent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  UNIQUE (user_id, month_utc)
);

CREATE TABLE IF NOT EXISTS food_lookup_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  canonical_query_hash TEXT NOT NULL,
  canonical_food_name TEXT NOT NULL,
  source meal_item_source NOT NULL CHECK (source IN ('open_food_facts', 'usda_fdc')),
  source_ref TEXT NOT NULL,
  per_100g_kbju JSONB NOT NULL CHECK (jsonb_typeof(per_100g_kbju) = 'object'),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  UNIQUE (user_id, canonical_query_hash, source)
);

CREATE TABLE IF NOT EXISTS tenant_audit_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_type tenant_audit_run_type NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  checked_tables TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  cross_user_reference_count INTEGER NOT NULL DEFAULT 0 CHECK (cross_user_reference_count >= 0),
  findings JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(findings) = 'array')
);

CREATE TABLE IF NOT EXISTS kbju_accuracy_labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  meal_id UUID NOT NULL,
  labeled_by accuracy_labeler NOT NULL,
  sample_reason accuracy_sample_reason NOT NULL,
  estimate_totals JSONB NOT NULL CHECK (jsonb_typeof(estimate_totals) = 'object'),
  ground_truth_totals JSONB NOT NULL CHECK (jsonb_typeof(ground_truth_totals) = 'object'),
  calorie_error_pct NUMERIC(8,4) NOT NULL,
  protein_error_pct NUMERIC(8,4) NOT NULL,
  fat_error_pct NUMERIC(8,4) NOT NULL,
  carbs_error_pct NUMERIC(8,4) NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  CONSTRAINT kbju_accuracy_labels_meal_owner_fk FOREIGN KEY (user_id, meal_id) REFERENCES confirmed_meals(user_id, id) ON DELETE CASCADE
);

-- PRD-003@0.1.3 modality tables per ARCH-001@0.6.1 §5.3

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

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE summary_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE meal_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE meal_draft_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE confirmed_meals ENABLE ROW LEVEL SECURITY;
ALTER TABLE meal_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE summary_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE monthly_spend_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_lookup_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE kbju_accuracy_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE water_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE sleep_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE sleep_pairing_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE workout_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mood_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE modality_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE modality_settings_audit ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'users' AND policyname = 'users_id_isolation') THEN
    CREATE POLICY users_id_isolation ON users FOR ALL USING (current_setting('app.user_id')::uuid = id) WITH CHECK (current_setting('app.user_id')::uuid = id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_profiles' AND policyname = 'user_profiles_user_id_isolation') THEN
    CREATE POLICY user_profiles_user_id_isolation ON user_profiles FOR ALL USING (current_setting('app.user_id')::uuid = user_id) WITH CHECK (current_setting('app.user_id')::uuid = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_targets' AND policyname = 'user_targets_user_id_isolation') THEN
    CREATE POLICY user_targets_user_id_isolation ON user_targets FOR ALL USING (current_setting('app.user_id')::uuid = user_id) WITH CHECK (current_setting('app.user_id')::uuid = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'summary_schedules' AND policyname = 'summary_schedules_user_id_isolation') THEN
    CREATE POLICY summary_schedules_user_id_isolation ON summary_schedules FOR ALL USING (current_setting('app.user_id')::uuid = user_id) WITH CHECK (current_setting('app.user_id')::uuid = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'onboarding_states' AND policyname = 'onboarding_states_user_id_isolation') THEN
    CREATE POLICY onboarding_states_user_id_isolation ON onboarding_states FOR ALL USING (current_setting('app.user_id')::uuid = user_id) WITH CHECK (current_setting('app.user_id')::uuid = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'transcripts' AND policyname = 'transcripts_user_id_isolation') THEN
    CREATE POLICY transcripts_user_id_isolation ON transcripts FOR ALL USING (current_setting('app.user_id')::uuid = user_id) WITH CHECK (current_setting('app.user_id')::uuid = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'meal_drafts' AND policyname = 'meal_drafts_user_id_isolation') THEN
    CREATE POLICY meal_drafts_user_id_isolation ON meal_drafts FOR ALL USING (current_setting('app.user_id')::uuid = user_id) WITH CHECK (current_setting('app.user_id')::uuid = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'meal_draft_items' AND policyname = 'meal_draft_items_user_id_isolation') THEN
    CREATE POLICY meal_draft_items_user_id_isolation ON meal_draft_items FOR ALL USING (current_setting('app.user_id')::uuid = user_id) WITH CHECK (current_setting('app.user_id')::uuid = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'confirmed_meals' AND policyname = 'confirmed_meals_user_id_isolation') THEN
    CREATE POLICY confirmed_meals_user_id_isolation ON confirmed_meals FOR ALL USING (current_setting('app.user_id')::uuid = user_id) WITH CHECK (current_setting('app.user_id')::uuid = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'meal_items' AND policyname = 'meal_items_user_id_isolation') THEN
    CREATE POLICY meal_items_user_id_isolation ON meal_items FOR ALL USING (current_setting('app.user_id')::uuid = user_id) WITH CHECK (current_setting('app.user_id')::uuid = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'summary_records' AND policyname = 'summary_records_user_id_isolation') THEN
    CREATE POLICY summary_records_user_id_isolation ON summary_records FOR ALL USING (current_setting('app.user_id')::uuid = user_id) WITH CHECK (current_setting('app.user_id')::uuid = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'audit_events' AND policyname = 'audit_events_user_id_isolation') THEN
    CREATE POLICY audit_events_user_id_isolation ON audit_events FOR ALL USING (current_setting('app.user_id')::uuid = user_id) WITH CHECK (current_setting('app.user_id')::uuid = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'metric_events' AND policyname = 'metric_events_user_id_isolation') THEN
    CREATE POLICY metric_events_user_id_isolation ON metric_events FOR ALL USING (current_setting('app.user_id')::uuid = user_id) WITH CHECK (current_setting('app.user_id')::uuid = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'cost_events' AND policyname = 'cost_events_user_id_isolation') THEN
    CREATE POLICY cost_events_user_id_isolation ON cost_events FOR ALL USING (current_setting('app.user_id')::uuid = user_id) WITH CHECK (current_setting('app.user_id')::uuid = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'monthly_spend_counters' AND policyname = 'monthly_spend_counters_user_id_isolation') THEN
    CREATE POLICY monthly_spend_counters_user_id_isolation ON monthly_spend_counters FOR ALL USING (current_setting('app.user_id')::uuid = user_id) WITH CHECK (current_setting('app.user_id')::uuid = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'food_lookup_cache' AND policyname = 'food_lookup_cache_user_id_isolation') THEN
    CREATE POLICY food_lookup_cache_user_id_isolation ON food_lookup_cache FOR ALL USING (current_setting('app.user_id')::uuid = user_id) WITH CHECK (current_setting('app.user_id')::uuid = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'kbju_accuracy_labels' AND policyname = 'kbju_accuracy_labels_user_id_isolation') THEN
    CREATE POLICY kbju_accuracy_labels_user_id_isolation ON kbju_accuracy_labels FOR ALL USING (current_setting('app.user_id')::uuid = user_id) WITH CHECK (current_setting('app.user_id')::uuid = user_id);
  END IF;
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

GRANT USAGE ON SCHEMA public TO kbju_app, kbju_audit;
GRANT SELECT ON schema_migrations TO kbju_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, user_profiles, user_targets, summary_schedules, onboarding_states, transcripts, meal_drafts, meal_draft_items, confirmed_meals, meal_items, summary_records, audit_events, metric_events, cost_events, monthly_spend_counters, food_lookup_cache, kbju_accuracy_labels, water_events, sleep_records, sleep_pairing_state, workout_events, mood_events, modality_settings, modality_settings_audit TO kbju_app;
GRANT SELECT ON users, user_profiles, user_targets, summary_schedules, onboarding_states, transcripts, meal_drafts, meal_draft_items, confirmed_meals, meal_items, summary_records, audit_events, metric_events, cost_events, monthly_spend_counters, food_lookup_cache, kbju_accuracy_labels, water_events, sleep_records, sleep_pairing_state, workout_events, mood_events, modality_settings, modality_settings_audit TO kbju_audit;
GRANT SELECT, INSERT, UPDATE ON tenant_audit_runs TO kbju_audit;
REVOKE ALL ON tenant_audit_runs FROM kbju_app;

INSERT INTO schema_migrations (component, version, applied_at)
VALUES ('C3 Tenant-Scoped Store', 'TKT-021@0.1.0', now())
ON CONFLICT (component) DO UPDATE SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at;
