import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { QueryResultRow } from "pg";
import type { TenantQueryable } from "./tenantStore.js";

export const TENANT_STORE_SCHEMA_COMPONENT = "C3 Tenant-Scoped Store";
export const TENANT_STORE_SCHEMA_VERSION = "TKT-021@0.1.0";

export interface RunMigrationsOptions {
  schemaPath?: string;
  schemaSql?: string;
  expectedVersion?: string;
}

interface SchemaMigrationRow extends QueryResultRow {
  version: string;
}

export class SchemaVersionError extends Error {
  public readonly expectedVersion: string;
  public readonly observedVersion: string | null;

  constructor(expectedVersion: string, observedVersion: string | null) {
    super(
      `Tenant store schema version mismatch: expected ${expectedVersion}, observed ${observedVersion ?? "missing"}`
    );
    this.name = "SchemaVersionError";
    this.expectedVersion = expectedVersion;
    this.observedVersion = observedVersion;
  }
}

export async function runMigrations(db: TenantQueryable, options: RunMigrationsOptions = {}): Promise<void> {
  const schemaSql = options.schemaSql ?? (await loadSchemaSql(options.schemaPath));
  // schema.sql is composed of idempotent DDL with IF NOT EXISTS
  // guards; PostgreSQL DDL triggers implicit commits per statement,
  // so we deliberately do NOT wrap this in a transaction. On
  // partial failure, re-running runMigrations is safe because every
  // CREATE / ALTER is idempotent.
  await db.query(schemaSql);

  // Apply additive migration files from migrations/ directory.
  // Each file is idempotent (IF NOT EXISTS guards) and is applied
  // in sorted order. These files duplicate DDL already in schema.sql
  // so that the migrations/ directory serves as a standalone
  // migration path for incremental deployments.
  const migrationFiles = await loadMigrationFiles();
  for (const sql of migrationFiles) {
    await db.query(sql);
  }

  await validateSchemaVersion(db, options.expectedVersion ?? TENANT_STORE_SCHEMA_VERSION);
}

export async function validateSchemaVersion(
  db: TenantQueryable,
  expectedVersion = TENANT_STORE_SCHEMA_VERSION
): Promise<void> {
  const result = await db.query<SchemaMigrationRow>(
    "SELECT version FROM schema_migrations WHERE component = $1",
    [TENANT_STORE_SCHEMA_COMPONENT]
  );
  const observedVersion = result.rows[0]?.version ?? null;
  if (observedVersion !== expectedVersion) {
    throw new SchemaVersionError(expectedVersion, observedVersion);
  }
}

async function loadMigrationFiles(): Promise<string[]> {
  const migrationsDir = resolve(process.cwd(), "migrations");
  let entries: string[];
  try {
    const { readdir } = await import("node:fs/promises");
    entries = (await readdir(migrationsDir)).filter((e) => e.endsWith(".sql")).sort();
  } catch {
    // migrations/ directory is optional; if it does not exist, return empty
    return [];
  }
  const sqls: string[] = [];
  for (const entry of entries) {
    const sql = await readFile(resolve(migrationsDir, entry), "utf8");
    sqls.push(sql);
  }
  return sqls;
}

async function loadSchemaSql(schemaPath?: string): Promise<string> {
  const resolvedPath = schemaPath ?? resolve(process.cwd(), "src/store/schema.sql");
  return readFile(resolvedPath, "utf8");
}
