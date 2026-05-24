---
id: ADR-009
title: Local Observability and Pilot Metrics
status: proposed
arch_ref: ARCH-001@0.2.0
created: 2026-04-26
updated: 2026-04-26
superseded_by: null
---

# ADR-009: Local Observability and Pilot Metrics

## Context
PRD-001@0.2.0 §7 requires per-user latency, per-call cost, transcription success/failure rate, KBJU computation success/failure rate, and confirmation rates for US-2/US-3/US-4 to be measurable at end-of-pilot. PRD-001@0.2.0 §2 G5 caps LLM plus voice spend at $10/month and requires auto-degrade plus PO alert. ARCH-001@0.2.0 C10 therefore needs enough observability to calculate K1-K7 and debug failures without adding a new personal-data processor or exceeding the 2 GiB steady RAM ceiling.

## Options Considered (>=3 real options, no strawmen)
### Option A: Local structured JSON logs plus PostgreSQL pilot metric tables and loopback metrics endpoint
- Description: Skills emit redacted JSON logs through OpenClaw `ctx.log` to stdout. Docker captures stdout with the `json-file` driver and bounded rotation. C10 also writes durable `metric_events`, `cost_events`, `monthly_spend_counters`, and K7 labelling rows to PostgreSQL. A Prometheus-format `/metrics` endpoint is bound to `127.0.0.1` for local scrape/debug only.
- Pros (concrete): Meets every PRD-001@0.2.0 §7 observability minimum without sending PII to a third-party observability processor. Docker's default JSON file logging annotates each stdout/stderr line with timestamp and stream, and supports `max-size`/`max-file` rotation (<https://docs.docker.com/engine/logging/drivers/json-file/>). Durable KPI facts live in the same user-scoped PostgreSQL/RLS boundary as domain records, aligning with ADR-001@0.1.0.
- Cons (concrete, with sources): No hosted dashboard, no long-term log search, and local Docker log files are designed for Docker daemon access rather than direct external tooling (<https://docs.docker.com/engine/logging/drivers/json-file/>). The PO must run SQL/KPI scripts or inspect a local metrics endpoint for pilot reports.
- Cost / latency / ops burden: $0 external cost; expected additional RAM <=128 MiB for in-process metrics and no always-on dashboard stack; low latency overhead because writes are append-only metric rows.

### Option B: Prometheus plus Grafana stack on the VPS
- Description: Run Prometheus, Grafana, and possibly node/container exporters beside the KBJU stack. Skills expose metrics over HTTP; Prometheus scrapes, stores, and Grafana visualizes.
- Pros: Strong local dashboarding and alerting. Prometheus is an open-source monitoring toolkit with a pull model over HTTP and standalone local storage (<https://prometheus.io/docs/introduction/overview/>). Docker can expose daemon metrics on a loopback-bound Prometheus endpoint; Docker warns that binding to `0.0.0.0` exposes the metrics port to the wider network (<https://docs.docker.com/engine/daemon/prometheus/>).
- Cons: Adds at least two services and a dashboard credential surface for a 2-user pilot. Prometheus itself notes it is not a fit for 100% accurate per-request billing data; detailed cost/accounting facts still need durable event rows (<https://prometheus.io/docs/introduction/overview/>).
- Cost / latency / ops burden: $0 license cost; medium RAM/CPU and backup burden; more operational surface than PRD-001@0.2.0 requires.

### Option C: External SaaS observability such as Sentry or Datadog-style hosted monitoring
- Description: Send errors, traces, and logs to a hosted observability SaaS with dashboards and alerts.
- Pros: Fast setup, hosted search, and alerting. Sentry's public pricing page advertises a free developer tier and paid team tier with logs/tracing/dashboards (<https://sentry.io/pricing/>).
- Cons: Creates another third-party processor for Telegram IDs, biometric-flow metadata, meal/transcript error context, and prompt-adjacent failure events unless aggressive redaction is perfect. Paid tiers start at non-zero monthly cost on Sentry's pricing page, which is unattractive when the PRD's entire LLM+voice budget is $10/month (<https://sentry.io/pricing/>).
- Cost / latency / ops burden: External cost may be $0 initially but can become at least $26/month for team features on Sentry's advertised plan; low VPS RAM; higher privacy/compliance surface.

### Option D: OpenTelemetry collector with OTLP export to a future backend
- Description: Instrument skills with OpenTelemetry and send logs/metrics/traces to a local collector, leaving backend choice configurable.
- Pros: Standards-aligned. OTLP defines HTTP/gRPC endpoints and defaults such as `http://localhost:4318` for OTLP/HTTP and `http://localhost:4317` for OTLP/gRPC (<https://opentelemetry.io/docs/specs/otel/protocol/exporter/>).
- Cons: Adds collector config, retry policy, and another local service before the pilot has enough load to justify distributed tracing. A collector without a backend still does not solve end-of-pilot KPI queries better than durable SQL rows.
- Cost / latency / ops burden: $0 license; moderate RAM/ops; best kept as a v0.2 migration path.

## Decision
We will use **Option A: Local structured JSON logs plus PostgreSQL pilot metric tables and loopback metrics endpoint**.

Implementation rules:
- JSON logs are diagnostic only and must not contain raw prompts, raw transcripts beyond high-level status, raw audio/photo bytes, provider keys, Telegram bot tokens, or full Telegram usernames.
- KPI facts needed for PRD-001@0.2.0 K1-K7 are durable C3 records, not scraped metrics, so right-to-delete can remove user-scoped observability facts.
- Prometheus-format metrics must not label by Telegram user ID or internal `user_id`; per-user analysis comes from C3 SQL with RLS-aware repository methods.
- The metrics endpoint binds to `127.0.0.1` or a Docker-internal network only; it is not exposed publicly.
- Docker log rotation must be configured with bounded size and file count to prevent logs from consuming the 75 GB VPS disk.

Why the losers lost:
- Option B: Good dashboards, but too much steady-state service surface for a two-user pilot and still insufficient for accurate cost accounting.
- Option C: Good hosted UX, but adds a privacy processor and likely cost outside the PRD's tight pilot budget.
- Option D: Good future standardization path, but a collector/backend is unnecessary before v0.1 telemetry proves a need.

## Consequences
- Positive: End-of-pilot KPI reporting is deterministic SQL over the same tenant-isolated store used by the product, and no new external observability vendor receives pilot data.
- Negative / trade-offs accepted: The PO gets SQL/exported metrics rather than polished dashboards in v0.1.
- Follow-up work: Tickets must define C10 event names, log redaction tests, SQL KPI queries, Docker log rotation settings, and a local-only metrics endpoint.

## References
- Docker JSON file logging driver and rotation options: <https://docs.docker.com/engine/logging/drivers/json-file/>
- Docker daemon Prometheus metrics binding warning: <https://docs.docker.com/engine/daemon/prometheus/>
- Prometheus overview and fit/non-fit notes: <https://prometheus.io/docs/introduction/overview/>
- OpenTelemetry OTLP exporter endpoints and defaults: <https://opentelemetry.io/docs/specs/otel/protocol/exporter/>
- Sentry pricing: <https://sentry.io/pricing/>
- PostgreSQL row-level security behavior: <https://www.postgresql.org/docs/current/ddl-rowsecurity.html>
- PRD-001@0.2.0 §2 G5, §6 K1-K7, and §7 Observability minimums
