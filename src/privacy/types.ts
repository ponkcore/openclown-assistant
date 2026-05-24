import type { JsonValue } from "../store/types.js";
import type { NormalizedTelegramUpdate } from "../telegram/types.js";

export type DeleteConfirmationAnswer = "yes" | "no" | "unknown";
export type RightToDeleteStatus = "confirmation_required" | "cancelled" | "deleted" | "fresh_start";

export interface RightToDeleteRequest {
  telegramUserId: number | string;
  telegramChatId: number | string;
  requestId: string;
  text?: string;
}

export interface RightToDeleteResult {
  status: RightToDeleteStatus;
  telegramChatId: number | string;
  message: string;
  deletedUserId?: string;
  deletedRowCounts?: Record<UserScopedDeletionTable, number>;
}

export type UserScopedDeletionTable =
  | "summary_schedules"
  | "meal_draft_items"
  | "meal_items"
  | "kbju_accuracy_labels"
  | "summary_records"
  | "cost_events"
  | "metric_events"
  | "audit_events"
  | "food_lookup_cache"
  | "confirmed_meals"
  | "meal_drafts"
  | "transcripts"
  | "onboarding_states"
  | "user_targets"
  | "user_profiles"
  | "monthly_spend_counters"
  // PRD-003@0.1.3 §5 US-7 modality tables (TKT-021)
  | "water_events"
  | "sleep_records"
  | "sleep_pairing_state"
  | "workout_events"
  | "mood_events"
  | "modality_settings_audit"
  | "modality_settings"
  | "users";

export interface UserIdentityForDeletion {
  id: string;
  telegramUserId: string;
  telegramChatId: string;
}

export interface RightToDeleteRepository {
  findUserByTelegramUserId(telegramUserId: string): Promise<UserIdentityForDeletion | null>;
  /** Runs the callback inside one C3 transaction scoped to this user. */
  withUserDeletionTransaction<T>(userId: string, action: (tx: RightToDeleteTransaction) => Promise<T>): Promise<T>;
}

export interface RightToDeleteTransaction {
  lockUser(userId: string): Promise<boolean>;
  hardDeleteUserRows(userId: string): Promise<Record<UserScopedDeletionTable, number>>;
}

export interface RightToDeleteDeps {
  repository: RightToDeleteRepository;
}

export interface NaturalLanguageDeletionIntentHandler {
  (update: NormalizedTelegramUpdate): boolean;
}

export type TenantAuditRunType = "end_of_pilot_k4";

export interface TenantAuditFinding {
  check: string;
  table: string;
  count: number;
}

export interface TenantAuditResult {
  runId: string;
  runType: TenantAuditRunType;
  checkedTables: string[];
  crossUserReferenceCount: number;
  findings: TenantAuditFinding[];
}

export interface TenantAuditConnection {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount?: number }>;
  end(): Promise<void>;
}

export interface TenantAuditConnectionFactory {
  (auditDbUrl: string): Promise<TenantAuditConnection>;
}

export interface TenantAuditDeps {
  connect: TenantAuditConnectionFactory;
  env?: Record<string, string | undefined>;
}

export interface TenantAuditRunRow extends Record<string, unknown> {
  id: string;
  checked_tables: string[];
  cross_user_reference_count: number;
  findings: JsonValue[];
}
