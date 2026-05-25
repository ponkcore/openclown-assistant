# tests/\_helpers — Integration Test Infrastructure

## Prerequisite: Docker

The integration tests in `tests/db/` use [testcontainers-node](https://github.com/testcontainers/testcontainers-node)
to spin up an ephemeral `postgres:17` container. **A running Docker daemon is
required.** If Docker is not available, `npm run test:integration` will fail,
but `npm test` (unit suite) continues to pass normally.

## Running integration tests

```bash
npm run test:integration
```

This script runs **only** the integration test files under `tests/db/` and
excludes them from the default `npm test` run, so unit tests remain
Docker-free.

## Harness API

`tests/_helpers/postgres.ts` exports:

- **`withPostgres()`** — boots a `postgres:17` container, applies
  `src/store/schema.sql` and all `migrations/*.sql`, and returns a
  `PostgresTestContext` with:
  - `pool` — a connected `pg.Pool` ready for queries;
  - `container` — the `StartedPostgreSqlContainer` instance;
  - `cleanup()` — call in `afterAll` to stop the container and close the pool.

Container lifetime is **per test file** (started in `beforeAll`, stopped in
`afterAll`). This provides good isolation between files while keeping
wall-clock time reasonable.

## Image pinning

The container image is currently referenced by tag only (`postgres:17`).
TKT-043@0.1.0 will pin the image to a specific digest per ADR-019@0.1.0.
