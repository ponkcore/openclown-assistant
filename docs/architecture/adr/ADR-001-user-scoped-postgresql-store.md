---
id: ADR-001
title: User-Scoped PostgreSQL Store
status: proposed
arch_ref: ARCH-001@0.2.0
created: 2026-04-26
updated: 2026-04-26
superseded_by: null
---

# ADR-001: User-Scoped PostgreSQL Store

## Context
ARCH-001@0.2.0 C3 and PRD-001@0.2.0 US-9 require storage-layer tenant isolation from day 1, not a single-tenant pilot shortcut. PRD-001@0.2.0 US-6 and US-8 also require edit/delete history, audit records, right-to-delete, and future migration to more tenants without redesign. PO OBC-1 explicitly limits this ADR to implementation choices for user-scoped isolation.

## Options Considered (>=3 real options, no strawmen)
### Option A: SQLite WAL with mandatory `user_id` predicates
- Description: Store all pilot records in one SQLite database in WAL mode, with every table carrying `user_id` and every repository method requiring `user_id`.
- Pros (concrete): Lowest ops burden; no separate DB container; very small RAM footprint; SQLite WAL allows readers and writers to proceed concurrently in most cases.
- Cons (concrete, with sources): WAL still has only one writer at a time and requires same-host shared memory, which makes multi-process and migration behavior more fragile than a network DB (<https://www.sqlite.org/wal.html>). SQLite has no built-in row-level security, so a missed predicate is an application bug, not a DB-denied query.
- Cost / latency / ops burden: $0 infra cost; expected sub-millisecond local queries; lowest ops; weaker defense-in-depth for G4/K4.

### Option B: PostgreSQL shared tables with `user_id`, composite keys, and RLS
- Description: Run PostgreSQL in Docker with one shared schema. Every user-owned table has `user_id NOT NULL`, foreign keys include `user_id` where a child references a user-owned parent, repositories require `user_id`, and row-level security policies deny rows unless the transaction-local tenant setting matches.
- Pros (concrete): PostgreSQL RLS restricts which rows can be returned or modified and uses default-deny when no policy exists after RLS is enabled (<https://www.postgresql.org/docs/current/ddl-rowsecurity.html>). Composite keys and constraints catch cross-user references at write time, which directly supports PRD-001@0.2.0 K4. The same shape scales from 2 users to paid multi-tenant without schema-per-user migrations.
- Cons (concrete, with sources): Adds a DB service and migration discipline. PostgreSQL docs warn that table owners and `BYPASSRLS` roles can bypass RLS, so the app must not connect as owner/superuser and tests must verify policies (<https://www.postgresql.org/docs/current/ddl-rowsecurity.html>).
- Cost / latency / ops burden: $0 incremental infra on the existing VPS; expected 150-300 MiB steady RAM for a small local Postgres container; local query latency typically dominated by app/SQL work, not network; medium ops burden.

### Option C: PostgreSQL schema-per-tenant
- Description: One PostgreSQL database, but each tenant gets a separate schema and identical tables; app switches schema by tenant.
- Pros (concrete): Strong human-visible separation; simpler tenant export/delete for one schema; fewer accidental cross-tenant joins if search path is locked correctly.
- Cons (concrete, with sources): Doubles migration surface per tenant and creates operational overhead before product-market proof. Future paid launch would need tenant schema lifecycle automation, which is outside PRD-001@0.2.0. It still needs application checks because `search_path` misuse can route requests to the wrong schema.
- Cost / latency / ops burden: Same DB cost as Option B; higher migration/test burden; no benefit for the 2-user pilot large enough to offset complexity.

### Option D: Managed PostgreSQL outside the VPS
- Description: Use a managed Postgres provider for stored records and connect from the OpenClaw skill.
- Pros (concrete): Provider handles backups, restarts, and many upgrades; can simplify future scaling.
- Cons (concrete, with sources): Adds monthly cost and a network dependency before v0.1 needs it. It also interacts with jurisdiction selection in ADR-007@0.1.0 and violates the PO's preference to run v0.1 on the existing self-hosted VPS unless telemetry proves pressure.
- Cost / latency / ops burden: Typically $5-20+/month for starter managed DB plans depending on provider; adds cross-network latency; lower DB maintenance but higher account/vendor surface.

## Decision
We will use **Option B: PostgreSQL shared tables with `user_id`, composite keys, and RLS**.

Why the losers lost:
- Option A: SQLite is attractive for the pilot, but its isolation guarantee is only application-level and does not meet the defense-in-depth expected by G4/K4.
- Option C: Schema-per-tenant is real isolation, but it creates migration overhead without improving the 2-user pilot UX or KPIs.
- Option D: Managed Postgres is useful later, but it spends money and introduces external dependency before resource telemetry justifies it.

## Consequences
- Positive: Every persistent entity in ARCH-001@0.2.0 C3/C11 gets a storage-layer `user_id` boundary and the end-of-pilot audit can search cross-user foreign-key anomalies.
- Negative / trade-offs accepted: Executors must implement migrations, RLS policy tests, and a non-owner app DB role; DB work is security-critical enough to assign to `executor` in tickets.
- Follow-up work: ARCH-001@0.2.0 Phase 6 must define declarative schemas with `user_id`, composite foreign keys, delete transaction boundaries, and the K4 audit query shape.

## References
- PostgreSQL Row Security Policies: <https://www.postgresql.org/docs/current/ddl-rowsecurity.html>
- SQLite Write-Ahead Logging: <https://www.sqlite.org/wal.html>
- Docker volumes for persistence and migration: <https://docs.docker.com/engine/storage/volumes/>
