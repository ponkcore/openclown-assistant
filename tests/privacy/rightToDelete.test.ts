import { describe, expect, it } from "vitest";
import { DELETE_FRESH_START_MESSAGE_RU, isRussianDeletionIntent } from "../../src/privacy/messages.js";
import {
  RightToDeleteService,
  createDeletionSqlByTable,
  hardDeleteUserRows,
  lockUserForDeletion,
} from "../../src/privacy/rightToDelete.js";
import type { RightToDeleteRepository, RightToDeleteTransaction, UserScopedDeletionTable } from "../../src/privacy/types.js";

class MemoryDeletionRepository implements RightToDeleteRepository {
  public readonly rows = new Map<UserScopedDeletionTable, Set<string>>();
  public readonly calls: string[] = [];
  public readonly locks = new Map<string, Promise<void>>();
  private releaseCurrentLock: (() => void) | null = null;

  public constructor(private readonly telegramUserId: string, private readonly userId: string) {
    for (const table of Object.keys(createDeletionSqlByTable()) as UserScopedDeletionTable[]) {
      this.rows.set(table, new Set([userId, "other-user"]));
    }
  }

  public async findUserByTelegramUserId(telegramUserId: string) {
    if (telegramUserId !== this.telegramUserId || !this.rows.get("users")?.has(this.userId)) {
      return null;
    }
    return { id: this.userId, telegramUserId: this.telegramUserId, telegramChatId: "42" };
  }

  public async withUserDeletionTransaction<T>(userId: string, action: (tx: RightToDeleteTransaction) => Promise<T>): Promise<T> {
    this.calls.push(`begin:${userId}`);
    let releaseLock!: () => void;
    const lock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    this.locks.set(userId, lock);
    this.releaseCurrentLock = releaseLock;
    try {
      return await action({
        lockUser: async () => {
          this.calls.push(`lock:${userId}`);
          return this.rows.get("users")?.has(userId) ?? false;
        },
        hardDeleteUserRows: async () => {
          const counts = {} as Record<UserScopedDeletionTable, number>;
          for (const table of Object.keys(createDeletionSqlByTable()) as UserScopedDeletionTable[]) {
            const deleted = this.rows.get(table)?.delete(userId) ? 1 : 0;
            counts[table] = deleted;
          }
          return counts;
        },
      });
    } finally {
      this.calls.push(`commit:${userId}`);
      this.releaseCurrentLock?.();
      this.releaseCurrentLock = null;
    }
  }

  public async confirmMeal(userId: string): Promise<void> {
    await this.locks.get(userId);
    this.calls.push(`confirm:${userId}`);
  }
}

describe("RightToDeleteService", () => {
  it("requires one Russian yes/no confirmation before deletion", async () => {
    const repository = new MemoryDeletionRepository("1001", "user-1");
    const service = new RightToDeleteService({ repository });

    const result = await service.handle({ telegramUserId: 1001, telegramChatId: 42, requestId: "r1", text: "/forget_me" });

    expect(result.status).toBe("confirmation_required");
    expect(result.message).toContain("да");
    expect(repository.rows.get("users")?.has("user-1")).toBe(true);
  });

  it("leaves all user rows unchanged when cancellation is confirmed", async () => {
    const repository = new MemoryDeletionRepository("1001", "user-1");
    const before = snapshotRows(repository);
    const service = new RightToDeleteService({ repository });

    const result = await service.handle({ telegramUserId: 1001, telegramChatId: 42, requestId: "r2", text: "нет" });

    expect(result.status).toBe("cancelled");
    expect(snapshotRows(repository)).toEqual(before);
  });

  it("hard-deletes every user-scoped row for the confirmed user only", async () => {
    const repository = new MemoryDeletionRepository("1001", "user-1");
    const service = new RightToDeleteService({ repository });

    const result = await service.handle({ telegramUserId: 1001, telegramChatId: 42, requestId: "r3", text: "да" });

    expect(result.status).toBe("deleted");
    for (const [table, ids] of repository.rows.entries()) {
      expect(ids.has("user-1"), table).toBe(false);
      expect(ids.has("other-user"), table).toBe(true);
    }
    expect(result.deletedRowCounts).toMatchObject({ users: 1, summary_schedules: 1, audit_events: 1 });
  });

  it("returns fresh-start copy after prior deletion without old personalization or new user insert", async () => {
    const repository = new MemoryDeletionRepository("1001", "user-1");
    const service = new RightToDeleteService({ repository });
    await service.handle({ telegramUserId: 1001, telegramChatId: 42, requestId: "r4", text: "да" });

    const result = await service.handle({ telegramUserId: 1001, telegramChatId: 42, requestId: "r5", text: "да" });

    expect(result.status).toBe("fresh_start");
    expect(result.message).toBe(DELETE_FRESH_START_MESSAGE_RU);
    expect(result.message).not.toContain("user-1");
    expect(repository.rows.get("users")?.has("user-1")).toBe(false);
    expect(repository.calls.filter((call) => call.startsWith("begin:"))).toHaveLength(1);
  });

  it("serializes concurrent delete and meal confirmation on user_id lock", async () => {
    const repository = new MemoryDeletionRepository("1001", "user-1");
    const service = new RightToDeleteService({ repository });

    const deletePromise = service.handle({ telegramUserId: 1001, telegramChatId: 42, requestId: "r6", text: "да" });
    await waitForCall(repository, "lock:user-1");
    await Promise.all([deletePromise, repository.confirmMeal("user-1")]);

    expect(repository.calls.indexOf("commit:user-1")).toBeLessThan(repository.calls.indexOf("confirm:user-1"));
  });
});

describe("right-to-delete SQL helpers", () => {
  it("deletes user-scoped tables in FK-safe child-before-parent order", () => {
    const tables = Object.keys(createDeletionSqlByTable());

    expect(tables).toEqual([
      "summary_schedules",
      "meal_draft_items",
      "meal_items",
      "kbju_accuracy_labels",
      "summary_records",
      "cost_events",
      "metric_events",
      "audit_events",
      "food_lookup_cache",
      "onboarding_states",
      "user_targets",
      "user_profiles",
      "monthly_spend_counters",
      "confirmed_meals",
      "meal_drafts",
      "transcripts",
      // PRD-003@0.1.3 §5 US-7 modality tables (TKT-021)
      "water_events",
      "sleep_records",
      "sleep_pairing_state",
      "workout_events",
      "mood_events",
      "modality_settings_audit",
      "modality_settings",
      "users",
    ]);
    expect(tables.indexOf("confirmed_meals")).toBeLessThan(tables.indexOf("meal_drafts"));
    expect(tables.indexOf("meal_items")).toBeLessThan(tables.indexOf("confirmed_meals"));
    expect(tables.indexOf("kbju_accuracy_labels")).toBeLessThan(tables.indexOf("confirmed_meals"));
    // PRD-003 modality: audit before settings, all before users
    expect(tables.indexOf("modality_settings_audit")).toBeLessThan(tables.indexOf("modality_settings"));
    expect(tables.indexOf("modality_settings")).toBeLessThan(tables.indexOf("users"));
  });

  it("executes hard-delete statements for all user-scoped tables", async () => {
    const queries: string[] = [];
    const counts = await hardDeleteUserRows(async (sql) => {
      queries.push(sql);
      return { rowCount: 1 };
    }, "user-1");

    expect(Object.keys(counts)).toEqual(Object.keys(createDeletionSqlByTable()));
    expect(queries).toHaveLength(Object.keys(createDeletionSqlByTable()).length);
  });

  it("takes an advisory transaction lock before selecting the user row for update", async () => {
    const queries: string[] = [];
    const locked = await lockUserForDeletion(async (sql) => {
      queries.push(sql);
      return { rows: sql.includes("FOR UPDATE") ? [{ id: "user-1" }] : [] };
    }, "user-1");

    expect(locked).toBe(true);
    expect(queries[0]).toContain("pg_advisory_xact_lock");
    expect(queries[1]).toContain("FOR UPDATE");
  });
});

describe("isRussianDeletionIntent", () => {
  it("accepts /forget_me", () => {
    expect(isRussianDeletionIntent("/forget_me")).toBe(true);
  });

  it("accepts clear Russian deletion phrases", () => {
    expect(isRussianDeletionIntent("пожалуйста, удали мои данные")).toBe(true);
  });

  it("rejects obvious negated deletion phrases", () => {
    expect(isRussianDeletionIntent("не удаляй мои данные")).toBe(false);
    expect(isRussianDeletionIntent("я не хочу удалить мои данные")).toBe(false);
  });
});

function snapshotRows(repository: MemoryDeletionRepository): Record<string, string[]> {
  return Object.fromEntries([...repository.rows.entries()].map(([table, rows]) => [table, [...rows].sort()]));
}

async function waitForCall(repository: MemoryDeletionRepository, call: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (repository.calls.includes(call)) {
      return;
    }
    await Promise.resolve();
  }
}
