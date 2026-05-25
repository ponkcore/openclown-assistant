import type {
  ActivityLevel,
  AuditEventType,
  CallType,
  ComponentId,
  MealDraftStatus,
  MealItemSource,
  MealSource,
  MetricOutcome,
  OnboardingStatus,
  PeriodType,
  RecommendationMode,
  Sex,
  WeightGoal,
} from "../shared/types.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type DbTimestamp = string;
export type BillingUnit = "token" | "audio_second" | "request";
export type TenantAuditRunType = "end_of_pilot_k4";
export type AccuracyLabeler = "po" | "partner" | "reviewer";
export type AccuracySampleReason = "random_pilot_sample" | "low_confidence_review" | "user_corrected";
export type MealDraftSource = MealSource;
export type ConfirmedMealSource = Exclude<MealSource, "correction">;

export interface UserRow {
  id: string;
  telegram_user_id: string;
  telegram_chat_id: string;
  language_code: string | null;
  timezone: string;
  onboarding_status: OnboardingStatus;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

export interface UserProfileRow {
  id: string;
  user_id: string;
  sex: Sex;
  age_years: number;
  height_cm: number;
  weight_kg: number;
  activity_level: ActivityLevel;
  weight_goal: WeightGoal;
  pace_kg_per_week: number | null;
  default_pace_applied: boolean;
  formula_version: string;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

export interface UserTargetRow {
  id: string;
  user_id: string;
  profile_id: string;
  bmr_kcal: number;
  activity_multiplier: number;
  maintenance_kcal: number;
  goal_delta_kcal_per_day: number;
  calories_kcal: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  formula_version: string;
  confirmed_at: DbTimestamp;
}

export interface SummaryScheduleRow {
  id: string;
  user_id: string;
  period_type: PeriodType;
  local_time: string;
  timezone: string;
  enabled: boolean;
  last_due_period_start: string | null;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

export interface OnboardingStateRow {
  id: string;
  user_id: string;
  current_step: string;
  partial_answers: JsonObject;
  version: number;
  updated_at: DbTimestamp;
}

export interface TranscriptRow {
  id: string;
  user_id: string;
  telegram_message_id: string;
  provider_alias: string;
  audio_duration_seconds: number;
  transcript_text: string;
  confidence: number | null;
  created_at: DbTimestamp;
}

export interface MealDraftRow {
  id: string;
  user_id: string;
  source: MealDraftSource;
  transcript_id: string | null;
  status: MealDraftStatus;
  normalized_input_text: string | null;
  photo_confidence_0_1: number | null;
  low_confidence_label_shown: boolean;
  total_calories_kcal: number | null;
  total_protein_g: number | null;
  total_fat_g: number | null;
  total_carbs_g: number | null;
  confidence_0_1: number | null;
  version: number;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

export interface MealDraftItemRow {
  id: string;
  user_id: string;
  draft_id: string;
  item_name_ru: string;
  portion_text_ru: string;
  portion_grams: number | null;
  calories_kcal: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  source: MealItemSource;
  source_ref: string | null;
  confidence_0_1: number | null;
}

export interface ConfirmedMealRow {
  id: string;
  user_id: string;
  source: ConfirmedMealSource;
  draft_id: string | null;
  meal_local_date: string;
  meal_logged_at: DbTimestamp;
  total_calories_kcal: number;
  total_protein_g: number;
  total_fat_g: number;
  total_carbs_g: number;
  manual_entry: boolean;
  deleted_at: DbTimestamp | null;
  version: number;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

export interface MealItemRow {
  id: string;
  user_id: string;
  meal_id: string;
  item_name_ru: string;
  portion_text_ru: string;
  portion_grams: number | null;
  calories_kcal: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  source: MealItemSource;
  source_ref: string | null;
}

export interface SummaryRecordRow {
  id: string;
  user_id: string;
  period_type: PeriodType;
  period_start_local_date: string;
  period_end_local_date: string;
  idempotency_key: string;
  totals: JsonObject;
  deltas_vs_target: JsonObject;
  previous_period_comparison: JsonObject | null;
  recommendation_text_ru: string | null;
  recommendation_mode: RecommendationMode;
  blocked_reason: string | null;
  delivered_at: DbTimestamp;
}

export interface AuditEventRow {
  id: string;
  user_id: string;
  event_type: AuditEventType;
  entity_type: string;
  entity_id: string | null;
  before_snapshot: JsonObject | null;
  after_snapshot: JsonObject | null;
  reason: string | null;
  created_at: DbTimestamp;
}

export interface MetricEventRow {
  id: string;
  user_id: string;
  request_id: string;
  event_name: string;
  component: ComponentId;
  latency_ms: number | null;
  outcome: MetricOutcome;
  metadata: JsonObject;
  created_at: DbTimestamp;
}

export interface CostEventRow {
  id: string;
  user_id: string;
  request_id: string;
  provider_alias: string;
  model_alias: string;
  call_type: CallType;
  estimated_cost_usd: number;
  actual_cost_usd: number | null;
  input_units: number | null;
  output_units: number | null;
  billing_unit: BillingUnit;
  created_at: DbTimestamp;
}

export interface MonthlySpendCounterRow {
  id: string;
  user_id: string;
  month_utc: string;
  estimated_spend_usd: number;
  actual_spend_usd: number | null;
  degrade_mode_enabled: boolean;
  po_alert_sent_at: DbTimestamp | null;
  updated_at: DbTimestamp;
}

export interface FoodLookupCacheRow {
  id: string;
  user_id: string;
  canonical_query_hash: string;
  canonical_food_name: string;
  source: Extract<MealItemSource, "open_food_facts" | "usda_fdc">;
  source_ref: string;
  per_100g_kbju: JsonObject;
  expires_at: DbTimestamp;
  created_at: DbTimestamp;
}

export interface TenantAuditRunRow {
  id: string;
  run_type: TenantAuditRunType;
  started_at: DbTimestamp;
  completed_at: DbTimestamp | null;
  checked_tables: string[];
  cross_user_reference_count: number;
  findings: JsonValue[];
}

export interface KbjuAccuracyLabelRow {
  id: string;
  user_id: string;
  meal_id: string;
  labeled_by: AccuracyLabeler;
  sample_reason: AccuracySampleReason;
  estimate_totals: JsonObject;
  ground_truth_totals: JsonObject;
  calorie_error_pct: number;
  protein_error_pct: number;
  fat_error_pct: number;
  carbs_error_pct: number;
  notes: string | null;
  created_at: DbTimestamp;
}

// ── C21 Modality Settings (TKT-028@0.1.0 / TKT-021@0.1.0 schema) ───────

/** Row shape from modality_settings table (TKT-021@0.1.0). */
export interface ModalitySettingsRow {
  user_id: string;
  water_on: boolean;
  sleep_on: boolean;
  workout_on: boolean;
  mood_on: boolean;
  updated_at: DbTimestamp;
}

/** Toggleable modality names per PRD-003@0.1.3 §3 NG6 (KBJU excluded). */
export type ModalityToggleName = "water" | "sleep" | "workout" | "mood";

/** Result of a setModalitySetting call — old and new values for audit. */
export interface ModalitySettingToggleResult {
  oldValue: boolean;
  newValue: boolean;
}

export interface CreateUserRequest {
  telegramUserId: string;
  telegramChatId: string;
  languageCode?: string;
  timezone: string;
  onboardingStatus?: OnboardingStatus;
}

export interface UpdateUserOnboardingStatusRequest {
  onboardingStatus: OnboardingStatus;
}

export interface CreateUserProfileRequest {
  sex: Sex;
  ageYears: number;
  heightCm: number;
  weightKg: number;
  activityLevel: ActivityLevel;
  weightGoal: WeightGoal;
  paceKgPerWeek?: number;
  defaultPaceApplied: boolean;
  formulaVersion: string;
}

export interface CreateUserTargetRequest {
  profileId: string;
  bmrKcal: number;
  activityMultiplier: number;
  maintenanceKcal: number;
  goalDeltaKcalPerDay: number;
  caloriesKcal: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
  formulaVersion: string;
  confirmedAt?: DbTimestamp;
}

export interface UpsertSummaryScheduleRequest {
  id?: string;
  periodType: PeriodType;
  localTime: string;
  timezone: string;
  enabled: boolean;
  lastDuePeriodStart?: string;
}

export interface UpsertOnboardingStateRequest {
  id?: string;
  currentStep: string;
  partialAnswers: JsonObject;
}

export interface UpdateOnboardingStateWithVersionRequest {
  id: string;
  expectedVersion: number;
  currentStep: string;
  partialAnswers: JsonObject;
}

export interface CreateTranscriptRequest {
  telegramMessageId: string;
  providerAlias: string;
  audioDurationSeconds: number;
  transcriptText: string;
  confidence?: number;
}

export interface CreateMealDraftRequest {
  source: MealDraftSource;
  status: MealDraftStatus;
  transcriptId?: string;
  normalizedInputText?: string;
  photoConfidence01?: number;
  lowConfidenceLabelShown: boolean;
  totalCaloriesKcal?: number;
  totalProteinG?: number;
  totalFatG?: number;
  totalCarbsG?: number;
  confidence01?: number;
}

export interface UpdateMealDraftWithVersionRequest {
  id: string;
  expectedVersion: number;
  status: MealDraftStatus;
  normalizedInputText?: string;
  totalCaloriesKcal?: number;
  totalProteinG?: number;
  totalFatG?: number;
  totalCarbsG?: number;
  confidence01?: number;
  lowConfidenceLabelShown: boolean;
}

export interface CreateMealDraftItemRequest {
  draftId: string;
  itemNameRu: string;
  portionTextRu: string;
  portionGrams?: number;
  caloriesKcal: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
  source: MealItemSource;
  sourceRef?: string;
  confidence01?: number;
}

export interface CreateConfirmedMealRequest {
  source: ConfirmedMealSource;
  draftId?: string;
  mealLocalDate: string;
  mealLoggedAt: DbTimestamp;
  totalCaloriesKcal: number;
  totalProteinG: number;
  totalFatG: number;
  totalCarbsG: number;
  manualEntry: boolean;
}

export interface ListConfirmedMealsRequest {
  mealLocalDateFrom?: string;
  mealLocalDateTo?: string;
  includeDeleted: boolean;
  limit: number;
  offset: number;
}

export interface SoftDeleteConfirmedMealWithVersionRequest {
  id: string;
  expectedVersion: number;
  deletedAt: DbTimestamp;
}

export interface CreateMealItemRequest {
  mealId: string;
  itemNameRu: string;
  portionTextRu: string;
  portionGrams?: number;
  caloriesKcal: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
  source: MealItemSource;
  sourceRef?: string;
}

export interface CreateSummaryRecordRequest {
  periodType: PeriodType;
  periodStartLocalDate: string;
  periodEndLocalDate: string;
  idempotencyKey: string;
  totals: JsonObject;
  deltasVsTarget: JsonObject;
  previousPeriodComparison?: JsonObject;
  recommendationTextRu?: string;
  recommendationMode: RecommendationMode;
  blockedReason?: string;
  deliveredAt: DbTimestamp;
}

export interface CreateAuditEventRequest {
  eventType: AuditEventType;
  entityType: string;
  entityId?: string;
  beforeSnapshot?: JsonObject;
  afterSnapshot?: JsonObject;
  reason?: string;
}

export interface CreateMetricEventRequest {
  requestId: string;
  eventName: string;
  component: ComponentId;
  latencyMs?: number;
  outcome: MetricOutcome;
  metadata?: JsonObject;
}

export interface CreateCostEventRequest {
  requestId: string;
  providerAlias: string;
  modelAlias: string;
  callType: CallType;
  estimatedCostUsd: number;
  actualCostUsd?: number;
  inputUnits?: number;
  outputUnits?: number;
  billingUnit: BillingUnit;
}

export interface UpsertMonthlySpendCounterRequest {
  monthUtc: string;
  estimatedSpendUsd: number;
  actualSpendUsd?: number;
  degradeModeEnabled: boolean;
  poAlertSentAt?: DbTimestamp;
}

export interface IncrementMonthlySpendRequest {
  deltaUsd: number;
  degradeModeEnabled?: boolean;
  poAlertSentAt?: DbTimestamp;
}

export interface UpsertFoodLookupCacheRequest {
  canonicalQueryHash: string;
  canonicalFoodName: string;
  source: Extract<MealItemSource, "open_food_facts" | "usda_fdc">;
  sourceRef: string;
  per100gKbju: JsonObject;
  expiresAt: DbTimestamp;
}

export interface CreateKbjuAccuracyLabelRequest {
  mealId: string;
  labeledBy: AccuracyLabeler;
  sampleReason: AccuracySampleReason;
  estimateTotals: JsonObject;
  groundTruthTotals: JsonObject;
  calorieErrorPct: number;
  proteinErrorPct: number;
  fatErrorPct: number;
  carbsErrorPct: number;
  notes?: string;
}

export interface TenantScopedRepository {
  createUser(userId: string, request: CreateUserRequest): Promise<UserRow>;
  getUser(userId: string): Promise<UserRow | null>;
  updateUserOnboardingStatus(userId: string, request: UpdateUserOnboardingStatusRequest): Promise<UserRow>;
  deleteUser(userId: string): Promise<boolean>;
  createUserProfile(userId: string, request: CreateUserProfileRequest): Promise<UserProfileRow>;
  getLatestUserProfile(userId: string): Promise<UserProfileRow | null>;
  createUserTarget(userId: string, request: CreateUserTargetRequest): Promise<UserTargetRow>;
  upsertSummarySchedule(userId: string, request: UpsertSummaryScheduleRequest): Promise<SummaryScheduleRow>;
  listSummarySchedules(userId: string): Promise<SummaryScheduleRow[]>;
  upsertOnboardingState(userId: string, request: UpsertOnboardingStateRequest): Promise<OnboardingStateRow>;
  updateOnboardingStateWithVersion(userId: string, request: UpdateOnboardingStateWithVersionRequest): Promise<OnboardingStateRow>;
  createTranscript(userId: string, request: CreateTranscriptRequest): Promise<TranscriptRow>;
  createMealDraft(userId: string, request: CreateMealDraftRequest): Promise<MealDraftRow>;
  updateMealDraftWithVersion(userId: string, request: UpdateMealDraftWithVersionRequest): Promise<MealDraftRow>;
  createMealDraftItem(userId: string, request: CreateMealDraftItemRequest): Promise<MealDraftItemRow>;
  deleteMealDraftItemsByDraftId(userId: string, draftId: string): Promise<number>;
  createConfirmedMeal(userId: string, request: CreateConfirmedMealRequest): Promise<ConfirmedMealRow>;
  listConfirmedMeals(userId: string, request: ListConfirmedMealsRequest): Promise<ConfirmedMealRow[]>;
  softDeleteConfirmedMealWithVersion(userId: string, request: SoftDeleteConfirmedMealWithVersionRequest): Promise<ConfirmedMealRow>;
  createMealItem(userId: string, request: CreateMealItemRequest): Promise<MealItemRow>;
  createSummaryRecord(userId: string, request: CreateSummaryRecordRequest): Promise<SummaryRecordRow>;
  createAuditEvent(userId: string, request: CreateAuditEventRequest): Promise<AuditEventRow>;
  createMetricEvent(userId: string, request: CreateMetricEventRequest): Promise<MetricEventRow>;
  createCostEvent(userId: string, request: CreateCostEventRequest): Promise<CostEventRow>;
  upsertMonthlySpendCounter(userId: string, request: UpsertMonthlySpendCounterRequest): Promise<MonthlySpendCounterRow>;
  getMonthlySpendCounter(userId: string, monthUtc: string): Promise<MonthlySpendCounterRow | null>;
  incrementMonthlySpend(userId: string, monthUtc: string, request: IncrementMonthlySpendRequest): Promise<MonthlySpendCounterRow>;
  upsertFoodLookupCache(userId: string, request: UpsertFoodLookupCacheRequest): Promise<FoodLookupCacheRow>;
  createKbjuAccuracyLabel(userId: string, request: CreateKbjuAccuracyLabelRequest): Promise<KbjuAccuracyLabelRow>;
  // ── C21 Modality Settings (TKT-028@0.1.0) ───────────────────────────────
  getModalitySettings(userId: string): Promise<ModalitySettingsRow | null>;
  setModalitySetting(userId: string, modality: ModalityToggleName, value: boolean): Promise<ModalitySettingToggleResult>;
  // ── C17 Water Events (TKT-029@0.1.0) ───────────────────────────────────
  insertWaterEvent(userId: string, source: WaterEventSource, volumeMl: number, rawText: string | null): Promise<{ event_id: string }>;
  // ── C20 Mood Events (TKT-031@0.1.0) ───────────────────────────────────
  insertMoodEvent(userId: string, source: MoodEventSource, score: number, commentText: string | null, inferredFromText: boolean, rawText: string | null): Promise<{ event_id: string }>;
}

export interface TenantStore extends TenantScopedRepository {
  withTransaction<T>(userId: string, action: (repository: TenantScopedRepository) => Promise<T>): Promise<T>;
}

// ── C17 Water Events (TKT-029@0.1.0 / TKT-021@0.1.0 schema) ────────────

/** Water event source per water_events table (TKT-021@0.1.0). */
export type WaterEventSource = "text" | "voice" | "keyboard";

/** Water event row shape from water_events table (TKT-021@0.1.0). */
export interface WaterEventRow {
  event_id: string;
  user_id: string;
  ts_utc: string;
  volume_ml: number;
  source: WaterEventSource;
  raw_text: string | null;
  created_at: string;
}

// ── C20 Mood Events (TKT-031@0.1.0 / TKT-021@0.1.0 schema) ────────────

/** Mood event source per mood_events table (TKT-021@0.1.0). */
export type MoodEventSource = "text" | "keyboard" | "inferred";

/** Mood event row shape from mood_events table (TKT-021@0.1.0). */
export interface MoodEventRow {
  event_id: string;
  user_id: string;
  ts_utc: string;
  score: number;
  comment_text: string | null;
  source: MoodEventSource;
  inferred_from_text: boolean;
  raw_text: string | null;
  created_at: string;
}
