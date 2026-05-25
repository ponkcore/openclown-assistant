import { types as pgTypes } from "pg";
import type { Pool, QueryResult, QueryResultRow } from "pg";
import type {
  AuditEventRow,
  ConfirmedMealRow,
  CostEventRow,
  CreateAuditEventRequest,
  CreateConfirmedMealRequest,
  CreateCostEventRequest,
  CreateKbjuAccuracyLabelRequest,
  CreateMealDraftItemRequest,
  CreateMealDraftRequest,
  CreateMealItemRequest,
  CreateMetricEventRequest,
  CreateSummaryRecordRequest,
  CreateTranscriptRequest,
  CreateUserProfileRequest,
  CreateUserRequest,
  CreateUserTargetRequest,
  FoodLookupCacheRow,
  KbjuAccuracyLabelRow,
  ListConfirmedMealsRequest,
  MealDraftItemRow,
  MealDraftRow,
  MealItemRow,
  MetricEventRow,
  MonthlySpendCounterRow,
  OnboardingStateRow,
  SoftDeleteConfirmedMealWithVersionRequest,
  SummaryRecordRow,
  SummaryScheduleRow,
  TenantScopedRepository,
  TenantStore,
  TranscriptRow,
  UpdateMealDraftWithVersionRequest,
  UpdateOnboardingStateWithVersionRequest,
  UpdateUserOnboardingStatusRequest,
  UpsertFoodLookupCacheRequest,
  UpsertMonthlySpendCounterRequest,
  UpsertOnboardingStateRequest,
  UpsertSummaryScheduleRequest,
  IncrementMonthlySpendRequest,
  ModalitySettingsRow,
  ModalityToggleName,
  ModalitySettingToggleResult,
  WaterEventSource,
  WaterEventRow,
  MoodEventSource,
  MoodEventRow,
  SleepPairingStateRow,
  UserProfileRow,
  UserRow,
  UserTargetRow,
} from "./types.js";
import type { BreachDetector } from "../observability/breachDetector.js";

export interface TenantQueryable {
  query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
}

export interface TenantPoolClient extends TenantQueryable {
  release(): void;
}

export interface TenantConnectionPool extends TenantQueryable {
  connect(): Promise<TenantPoolClient>;
}

export class TenantStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantStoreError";
  }
}

export class OptimisticVersionError extends TenantStoreError {
  public readonly entityName: string;
  public readonly expectedVersion: number;

  constructor(entityName: string, expectedVersion: number) {
    super(`${entityName} was not updated because version ${expectedVersion} is stale or the row is not visible`);
    this.name = "OptimisticVersionError";
    this.entityName = entityName;
    this.expectedVersion = expectedVersion;
  }
}

let pgTypeParsersRegistered = false;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function registerPgTypeParsers(): void {
  if (pgTypeParsersRegistered) {
    return;
  }

  pgTypes.setTypeParser(pgTypes.builtins.NUMERIC, (value: string | null) =>
    value === null ? null : parseFloat(value)
  );
  // TIMESTAMPTZ (OID 1184). pg's default parser converts to JS Date, but
  // DbTimestamp is `string`; pass through pg's raw ISO-8601 string.
  pgTypes.setTypeParser(pgTypes.builtins.TIMESTAMPTZ, (value: string | null) => value);
  pgTypeParsersRegistered = true;
}

export function nextVersion(currentVersion: number): number {
  if (!Number.isInteger(currentVersion) || currentVersion < 1) {
    throw new TenantStoreError(`Invalid optimistic version: ${currentVersion}`);
  }
  return currentVersion + 1;
}

export function createTenantStore(pool: Pool): TenantPostgresStore {
  registerPgTypeParsers();
  return new TenantPostgresStore(pool);
}

export class TenantPostgresStore implements TenantStore {
  public constructor(private readonly pool: TenantConnectionPool) {}

  public async withTransaction<T>(
    userId: string,
    action: (repository: TenantScopedRepository) => Promise<T>
  ): Promise<T> {
    if (!UUID_V4_RE.test(userId)) {
      throw new TenantStoreError("Invalid userId: not a UUID v4");
    }

    const client = await this.pool.connect();
    const repository = new TenantScopedRepositoryImpl(client);
    await client.query("BEGIN");
    try {
      // Third arg 'true' = transaction-local; auto-reverts on
      // COMMIT/ROLLBACK to prevent tenant-leak across pooled connections.
      await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      const result = await action(repository);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackSafely(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async createUser(userId: string, request: CreateUserRequest): Promise<UserRow> {
    return this.withTransaction(userId, (repository) => repository.createUser(userId, request));
  }

  public async getUser(userId: string): Promise<UserRow | null> {
    return this.withTransaction(userId, (repository) => repository.getUser(userId));
  }

  public async updateUserOnboardingStatus(
    userId: string,
    request: UpdateUserOnboardingStatusRequest
  ): Promise<UserRow> {
    return this.withTransaction(userId, (repository) => repository.updateUserOnboardingStatus(userId, request));
  }

  public async deleteUser(userId: string): Promise<boolean> {
    return this.withTransaction(userId, (repository) => repository.deleteUser(userId));
  }

  public async createUserProfile(userId: string, request: CreateUserProfileRequest): Promise<UserProfileRow> {
    return this.withTransaction(userId, (repository) => repository.createUserProfile(userId, request));
  }

  public async getLatestUserProfile(userId: string): Promise<UserProfileRow | null> {
    return this.withTransaction(userId, (repository) => repository.getLatestUserProfile(userId));
  }

  public async createUserTarget(userId: string, request: CreateUserTargetRequest): Promise<UserTargetRow> {
    return this.withTransaction(userId, (repository) => repository.createUserTarget(userId, request));
  }

  public async upsertSummarySchedule(
    userId: string,
    request: UpsertSummaryScheduleRequest
  ): Promise<SummaryScheduleRow> {
    return this.withTransaction(userId, (repository) => repository.upsertSummarySchedule(userId, request));
  }

  public async listSummarySchedules(userId: string): Promise<SummaryScheduleRow[]> {
    return this.withTransaction(userId, (repository) => repository.listSummarySchedules(userId));
  }

  public async upsertOnboardingState(
    userId: string,
    request: UpsertOnboardingStateRequest
  ): Promise<OnboardingStateRow> {
    return this.withTransaction(userId, (repository) => repository.upsertOnboardingState(userId, request));
  }

  public async updateOnboardingStateWithVersion(
    userId: string,
    request: UpdateOnboardingStateWithVersionRequest
  ): Promise<OnboardingStateRow> {
    return this.withTransaction(userId, (repository) => repository.updateOnboardingStateWithVersion(userId, request));
  }

  public async createTranscript(userId: string, request: CreateTranscriptRequest): Promise<TranscriptRow> {
    return this.withTransaction(userId, (repository) => repository.createTranscript(userId, request));
  }

  public async createMealDraft(userId: string, request: CreateMealDraftRequest): Promise<MealDraftRow> {
    return this.withTransaction(userId, (repository) => repository.createMealDraft(userId, request));
  }

  public async updateMealDraftWithVersion(
    userId: string,
    request: UpdateMealDraftWithVersionRequest
  ): Promise<MealDraftRow> {
    return this.withTransaction(userId, (repository) => repository.updateMealDraftWithVersion(userId, request));
  }

  public async createMealDraftItem(userId: string, request: CreateMealDraftItemRequest): Promise<MealDraftItemRow> {
    return this.withTransaction(userId, (repository) => repository.createMealDraftItem(userId, request));
  }

  public async deleteMealDraftItemsByDraftId(userId: string, draftId: string): Promise<number> {
    return this.withTransaction(userId, (repository) => repository.deleteMealDraftItemsByDraftId(userId, draftId));
  }

  public async createConfirmedMeal(userId: string, request: CreateConfirmedMealRequest): Promise<ConfirmedMealRow> {
    return this.withTransaction(userId, (repository) => repository.createConfirmedMeal(userId, request));
  }

  public async listConfirmedMeals(userId: string, request: ListConfirmedMealsRequest): Promise<ConfirmedMealRow[]> {
    return this.withTransaction(userId, (repository) => repository.listConfirmedMeals(userId, request));
  }

  public async softDeleteConfirmedMealWithVersion(
    userId: string,
    request: SoftDeleteConfirmedMealWithVersionRequest
  ): Promise<ConfirmedMealRow> {
    return this.withTransaction(userId, (repository) => repository.softDeleteConfirmedMealWithVersion(userId, request));
  }

  public async createMealItem(userId: string, request: CreateMealItemRequest): Promise<MealItemRow> {
    return this.withTransaction(userId, (repository) => repository.createMealItem(userId, request));
  }

  public async createSummaryRecord(userId: string, request: CreateSummaryRecordRequest): Promise<SummaryRecordRow> {
    return this.withTransaction(userId, (repository) => repository.createSummaryRecord(userId, request));
  }

  public async createAuditEvent(userId: string, request: CreateAuditEventRequest): Promise<AuditEventRow> {
    return this.withTransaction(userId, (repository) => repository.createAuditEvent(userId, request));
  }

  public async createMetricEvent(userId: string, request: CreateMetricEventRequest): Promise<MetricEventRow> {
    return this.withTransaction(userId, (repository) => repository.createMetricEvent(userId, request));
  }

  public async createCostEvent(userId: string, request: CreateCostEventRequest): Promise<CostEventRow> {
    return this.withTransaction(userId, (repository) => repository.createCostEvent(userId, request));
  }

  public async upsertMonthlySpendCounter(
    userId: string,
    request: UpsertMonthlySpendCounterRequest
  ): Promise<MonthlySpendCounterRow> {
    return this.withTransaction(userId, (repository) => repository.upsertMonthlySpendCounter(userId, request));
  }

  public async getMonthlySpendCounter(
    userId: string,
    monthUtc: string
  ): Promise<MonthlySpendCounterRow | null> {
    return this.withTransaction(userId, (repository) => repository.getMonthlySpendCounter(userId, monthUtc));
  }

  public async incrementMonthlySpend(
    userId: string,
    monthUtc: string,
    request: IncrementMonthlySpendRequest
  ): Promise<MonthlySpendCounterRow> {
    return this.withTransaction(userId, (repository) => repository.incrementMonthlySpend(userId, monthUtc, request));
  }

  public async upsertFoodLookupCache(userId: string, request: UpsertFoodLookupCacheRequest): Promise<FoodLookupCacheRow> {
    return this.withTransaction(userId, (repository) => repository.upsertFoodLookupCache(userId, request));
  }

  public async createKbjuAccuracyLabel(
    userId: string,
    request: CreateKbjuAccuracyLabelRequest
  ): Promise<KbjuAccuracyLabelRow> {
    return this.withTransaction(userId, (repository) => repository.createKbjuAccuracyLabel(userId, request));
  }

  // ── C21 Modality Settings (TKT-028@0.1.0) ───────────────────────────────

  public async getModalitySettings(userId: string): Promise<ModalitySettingsRow | null> {
    return this.withTransaction(userId, (repository) => repository.getModalitySettings(userId));
  }

  public async setModalitySetting(userId: string, modality: ModalityToggleName, value: boolean): Promise<ModalitySettingToggleResult> {
    return this.withTransaction(userId, (repository) => repository.setModalitySetting(userId, modality, value));
  }

  // ── C17 Water Events (TKT-029@0.1.0) ───────────────────────────────────

  public async insertWaterEvent(userId: string, source: WaterEventSource, volumeMl: number, rawText: string | null): Promise<{ event_id: string }> {
    return this.withTransaction(userId, (repository) => repository.insertWaterEvent(userId, source, volumeMl, rawText));
  }
  // ── C20 Mood Events (TKT-031@0.1.0) ───────────────────────────────────

  public async insertMoodEvent(userId: string, source: MoodEventSource, score: number, commentText: string | null, inferredFromText: boolean, rawText: string | null): Promise<{ event_id: string }> {
    return this.withTransaction(userId, (repository) => repository.insertMoodEvent(userId, source, score, commentText, inferredFromText, rawText));
  }

  // ── C18 Sleep Records (TKT-023@0.1.0) ───────────────────────────────────

  public async insertSleepRecord(userId: string, startTsUtc: string, endTsUtc: string, durationMin: number, attributionDateLocal: string, attributionTz: string, isNap: boolean, isPairedOrigin: boolean): Promise<{ record_id: string }> {
    return this.withTransaction(userId, (repository) => repository.insertSleepRecord(userId, startTsUtc, endTsUtc, durationMin, attributionDateLocal, attributionTz, isNap, isPairedOrigin));
  }

  public async getSleepPairingState(userId: string): Promise<import("./types.js").SleepPairingStateRow | null> {
    return this.withTransaction(userId, (repository) => repository.getSleepPairingState(userId));
  }

  public async upsertSleepPairingState(userId: string, legEventTsUtc: string, expiresAtUtc: string): Promise<void> {
    return this.withTransaction(userId, (repository) => repository.upsertSleepPairingState(userId, legEventTsUtc, expiresAtUtc));
  }

  public async deleteSleepPairingState(userId: string): Promise<void> {
    return this.withTransaction(userId, (repository) => repository.deleteSleepPairingState(userId));
  }

  public async gcExpiredSleepPairingState(nowUtc: string): Promise<{ rows_deleted: number }> {
    // GC runs across all users — no RLS scoping needed. Use pool directly.
    const result = await this.pool.query(
      `DELETE FROM sleep_pairing_state WHERE expires_at_utc < $1`,
      [nowUtc],
    );
    return { rows_deleted: result.rowCount ?? 0 };
  }
}


class TenantScopedRepositoryImpl implements TenantScopedRepository {
  public constructor(private readonly db: TenantQueryable) {}

  public async createUser(userId: string, request: CreateUserRequest): Promise<UserRow> {
    // DESIGN: ARCH-001@0.2.0 §3.3/§9.2 makes `id` the internal tenant key;
    // conflict on `id` keeps same-UUID retries idempotent while
    // `telegram_user_id` remains UNIQUE as the external identity guard.
    const result = await this.db.query<UserRow>(
      `INSERT INTO users (id, telegram_user_id, telegram_chat_id, language_code, timezone, onboarding_status)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         telegram_user_id = EXCLUDED.telegram_user_id,
         telegram_chat_id = EXCLUDED.telegram_chat_id,
         language_code = EXCLUDED.language_code,
         timezone = EXCLUDED.timezone,
         onboarding_status = EXCLUDED.onboarding_status,
         updated_at = now()
       RETURNING *`,
      [
        userId,
        request.telegramUserId,
        request.telegramChatId,
        request.languageCode ?? null,
        request.timezone,
        request.onboardingStatus ?? "pending",
      ]
    );
    return expectOne(result, "users");
  }

  public async getUser(userId: string): Promise<UserRow | null> {
    const result = await this.db.query<UserRow>("SELECT * FROM users WHERE id = $1", [userId]);
    return result.rows[0] ?? null;
  }

  public async updateUserOnboardingStatus(
    userId: string,
    request: UpdateUserOnboardingStatusRequest
  ): Promise<UserRow> {
    const result = await this.db.query<UserRow>(
      `UPDATE users
       SET onboarding_status = $2, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [userId, request.onboardingStatus]
    );
    return expectOne(result, "users");
  }

  public async deleteUser(userId: string): Promise<boolean> {
    const result = await this.db.query("DELETE FROM users WHERE id = $1", [userId]);
    return (result.rowCount ?? 0) > 0;
  }

  public async createUserProfile(userId: string, request: CreateUserProfileRequest): Promise<UserProfileRow> {
    const result = await this.db.query<UserProfileRow>(
      `INSERT INTO user_profiles (
         user_id, sex, age_years, height_cm, weight_kg, activity_level, weight_goal,
         pace_kg_per_week, default_pace_applied, formula_version
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        userId,
        request.sex,
        request.ageYears,
        request.heightCm,
        request.weightKg,
        request.activityLevel,
        request.weightGoal,
        request.paceKgPerWeek ?? null,
        request.defaultPaceApplied,
        request.formulaVersion,
      ]
    );
    return expectOne(result, "user_profiles");
  }

  public async getLatestUserProfile(userId: string): Promise<UserProfileRow | null> {
    const result = await this.db.query<UserProfileRow>(
      `SELECT * FROM user_profiles
       WHERE user_id = $1
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 1`,
      [userId]
    );
    return result.rows[0] ?? null;
  }

  public async createUserTarget(userId: string, request: CreateUserTargetRequest): Promise<UserTargetRow> {
    const result = await this.db.query<UserTargetRow>(
      `INSERT INTO user_targets (
         user_id, profile_id, bmr_kcal, activity_multiplier, maintenance_kcal,
         goal_delta_kcal_per_day, calories_kcal, protein_g, fat_g, carbs_g,
         formula_version, confirmed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12::timestamptz, now()))
       RETURNING *`,
      [
        userId,
        request.profileId,
        request.bmrKcal,
        request.activityMultiplier,
        request.maintenanceKcal,
        request.goalDeltaKcalPerDay,
        request.caloriesKcal,
        request.proteinG,
        request.fatG,
        request.carbsG,
        request.formulaVersion,
        request.confirmedAt ?? null,
      ]
    );
    return expectOne(result, "user_targets");
  }

  public async upsertSummarySchedule(
    userId: string,
    request: UpsertSummaryScheduleRequest
  ): Promise<SummaryScheduleRow> {
    // DESIGN: `(user_id, id)` matches schema.sql UNIQUE (user_id, id).
    // Summary schedules are id-addressed so daily/weekly/monthly rows can
    // coexist for one user per ARCH-001@0.2.0 §4.6.
    const result = await this.db.query<SummaryScheduleRow>(
      `INSERT INTO summary_schedules (
         id, user_id, period_type, local_time, timezone, enabled, last_due_period_start
       ) VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, id) DO UPDATE SET
         period_type = EXCLUDED.period_type,
         local_time = EXCLUDED.local_time,
         timezone = EXCLUDED.timezone,
         enabled = EXCLUDED.enabled,
         last_due_period_start = EXCLUDED.last_due_period_start,
         updated_at = now()
       RETURNING *`,
      [
        request.id ?? null,
        userId,
        request.periodType,
        request.localTime,
        request.timezone,
        request.enabled,
        request.lastDuePeriodStart ?? null,
      ]
    );
    return expectOne(result, "summary_schedules");
  }

  public async listSummarySchedules(userId: string): Promise<SummaryScheduleRow[]> {
    const result = await this.db.query<SummaryScheduleRow>(
      `SELECT * FROM summary_schedules
       WHERE user_id = $1
       ORDER BY period_type, local_time`,
      [userId]
    );
    return result.rows;
  }

  public async upsertOnboardingState(
    userId: string,
    request: UpsertOnboardingStateRequest
  ): Promise<OnboardingStateRow> {
    // DESIGN: `(user_id, id)` matches schema.sql UNIQUE (user_id, id);
    // passing an id resumes/retries a specific onboarding flow state, while
    // omitting it creates a new state row per ARCH-001@0.2.0 §4.1/§5.
    const result = await this.db.query<OnboardingStateRow>(
      `INSERT INTO onboarding_states (id, user_id, current_step, partial_answers)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4)
       ON CONFLICT (user_id, id) DO UPDATE SET
         current_step = EXCLUDED.current_step,
         partial_answers = EXCLUDED.partial_answers,
         version = onboarding_states.version + 1,
         updated_at = now()
       RETURNING *`,
      [request.id ?? null, userId, request.currentStep, request.partialAnswers]
    );
    return expectOne(result, "onboarding_states");
  }

  public async updateOnboardingStateWithVersion(
    userId: string,
    request: UpdateOnboardingStateWithVersionRequest
  ): Promise<OnboardingStateRow> {
    const result = await this.db.query<OnboardingStateRow>(
      `UPDATE onboarding_states
       SET current_step = $3, partial_answers = $4, version = version + 1, updated_at = now()
       WHERE user_id = $1 AND id = $2 AND version = $5
       RETURNING *`,
      [userId, request.id, request.currentStep, request.partialAnswers, request.expectedVersion]
    );
    return expectVersionedRow(result, "onboarding_states", request.expectedVersion);
  }

  public async createTranscript(userId: string, request: CreateTranscriptRequest): Promise<TranscriptRow> {
    const result = await this.db.query<TranscriptRow>(
      `INSERT INTO transcripts (
         user_id, telegram_message_id, provider_alias, audio_duration_seconds, transcript_text, confidence
       ) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        userId,
        request.telegramMessageId,
        request.providerAlias,
        request.audioDurationSeconds,
        request.transcriptText,
        request.confidence ?? null,
      ]
    );
    return expectOne(result, "transcripts");
  }

  public async createMealDraft(userId: string, request: CreateMealDraftRequest): Promise<MealDraftRow> {
    const result = await this.db.query<MealDraftRow>(
      `INSERT INTO meal_drafts (
         user_id, source, transcript_id, status, normalized_input_text, photo_confidence_0_1,
         low_confidence_label_shown, total_calories_kcal, total_protein_g, total_fat_g,
         total_carbs_g, confidence_0_1
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        userId,
        request.source,
        request.transcriptId ?? null,
        request.status,
        request.normalizedInputText ?? null,
        request.photoConfidence01 ?? null,
        request.lowConfidenceLabelShown,
        request.totalCaloriesKcal ?? null,
        request.totalProteinG ?? null,
        request.totalFatG ?? null,
        request.totalCarbsG ?? null,
        request.confidence01 ?? null,
      ]
    );
    return expectOne(result, "meal_drafts");
  }

  public async updateMealDraftWithVersion(
    userId: string,
    request: UpdateMealDraftWithVersionRequest
  ): Promise<MealDraftRow> {
    const result = await this.db.query<MealDraftRow>(
      `UPDATE meal_drafts
       SET status = $3,
           normalized_input_text = $4,
           total_calories_kcal = $5,
           total_protein_g = $6,
           total_fat_g = $7,
           total_carbs_g = $8,
           confidence_0_1 = $9,
           low_confidence_label_shown = $10,
           version = version + 1,
           updated_at = now()
       WHERE user_id = $1 AND id = $2 AND version = $11
       RETURNING *`,
      [
        userId,
        request.id,
        request.status,
        request.normalizedInputText ?? null,
        request.totalCaloriesKcal ?? null,
        request.totalProteinG ?? null,
        request.totalFatG ?? null,
        request.totalCarbsG ?? null,
        request.confidence01 ?? null,
        request.lowConfidenceLabelShown,
        request.expectedVersion,
      ]
    );
    return expectVersionedRow(result, "meal_drafts", request.expectedVersion);
  }

  public async createMealDraftItem(userId: string, request: CreateMealDraftItemRequest): Promise<MealDraftItemRow> {
    const result = await this.db.query<MealDraftItemRow>(
      `INSERT INTO meal_draft_items (
         user_id, draft_id, item_name_ru, portion_text_ru, portion_grams, calories_kcal,
         protein_g, fat_g, carbs_g, source, source_ref, confidence_0_1
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        userId,
        request.draftId,
        request.itemNameRu,
        request.portionTextRu,
        request.portionGrams ?? null,
        request.caloriesKcal,
        request.proteinG,
        request.fatG,
        request.carbsG,
        request.source,
        request.sourceRef ?? null,
        request.confidence01 ?? null,
      ]
    );
    return expectOne(result, "meal_draft_items");
  }

  public async deleteMealDraftItemsByDraftId(userId: string, draftId: string): Promise<number> {
    const result = await this.db.query<{ id: string }>(
      `DELETE FROM meal_draft_items WHERE user_id = $1 AND draft_id = $2 RETURNING id`,
      [userId, draftId]
    );
    return result.rowCount ?? result.rows.length;
  }

  public async createConfirmedMeal(userId: string, request: CreateConfirmedMealRequest): Promise<ConfirmedMealRow> {
    const result = await this.db.query<ConfirmedMealRow>(
      `INSERT INTO confirmed_meals (
         user_id, source, draft_id, meal_local_date, meal_logged_at, total_calories_kcal,
         total_protein_g, total_fat_g, total_carbs_g, manual_entry
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        userId,
        request.source,
        request.draftId ?? null,
        request.mealLocalDate,
        request.mealLoggedAt,
        request.totalCaloriesKcal,
        request.totalProteinG,
        request.totalFatG,
        request.totalCarbsG,
        request.manualEntry,
      ]
    );
    return expectOne(result, "confirmed_meals");
  }

  public async listConfirmedMeals(userId: string, request: ListConfirmedMealsRequest): Promise<ConfirmedMealRow[]> {
    const result = await this.db.query<ConfirmedMealRow>(
      `SELECT * FROM confirmed_meals
       WHERE user_id = $1
         AND ($2::date IS NULL OR meal_local_date >= $2::date)
         AND ($3::date IS NULL OR meal_local_date <= $3::date)
         AND ($4::boolean OR deleted_at IS NULL)
       ORDER BY meal_logged_at DESC, created_at DESC
       LIMIT $5 OFFSET $6`,
      [
        userId,
        request.mealLocalDateFrom ?? null,
        request.mealLocalDateTo ?? null,
        request.includeDeleted,
        request.limit,
        request.offset,
      ]
    );
    return result.rows;
  }

  public async softDeleteConfirmedMealWithVersion(
    userId: string,
    request: SoftDeleteConfirmedMealWithVersionRequest
  ): Promise<ConfirmedMealRow> {
    // DESIGN: ARCH-001@0.2.0 §4.5/§9.5 makes ordinary meal delete a soft-delete.
    // Re-deleting an already soft-deleted meal is a no-op that returns the
    // existing deletion marker; stale versions still fail for non-deleted rows.
    const result = await this.db.query<ConfirmedMealRow>(
      `UPDATE confirmed_meals
       SET deleted_at = COALESCE(deleted_at, $3),
           version = CASE WHEN deleted_at IS NULL THEN version + 1 ELSE version END,
           updated_at = CASE WHEN deleted_at IS NULL THEN now() ELSE updated_at END
       WHERE user_id = $1 AND id = $2 AND (version = $4 OR deleted_at IS NOT NULL)
       RETURNING *`,
      [userId, request.id, request.deletedAt, request.expectedVersion]
    );
    return expectVersionedRow(result, "confirmed_meals", request.expectedVersion);
  }

  public async createMealItem(userId: string, request: CreateMealItemRequest): Promise<MealItemRow> {
    const result = await this.db.query<MealItemRow>(
      `INSERT INTO meal_items (
         user_id, meal_id, item_name_ru, portion_text_ru, portion_grams, calories_kcal,
         protein_g, fat_g, carbs_g, source, source_ref
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        userId,
        request.mealId,
        request.itemNameRu,
        request.portionTextRu,
        request.portionGrams ?? null,
        request.caloriesKcal,
        request.proteinG,
        request.fatG,
        request.carbsG,
        request.source,
        request.sourceRef ?? null,
      ]
    );
    return expectOne(result, "meal_items");
  }

  public async createSummaryRecord(userId: string, request: CreateSummaryRecordRequest): Promise<SummaryRecordRow> {
    const result = await this.db.query<SummaryRecordRow>(
      `INSERT INTO summary_records (
         user_id, period_type, period_start_local_date, period_end_local_date, idempotency_key,
         totals, deltas_vs_target, previous_period_comparison, recommendation_text_ru,
         recommendation_mode, blocked_reason, delivered_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (user_id, idempotency_key) DO UPDATE SET
         totals = EXCLUDED.totals,
         deltas_vs_target = EXCLUDED.deltas_vs_target,
         previous_period_comparison = EXCLUDED.previous_period_comparison,
         recommendation_text_ru = EXCLUDED.recommendation_text_ru,
         recommendation_mode = EXCLUDED.recommendation_mode,
         blocked_reason = EXCLUDED.blocked_reason,
         delivered_at = EXCLUDED.delivered_at
       RETURNING *`,
      [
        userId,
        request.periodType,
        request.periodStartLocalDate,
        request.periodEndLocalDate,
        request.idempotencyKey,
        request.totals,
        request.deltasVsTarget,
        request.previousPeriodComparison ?? null,
        request.recommendationTextRu ?? null,
        request.recommendationMode,
        request.blockedReason ?? null,
        request.deliveredAt,
      ]
    );
    return expectOne(result, "summary_records");
  }

  public async createAuditEvent(userId: string, request: CreateAuditEventRequest): Promise<AuditEventRow> {
    const result = await this.db.query<AuditEventRow>(
      `INSERT INTO audit_events (
         user_id, event_type, entity_type, entity_id, before_snapshot, after_snapshot, reason
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        userId,
        request.eventType,
        request.entityType,
        request.entityId ?? null,
        request.beforeSnapshot ?? null,
        request.afterSnapshot ?? null,
        request.reason ?? null,
      ]
    );
    return expectOne(result, "audit_events");
  }

  public async createMetricEvent(userId: string, request: CreateMetricEventRequest): Promise<MetricEventRow> {
    const result = await this.db.query<MetricEventRow>(
      `INSERT INTO metric_events (
         user_id, request_id, event_name, component, latency_ms, outcome, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        userId,
        request.requestId,
        request.eventName,
        request.component,
        request.latencyMs ?? null,
        request.outcome,
        request.metadata ?? {},
      ]
    );
    return expectOne(result, "metric_events");
  }

  public async createCostEvent(userId: string, request: CreateCostEventRequest): Promise<CostEventRow> {
    const result = await this.db.query<CostEventRow>(
      `INSERT INTO cost_events (
         user_id, request_id, provider_alias, model_alias, call_type, estimated_cost_usd,
         actual_cost_usd, input_units, output_units, billing_unit
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        userId,
        request.requestId,
        request.providerAlias,
        request.modelAlias,
        request.callType,
        request.estimatedCostUsd,
        request.actualCostUsd ?? null,
        request.inputUnits ?? null,
        request.outputUnits ?? null,
        request.billingUnit,
      ]
    );
    return expectOne(result, "cost_events");
  }

  public async upsertMonthlySpendCounter(
    userId: string,
    request: UpsertMonthlySpendCounterRequest
  ): Promise<MonthlySpendCounterRow> {
    const result = await this.db.query<MonthlySpendCounterRow>(
      `INSERT INTO monthly_spend_counters (
         user_id, month_utc, estimated_spend_usd, actual_spend_usd,
         degrade_mode_enabled, po_alert_sent_at
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, month_utc) DO UPDATE SET
         estimated_spend_usd = EXCLUDED.estimated_spend_usd,
         actual_spend_usd = EXCLUDED.actual_spend_usd,
         degrade_mode_enabled = EXCLUDED.degrade_mode_enabled,
         po_alert_sent_at = EXCLUDED.po_alert_sent_at,
         updated_at = now()
       RETURNING *`,
      [
        userId,
        request.monthUtc,
        request.estimatedSpendUsd,
        request.actualSpendUsd ?? null,
        request.degradeModeEnabled,
        request.poAlertSentAt ?? null,
      ]
    );
    return expectOne(result, "monthly_spend_counters");
  }

  public async getMonthlySpendCounter(
    userId: string,
    monthUtc: string
  ): Promise<MonthlySpendCounterRow | null> {
    const result = await this.db.query<MonthlySpendCounterRow>(
      `SELECT * FROM monthly_spend_counters WHERE user_id = $1 AND month_utc = $2 LIMIT 1`,
      [userId, monthUtc]
    );
    return result.rows[0] ?? null;
  }

  public async incrementMonthlySpend(
    userId: string,
    monthUtc: string,
    request: IncrementMonthlySpendRequest
  ): Promise<MonthlySpendCounterRow> {
    const result = await this.db.query<MonthlySpendCounterRow>(
      `INSERT INTO monthly_spend_counters (
         user_id, month_utc, estimated_spend_usd, actual_spend_usd,
         degrade_mode_enabled, po_alert_sent_at
       ) VALUES ($1, $2, $3, 0, COALESCE($4::boolean, false), $5::timestamptz)
       ON CONFLICT (user_id, month_utc) DO UPDATE SET
         estimated_spend_usd = monthly_spend_counters.estimated_spend_usd + EXCLUDED.estimated_spend_usd,
         degrade_mode_enabled = COALESCE($4::boolean, monthly_spend_counters.degrade_mode_enabled),
         po_alert_sent_at = COALESCE($5::timestamptz, monthly_spend_counters.po_alert_sent_at),
         updated_at = now()
       RETURNING *`,
      [
        userId,
        monthUtc,
        request.deltaUsd,
        request.degradeModeEnabled ?? null,
        request.poAlertSentAt ?? null,
      ]
    );
    return expectOne(result, "monthly_spend_counters");
  }

  public async upsertFoodLookupCache(userId: string, request: UpsertFoodLookupCacheRequest): Promise<FoodLookupCacheRow> {
    const result = await this.db.query<FoodLookupCacheRow>(
      `INSERT INTO food_lookup_cache (
         user_id, canonical_query_hash, canonical_food_name, source, source_ref,
         per_100g_kbju, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, canonical_query_hash, source) DO UPDATE SET
         canonical_food_name = EXCLUDED.canonical_food_name,
         source_ref = EXCLUDED.source_ref,
         per_100g_kbju = EXCLUDED.per_100g_kbju,
         expires_at = EXCLUDED.expires_at
       RETURNING *`,
      [
        userId,
        request.canonicalQueryHash,
        request.canonicalFoodName,
        request.source,
        request.sourceRef,
        request.per100gKbju,
        request.expiresAt,
      ]
    );
    return expectOne(result, "food_lookup_cache");
  }

  public async createKbjuAccuracyLabel(
    userId: string,
    request: CreateKbjuAccuracyLabelRequest
  ): Promise<KbjuAccuracyLabelRow> {
    const result = await this.db.query<KbjuAccuracyLabelRow>(
      `INSERT INTO kbju_accuracy_labels (
         user_id, meal_id, labeled_by, sample_reason, estimate_totals, ground_truth_totals,
         calorie_error_pct, protein_error_pct, fat_error_pct, carbs_error_pct, notes
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        userId,
        request.mealId,
        request.labeledBy,
        request.sampleReason,
        request.estimateTotals,
        request.groundTruthTotals,
        request.calorieErrorPct,
        request.proteinErrorPct,
        request.fatErrorPct,
        request.carbsErrorPct,
        request.notes ?? null,
      ]
    );
    return expectOne(result, "kbju_accuracy_labels");
  }

  // ── C21 Modality Settings (TKT-028@0.1.0) ───────────────────────────────

  public async getModalitySettings(userId: string): Promise<ModalitySettingsRow | null> {
    const result = await this.db.query<ModalitySettingsRow>(
      "SELECT user_id, water_on, sleep_on, workout_on, mood_on, updated_at FROM modality_settings WHERE user_id = $1",
      [userId],
    );
    return result.rows[0] ?? null;
  }

  public async setModalitySetting(
    userId: string,
    modality: ModalityToggleName,
    value: boolean,
  ): Promise<ModalitySettingToggleResult> {
    const columnMap: Record<ModalityToggleName, string> = {
      water: "water_on",
      sleep: "sleep_on",
      workout: "workout_on",
      mood: "mood_on",
    };
    const column = columnMap[modality];

    // Read the current row to determine old_value
    const current = await this.db.query<ModalitySettingsRow>(
      "SELECT user_id, water_on, sleep_on, workout_on, mood_on, updated_at FROM modality_settings WHERE user_id = $1",
      [userId],
    );
    const oldRow = current.rows[0] ?? null;
    const keyMap: Record<ModalityToggleName, keyof ModalitySettingsRow> = {
      water: "water_on",
      sleep: "sleep_on",
      workout: "workout_on",
      mood: "mood_on",
    };
    const oldValue: boolean = oldRow ? (oldRow[keyMap[modality]] as boolean) : true; // default ON per PRD-003@0.1.3 §5 US-5

    // Upsert the new value into modality_settings
    await this.db.query(
      `INSERT INTO modality_settings (user_id, ${column}, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET ${column} = $2, updated_at = now()`,
      [userId, value],
    );

    // Audit row per ARCH-001@0.6.1 §3.21 + TKT-021@0.1.0 schema
    await this.db.query(
      "INSERT INTO modality_settings_audit (user_id, modality, old_value, new_value, ts_utc) VALUES ($1, $2, $3, $4, now())",
      [userId, modality, oldValue, value],
    );

    return { oldValue, newValue: value };
  }

  // ── C17 Water Events (TKT-029@0.1.0) ───────────────────────────────────

  public async insertWaterEvent(
    userId: string,
    source: WaterEventSource,
    volumeMl: number,
    rawText: string | null,
  ): Promise<{ event_id: string }> {
    const result = await this.db.query<{ event_id: string }>(
      `INSERT INTO water_events (event_id, user_id, ts_utc, volume_ml, source, raw_text, created_at)
       VALUES (gen_random_uuid(), $1, now(), $2, $3, $4, now())
       RETURNING event_id`,
      [userId, volumeMl, source, rawText],
    );
    return expectOne(result, "water_events");
  }

  // ── C20 Mood Events (TKT-031@0.1.0) ───────────────────────────────────

  public async insertMoodEvent(
    userId: string,
    source: MoodEventSource,
    score: number,
    commentText: string | null,
    inferredFromText: boolean,
    rawText: string | null,
  ): Promise<{ event_id: string }> {
    const result = await this.db.query<{ event_id: string }>(
      `INSERT INTO mood_events (event_id, user_id, ts_utc, score, comment_text, source, inferred_from_text, raw_text, created_at)
       VALUES (gen_random_uuid(), $1, now(), $2, $3, $4, $5, $6, now())
       RETURNING event_id`,
      [userId, score, commentText, source, inferredFromText, rawText],
    );
    return expectOne(result, "mood_events");
  }

  // ── C18 Sleep Records (TKT-023@0.1.0) ───────────────────────────────────

  public async insertSleepRecord(
    userId: string,
    startTsUtc: string,
    endTsUtc: string,
    durationMin: number,
    attributionDateLocal: string,
    attributionTz: string,
    isNap: boolean,
    isPairedOrigin: boolean,
  ): Promise<{ record_id: string }> {
    const result = await this.db.query<{ record_id: string }>(
      `INSERT INTO sleep_records (record_id, user_id, start_ts_utc, end_ts_utc, duration_min, attribution_date_local, attribution_tz, is_nap, is_paired_origin, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, now())
       RETURNING record_id`,
      [userId, startTsUtc, endTsUtc, durationMin, attributionDateLocal, attributionTz, isNap, isPairedOrigin],
    );
    return expectOne(result, "sleep_records");
  }

  public async getSleepPairingState(userId: string): Promise<SleepPairingStateRow | null> {
    const result = await this.db.query<SleepPairingStateRow>(
      `SELECT user_id, leg_event_ts_utc, expires_at_utc
       FROM sleep_pairing_state
       WHERE user_id = $1 AND expires_at_utc > now()`,
      [userId],
    );
    return result.rows[0] ?? null;
  }

  public async upsertSleepPairingState(
    userId: string,
    legEventTsUtc: string,
    expiresAtUtc: string,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO sleep_pairing_state (user_id, leg_event_ts_utc, expires_at_utc)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET
         leg_event_ts_utc = EXCLUDED.leg_event_ts_utc,
         expires_at_utc = EXCLUDED.expires_at_utc`,
      [userId, legEventTsUtc, expiresAtUtc],
    );
  }

  public async deleteSleepPairingState(userId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM sleep_pairing_state WHERE user_id = $1`,
      [userId],
    );
  }

  public async gcExpiredSleepPairingState(nowUtc: string): Promise<{ rows_deleted: number }> {
    const result = await this.db.query(
      `DELETE FROM sleep_pairing_state WHERE expires_at_utc < $1`,
      [nowUtc],
    );
    return { rows_deleted: result.rowCount ?? 0 };
  }
}

function expectOne<Row extends QueryResultRow>(result: QueryResult<Row>, entityName: string): Row {
  const row = result.rows[0];
  if (!row) {
    throw new TenantStoreError(`${entityName} query returned no row`);
  }
  return row;
}

function expectVersionedRow<Row extends QueryResultRow>(
  result: QueryResult<Row>,
  entityName: string,
  expectedVersion: number
): Row {
  const row = result.rows[0];
  if (!row) {
    throw new OptimisticVersionError(entityName, expectedVersion);
  }
  return row;
}

export class BreachDetectingTenantStore implements TenantStore {
  private readonly inner: TenantStore;
  private readonly authenticatedUserId: string;
  private readonly detector: BreachDetector;

  constructor(inner: TenantStore, authenticatedUserId: string, detector: BreachDetector) {
    this.inner = inner;
    this.authenticatedUserId = authenticatedUserId;
    this.detector = detector;
  }

  private guard(userId: string, operation: "read" | "write", entityType: string): void {
    this.detector.checkTenantAccess(this.authenticatedUserId, userId, operation, entityType);
  }

  /**
   * Guards the transaction entry by emitting a breach event + throwing
   * TenantNotAllowedError when the requested userId differs from the
   * authenticated user. After entry, the transaction action receives the
   * unwrapped inner TenantScopedRepository.
   *
   * Cross-tenant SQL operations executed against that repository inside the
   * action do NOT emit kbju_tenant_breach_detected events. They are blocked
   * at the SQL layer by PostgreSQL Row-Level Security policies, which are
   * activated by `set_config('app.user_id', $1, true)` inside
   * TenantPostgresStore.withTransaction (see ADR-001@0.1.0 §Decision and
   * ARCH-001@0.5.0 §9.2). RLS is the production safety net; the C12 detector
   * is defense-in-depth at the C3 TenantStore public boundary per
   * ARCH-001@0.5.0 §3.12.
   *
   * Implication: during normal traffic this distinction is invisible. During
   * a synthetic breach test, only top-level cross-tenant TenantStore method
   * calls fire kbju_tenant_breach_detected; transaction-internal cross-
   * tenant repository calls fail with a SQL-level RLS denial.
   */
  public async withTransaction<T>(userId: string, action: (repository: TenantScopedRepository) => Promise<T>): Promise<T> {
    this.guard(userId, "write", "transaction");
    return this.inner.withTransaction(userId, action);
  }

  public async createUser(userId: string, request: CreateUserRequest): Promise<UserRow> {
    this.guard(userId, "write", "users");
    return this.inner.createUser(userId, request);
  }

  public async getUser(userId: string): Promise<UserRow | null> {
    this.guard(userId, "read", "users");
    return this.inner.getUser(userId);
  }

  public async updateUserOnboardingStatus(userId: string, request: UpdateUserOnboardingStatusRequest): Promise<UserRow> {
    this.guard(userId, "write", "users");
    return this.inner.updateUserOnboardingStatus(userId, request);
  }

  public async deleteUser(userId: string): Promise<boolean> {
    this.guard(userId, "write", "users");
    return this.inner.deleteUser(userId);
  }

  public async createUserProfile(userId: string, request: CreateUserProfileRequest): Promise<UserProfileRow> {
    this.guard(userId, "write", "user_profiles");
    return this.inner.createUserProfile(userId, request);
  }

  public async getLatestUserProfile(userId: string): Promise<UserProfileRow | null> {
    this.guard(userId, "read", "user_profiles");
    return this.inner.getLatestUserProfile(userId);
  }

  public async createUserTarget(userId: string, request: CreateUserTargetRequest): Promise<UserTargetRow> {
    this.guard(userId, "write", "user_targets");
    return this.inner.createUserTarget(userId, request);
  }

  public async upsertSummarySchedule(userId: string, request: UpsertSummaryScheduleRequest): Promise<SummaryScheduleRow> {
    this.guard(userId, "write", "summary_schedules");
    return this.inner.upsertSummarySchedule(userId, request);
  }

  public async listSummarySchedules(userId: string): Promise<SummaryScheduleRow[]> {
    this.guard(userId, "read", "summary_schedules");
    return this.inner.listSummarySchedules(userId);
  }

  public async upsertOnboardingState(userId: string, request: UpsertOnboardingStateRequest): Promise<OnboardingStateRow> {
    this.guard(userId, "write", "onboarding_states");
    return this.inner.upsertOnboardingState(userId, request);
  }

  public async updateOnboardingStateWithVersion(userId: string, request: UpdateOnboardingStateWithVersionRequest): Promise<OnboardingStateRow> {
    this.guard(userId, "write", "onboarding_states");
    return this.inner.updateOnboardingStateWithVersion(userId, request);
  }

  public async createTranscript(userId: string, request: CreateTranscriptRequest): Promise<TranscriptRow> {
    this.guard(userId, "write", "transcripts");
    return this.inner.createTranscript(userId, request);
  }

  public async createMealDraft(userId: string, request: CreateMealDraftRequest): Promise<MealDraftRow> {
    this.guard(userId, "write", "meal_drafts");
    return this.inner.createMealDraft(userId, request);
  }

  public async updateMealDraftWithVersion(userId: string, request: UpdateMealDraftWithVersionRequest): Promise<MealDraftRow> {
    this.guard(userId, "write", "meal_drafts");
    return this.inner.updateMealDraftWithVersion(userId, request);
  }

  public async createMealDraftItem(userId: string, request: CreateMealDraftItemRequest): Promise<MealDraftItemRow> {
    this.guard(userId, "write", "meal_draft_items");
    return this.inner.createMealDraftItem(userId, request);
  }

  public async deleteMealDraftItemsByDraftId(userId: string, draftId: string): Promise<number> {
    this.guard(userId, "write", "meal_draft_items");
    return this.inner.deleteMealDraftItemsByDraftId(userId, draftId);
  }

  public async createConfirmedMeal(userId: string, request: CreateConfirmedMealRequest): Promise<ConfirmedMealRow> {
    this.guard(userId, "write", "confirmed_meals");
    return this.inner.createConfirmedMeal(userId, request);
  }

  public async listConfirmedMeals(userId: string, request: ListConfirmedMealsRequest): Promise<ConfirmedMealRow[]> {
    this.guard(userId, "read", "confirmed_meals");
    return this.inner.listConfirmedMeals(userId, request);
  }

  public async softDeleteConfirmedMealWithVersion(userId: string, request: SoftDeleteConfirmedMealWithVersionRequest): Promise<ConfirmedMealRow> {
    this.guard(userId, "write", "confirmed_meals");
    return this.inner.softDeleteConfirmedMealWithVersion(userId, request);
  }

  public async createMealItem(userId: string, request: CreateMealItemRequest): Promise<MealItemRow> {
    this.guard(userId, "write", "meal_items");
    return this.inner.createMealItem(userId, request);
  }

  public async createSummaryRecord(userId: string, request: CreateSummaryRecordRequest): Promise<SummaryRecordRow> {
    this.guard(userId, "write", "summary_records");
    return this.inner.createSummaryRecord(userId, request);
  }

  public async createAuditEvent(userId: string, request: CreateAuditEventRequest): Promise<AuditEventRow> {
    this.guard(userId, "write", "audit_events");
    return this.inner.createAuditEvent(userId, request);
  }

  public async createMetricEvent(userId: string, request: CreateMetricEventRequest): Promise<MetricEventRow> {
    this.guard(userId, "write", "metric_events");
    return this.inner.createMetricEvent(userId, request);
  }

  public async createCostEvent(userId: string, request: CreateCostEventRequest): Promise<CostEventRow> {
    this.guard(userId, "write", "cost_events");
    return this.inner.createCostEvent(userId, request);
  }

  public async upsertMonthlySpendCounter(userId: string, request: UpsertMonthlySpendCounterRequest): Promise<MonthlySpendCounterRow> {
    this.guard(userId, "write", "monthly_spend_counters");
    return this.inner.upsertMonthlySpendCounter(userId, request);
  }

  public async getMonthlySpendCounter(userId: string, monthUtc: string): Promise<MonthlySpendCounterRow | null> {
    this.guard(userId, "read", "monthly_spend_counters");
    return this.inner.getMonthlySpendCounter(userId, monthUtc);
  }

  public async incrementMonthlySpend(userId: string, monthUtc: string, request: IncrementMonthlySpendRequest): Promise<MonthlySpendCounterRow> {
    this.guard(userId, "write", "monthly_spend_counters");
    return this.inner.incrementMonthlySpend(userId, monthUtc, request);
  }

  public async upsertFoodLookupCache(userId: string, request: UpsertFoodLookupCacheRequest): Promise<FoodLookupCacheRow> {
    this.guard(userId, "write", "food_lookup_cache");
    return this.inner.upsertFoodLookupCache(userId, request);
  }

  public async createKbjuAccuracyLabel(userId: string, request: CreateKbjuAccuracyLabelRequest): Promise<KbjuAccuracyLabelRow> {
    this.guard(userId, "write", "kbju_accuracy_labels");
    return this.inner.createKbjuAccuracyLabel(userId, request);
  }

  // ── C21 Modality Settings (TKT-028@0.1.0) ───────────────────────────────

  public async getModalitySettings(userId: string): Promise<ModalitySettingsRow | null> {
    this.guard(userId, "read", "modality_settings");
    return this.inner.getModalitySettings(userId);
  }

  public async setModalitySetting(userId: string, modality: ModalityToggleName, value: boolean): Promise<ModalitySettingToggleResult> {
    this.guard(userId, "write", "modality_settings");
    return this.inner.setModalitySetting(userId, modality, value);
  }

  // ── C17 Water Events (TKT-029@0.1.0) ───────────────────────────────────

  public async insertWaterEvent(userId: string, source: WaterEventSource, volumeMl: number, rawText: string | null): Promise<{ event_id: string }> {
    this.guard(userId, "write", "water_events");
    return this.inner.insertWaterEvent(userId, source, volumeMl, rawText);
  }

  // ── C20 Mood Events (TKT-031@0.1.0) ───────────────────────────────────

  public async insertMoodEvent(userId: string, source: MoodEventSource, score: number, commentText: string | null, inferredFromText: boolean, rawText: string | null): Promise<{ event_id: string }> {
    this.guard(userId, "write", "mood_events");
    return this.inner.insertMoodEvent(userId, source, score, commentText, inferredFromText, rawText);
  }

  // ── C18 Sleep Records (TKT-023@0.1.0) ───────────────────────────────────

  public async insertSleepRecord(userId: string, startTsUtc: string, endTsUtc: string, durationMin: number, attributionDateLocal: string, attributionTz: string, isNap: boolean, isPairedOrigin: boolean): Promise<{ record_id: string }> {
    this.guard(userId, "write", "sleep_records");
    return this.inner.insertSleepRecord(userId, startTsUtc, endTsUtc, durationMin, attributionDateLocal, attributionTz, isNap, isPairedOrigin);
  }

  public async getSleepPairingState(userId: string): Promise<import("./types.js").SleepPairingStateRow | null> {
    this.guard(userId, "read", "sleep_pairing_state");
    return this.inner.getSleepPairingState(userId);
  }

  public async upsertSleepPairingState(userId: string, legEventTsUtc: string, expiresAtUtc: string): Promise<void> {
    this.guard(userId, "write", "sleep_pairing_state");
    return this.inner.upsertSleepPairingState(userId, legEventTsUtc, expiresAtUtc);
  }

  public async deleteSleepPairingState(userId: string): Promise<void> {
    this.guard(userId, "write", "sleep_pairing_state");
    return this.inner.deleteSleepPairingState(userId);
  }

  public async gcExpiredSleepPairingState(nowUtc: string): Promise<{ rows_deleted: number }> {
    return this.inner.gcExpiredSleepPairingState(nowUtc);
  }
}

async function rollbackSafely(client: TenantQueryable): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original transaction error.
  }
}

