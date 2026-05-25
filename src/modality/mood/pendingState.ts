/**
 * C20 Mood Logger — in-memory pending-inference state with 5-minute TTL.
 *
 * Per PRD-003@0.1.3 §5 US-4: inferred scores enter a PENDING-CONFIRM state
 * with a 5-minute TTL. If the user doesn't confirm within 5 minutes, the
 * pending inference is silently discarded and the next message is treated
 * as a fresh independent input.
 *
 * NOT persistent — bot restart loses pending state. Acceptable per US-4:
 * 5-minute window, conversational context.
 *
 * Expired entries are evicted lazily on next read (no background sweeper).
 */

/** Pending inference entry. */
export interface PendingInference {
  inferredScore: number;
  inferredComment: string | null;
  expiresAt: number;
}

/** 5-minute TTL in milliseconds. */
export const PENDING_TTL_MS = 5 * 60 * 1000;

/**
 * Clock abstraction for testability.
 * Production uses Date.now; tests inject a controllable clock.
 */
export type Clock = () => number;

export const defaultClock: Clock = () => Date.now();

/**
 * In-memory map of pending mood inferences per user.
 * Keyed by userId; one pending inference per user at a time
 * (a new inference replaces any prior pending one).
 */
export class PendingMoodState {
  private readonly map = new Map<string, PendingInference>();
  private readonly clock: Clock;
  private readonly ttlMs: number;

  constructor(clock: Clock = defaultClock, ttlMs: number = PENDING_TTL_MS) {
    this.clock = clock;
    this.ttlMs = ttlMs;
  }

  /**
   * Store a pending inference for a user.
   * Overwrites any existing pending inference for that user.
   */
  set(userId: string, inferredScore: number, inferredComment: string | null): void {
    this.map.set(userId, {
      inferredScore,
      inferredComment,
      expiresAt: this.clock() + this.ttlMs,
    });
  }

  /**
   * Get the pending inference for a user, if any.
   * Returns null if no pending inference exists or if it has expired.
   * Expired entries are evicted lazily.
   */
  get(userId: string): PendingInference | null {
    const entry = this.map.get(userId);
    if (!entry) {
      return null;
    }
    if (this.clock() >= entry.expiresAt) {
      // Lazy eviction: expired entry is removed
      this.map.delete(userId);
      return null;
    }
    return entry;
  }

  /**
   * Get the pending inference for a user including expired ones.
   * Returns null if no pending inference ever existed.
   * Returns the entry with an `isExpired` flag.
   * Does NOT evict expired entries — caller must call remove() if needed.
   */
  getIncludingExpired(userId: string): { entry: PendingInference; isExpired: boolean } | null {
    const entry = this.map.get(userId);
    if (!entry) {
      return null;
    }
    return {
      entry,
      isExpired: this.clock() >= entry.expiresAt,
    };
  }

  /**
   * Remove the pending inference for a user (after confirmation or override).
   */
  remove(userId: string): void {
    this.map.delete(userId);
  }

  /**
   * Check if a user has a pending (non-expired) inference.
   */
  has(userId: string): boolean {
    return this.get(userId) !== null;
  }
}
