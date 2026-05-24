# LLM routing & cost envelope

> Required reading for: **Architect** (designs the routing / failover policy in an ADR), **Executor** (calls models through the agreed config, never via raw provider keys), **Reviewer** (verifies no skill bypasses the router).
> Helpful for: **Business Planner** (sanity-checks LLM-budget figures in PRD §7).

## Topology

```
[skill code]
     │
     ▼
[OmniRoute]  ← primary router (PO operates ≈30 Fireworks accounts × $50 quota)
     │  failure / quota exceeded
     ▼
[direct provider key]  ← fallback only (OpenAI, Anthropic, Fireworks direct)
```

Sources:
- OmniRoute: <https://github.com/diegosouzapw/OmniRoute>
- Fireworks model catalogue: <https://fireworks.ai/models>
- OpenRouter (free-tier reference): <https://openrouter.ai/models?fmt=cards&order=newest&q=free>

## Hard rules for Architect / Executor

1. **All LLM calls go through OmniRoute first.** A skill that hard-codes a provider URL is a finding (high-severity in CODE review).
2. **OmniRoute config lives in `infra/`** (Architect adds in an ADR; Executor only edits when a Ticket lists it in §5 Outputs).
3. **Direct provider keys are env-vars** declared in `.env.example`, never committed.
4. **Per-call budget guard:** every skill that calls an LLM must declare a `max_input_tokens` and `max_output_tokens` budget in its manifest; exceeding it is a runtime error, not a silent over-spend.
5. **Failover is openclaw's job** at the transport layer — but per-call retry policy belongs in the skill (idempotent retries only; no retries on prompt-injection-suspicious responses).

## Model assignment

Model picks for the SDLC pipeline (Sisyphus orchestrator's executor / reviewer / architect-consult subagents) and for the production runtime are configured in `~/.config/opencode/oh-my-openagent.json` and in any `.opencode/agents/*.md` frontmatter override. Models are intentionally **not pinned** in this repo so the PO can swap them as the model landscape changes.

The only hard rule is **the reviewer model family must differ from the executor model family** — same-family judgments are too correlated to catch cross-cutting failure modes. Beyond that constraint, choose the cheapest viable model per role; revisit when a router-level pilot shows a different option is materially better.

When designing TKT §7 / ADR routing decisions that mention specific recent models, consult the model card from the provider directly. Models post-dating your training-data cutoff exist; do not extrapolate from older similarly-named models.

## Cost envelope (sanity reference; PRD §7 must restate concrete numbers)

- **Whisper-class transcription:** ≈ $0.006 / min. For 2 users × ≈4 voice messages / day × ≈10 s each ≈ $1.50 / month.
- **Per-meal LLM call:** thinking-class model via OmniRoute → Fireworks ≈ $0.005–0.02 / call (depends on prompt size). ≈4 meals / user / day × 2 users × 30 days ≈ 240 calls / mo ≈ $1–5 / mo.
- **Daily / weekly summary:** ≈9 calls / week × $0.02 ≈ $0.20 / mo.

Total v0.1 LLM spend for 2 users: order-of-magnitude **$5–10 / month**. PRD §7 should set a hard ceiling at e.g. $20/mo as a buffer; Architect must add an ADR if their design pushes past it.

## What the Reviewer looks for in CODE mode

- No `process.env.OPENAI_API_KEY` (or similar) inside skill code — must go through `ctx.secrets` and OmniRoute.
- No hard-coded model name inside skill business logic — model is config-driven via the OmniRoute manifest.
- No `console.log(prompt)` or similar (would leak prompts including PII).
- Idempotent retries only — tax of retrying on a transient failure is fine, retrying on "the model said something weird" is not.

## Future work

- Local LLM (e.g. self-hosted weights via vLLM on the VPS) once user count > 5. Out of v0.1 scope.
- Per-user spend caps with explicit user-facing quota messaging. Out of v0.1 scope.
