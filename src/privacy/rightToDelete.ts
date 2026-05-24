import {
  DELETE_CANCELLED_MESSAGE_RU,
  DELETE_COMPLETED_MESSAGE_RU,
  DELETE_CONFIRMATION_MESSAGE_RU,
  DELETE_FRESH_START_MESSAGE_RU,
  isRussianDeletionIntent,
  parseRussianDeletionConfirmation,
} from "./messages.js";
import type {
  NaturalLanguageDeletionIntentHandler,
  RightToDeleteDeps,
  RightToDeleteRequest,
  RightToDeleteResult,
} from "./types.js";

export const detectRussianDeletionIntent: NaturalLanguageDeletionIntentHandler = (update) =>
  isRussianDeletionIntent(update.text);

export class RightToDeleteService {
  public constructor(private readonly deps: RightToDeleteDeps) {}

  public async handle(request: RightToDeleteRequest): Promise<RightToDeleteResult> {
    const answer = parseRussianDeletionConfirmation(request.text);
    if (answer === "no") {
      return {
        status: "cancelled",
        telegramChatId: request.telegramChatId,
        message: DELETE_CANCELLED_MESSAGE_RU,
      };
    }

    if (answer !== "yes") {
      return {
        status: "confirmation_required",
        telegramChatId: request.telegramChatId,
        message: DELETE_CONFIRMATION_MESSAGE_RU,
      };
    }

    const user = await this.deps.repository.findUserByTelegramUserId(String(request.telegramUserId));
    if (!user) {
      return {
        status: "fresh_start",
        telegramChatId: request.telegramChatId,
        message: DELETE_FRESH_START_MESSAGE_RU,
      };
    }

    const deletedRowCounts = await this.deps.repository.withUserDeletionTransaction(user.id, async (tx) => {
      const locked = await tx.lockUser(user.id);
      if (!locked) {
        return emptyDeletionCounts();
      }
      return tx.hardDeleteUserRows(user.id);
    });

    return {
      status: "deleted",
      telegramChatId: request.telegramChatId,
      message: DELETE_COMPLETED_MESSAGE_RU,
      deletedUserId: user.id,
      deletedRowCounts,
    };
  }
}

export function emptyDeletionCounts(): Record<keyof ReturnType<typeof createDeletionSqlByTable>, number> {
  return Object.fromEntries(Object.keys(createDeletionSqlByTable()).map((table) => [table, 0])) as Record<
    keyof ReturnType<typeof createDeletionSqlByTable>,
    number
  >;
}

export function createDeletionSqlByTable(): Record<string, string> {
  return {
    summary_schedules: "DELETE FROM summary_schedules WHERE user_id = $1",
    meal_draft_items: "DELETE FROM meal_draft_items WHERE user_id = $1",
    meal_items: "DELETE FROM meal_items WHERE user_id = $1",
    kbju_accuracy_labels: "DELETE FROM kbju_accuracy_labels WHERE user_id = $1",
    summary_records: "DELETE FROM summary_records WHERE user_id = $1",
    cost_events: "DELETE FROM cost_events WHERE user_id = $1",
    metric_events: "DELETE FROM metric_events WHERE user_id = $1",
    audit_events: "DELETE FROM audit_events WHERE user_id = $1",
    food_lookup_cache: "DELETE FROM food_lookup_cache WHERE user_id = $1",
    onboarding_states: "DELETE FROM onboarding_states WHERE user_id = $1",
    user_targets: "DELETE FROM user_targets WHERE user_id = $1",
    user_profiles: "DELETE FROM user_profiles WHERE user_id = $1",
    monthly_spend_counters: "DELETE FROM monthly_spend_counters WHERE user_id = $1",
    confirmed_meals: "DELETE FROM confirmed_meals WHERE user_id = $1",
    meal_drafts: "DELETE FROM meal_drafts WHERE user_id = $1",
    transcripts: "DELETE FROM transcripts WHERE user_id = $1",
    // PRD-003@0.1.3 §5 US-7 modality tables (TKT-021)
    water_events: "DELETE FROM water_events WHERE user_id = $1",
    sleep_records: "DELETE FROM sleep_records WHERE user_id = $1",
    sleep_pairing_state: "DELETE FROM sleep_pairing_state WHERE user_id = $1",
    workout_events: "DELETE FROM workout_events WHERE user_id = $1",
    mood_events: "DELETE FROM mood_events WHERE user_id = $1",
    modality_settings_audit: "DELETE FROM modality_settings_audit WHERE user_id = $1",
    modality_settings: "DELETE FROM modality_settings WHERE user_id = $1",
    users: "DELETE FROM users WHERE id = $1",
  };
}

export async function hardDeleteUserRows(
  query: (sql: string, values: unknown[]) => Promise<{ rowCount?: number }>,
  userId: string,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const [table, sql] of Object.entries(createDeletionSqlByTable())) {
    const result = await query(sql, [userId]);
    counts[table] = result.rowCount ?? 0;
  }
  return counts;
}

export async function lockUserForDeletion(
  query: (sql: string, values: unknown[]) => Promise<{ rows: Array<{ id?: string }> }>,
  userId: string,
): Promise<boolean> {
  await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [userId]);
  const result = await query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
  return result.rows.length > 0;
}
