/**
 * Shared PostgreSQL integration-test harness using testcontainers.
 *
 * Boots a `postgres:17` container per test file, applies `src/store/schema.sql`
 * + all migrations in sorted order, and returns a typed `pg.Pool` plus a
 * `cleanup` function that must be called in `afterAll`.
 *
 * Prerequisite: Docker must be running on the host.
 * @see tests/_helpers/README.md
 */

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

export interface PostgresTestContext {
  /** Connected pg Pool; schema.sql + all migrations applied. */
  pool: Pool;
  /** The running testcontainers instance (rarely needed directly). */
  container: StartedPostgreSqlContainer;
  /**
   * Stop the container and close the pool.
   * Call in `afterAll` to guarantee teardown even on test failure.
   */
  cleanup: () => Promise<void>;
}

/**
 * Start a `postgres:17` container, apply schema.sql + migrations/, and
 * return a `{ pool, container, cleanup }` context.
 *
 * Typical usage at the top of an integration test file:
 *
 * ```ts
 * let pool: Pool;
 * let cleanup: () => Promise<void>;
 *
 * beforeAll(async () => {
 *   const ctx = await withPostgres();
 *   pool = ctx.pool;
 *   cleanup = ctx.cleanup;
 * }, 60_000);
 *
 * afterAll(async () => { await cleanup(); });
 * ```
 *
 * The container is started once per file (not per individual test) to
 * keep wall-clock time reasonable while maintaining test isolation
 * between files.
 */
export async function withPostgres(): Promise<PostgresTestContext> {
  const container = await new PostgreSqlContainer("postgres:17").start();
  const connectionString = container.getConnectionUri();
  const pool = new Pool({ connectionString });

  try {
    // 1. Apply canonical schema (idempotent DDL with IF NOT EXISTS guards)
    const schemaSql = readFileSync(
      resolve(process.cwd(), "src/store/schema.sql"),
      "utf8",
    );
    await pool.query(schemaSql);

    // 2. Apply additive migration files in sorted order
    const migrationsDir = resolve(process.cwd(), "migrations");
    const entries = readdirSync(migrationsDir)
      .filter((e) => e.endsWith(".sql"))
      .sort();
    for (const entry of entries) {
      const sql = readFileSync(resolve(migrationsDir, entry), "utf8");
      await pool.query(sql);
    }

    return {
      pool,
      container,
      cleanup: async () => {
        await pool.end();
        await container.stop();
      },
    };
  } catch (err) {
    // If schema/migration application fails, still clean up the container
    await pool.end();
    await container.stop();
    throw err;
  }
}
