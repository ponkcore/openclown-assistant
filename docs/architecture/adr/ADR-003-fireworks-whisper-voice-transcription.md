---
id: ADR-003
title: Fireworks Whisper Voice Transcription
status: proposed
arch_ref: ARCH-001@0.2.0
created: 2026-04-26
updated: 2026-04-26
superseded_by: null
---

# ADR-003: Fireworks Whisper Voice Transcription

## Context
ARCH-001@0.2.0 C5 must transcribe Russian Telegram voice messages up to 15 seconds and feed C4/C6 within PRD-001@0.2.0 G3: <=8 seconds p95 and <=30 seconds p100 while showing typing status. PRD-001@0.2.0 G5 caps combined model and voice spend at $10/month. Raw audio must be deleted immediately after extraction per PRD-001@0.2.0 §7.

## Options Considered (>=3 real options, no strawmen)
### Option A: Fireworks Whisper V3 Turbo hosted transcription
- Description: Send temporary voice clips to Fireworks Whisper V3 Turbo through the OmniRoute/audio path when available, otherwise through the runtime-level Fireworks fallback secret. Use language hint `ru`, one retry only for transport failures, and delete raw audio after success or terminal failure.
- Pros (concrete): Fireworks lists Whisper V3 Turbo at $0.0009/audio minute billed per second, far below the $10 pilot ceiling (<https://fireworks.ai/models>). It avoids local model RAM/GPU requirements on the no-GPU VPS.
- Cons (concrete, with sources): Hosted audio leaves the VPS briefly, so raw audio deletion only covers our local copy; provider-side retention must be reviewed before `accepted` status. It also depends on Fireworks account quota health behind OmniRoute.
- Cost / latency / ops burden: At a conservative 2 users x 4 voice messages/day x 15 seconds x 30 days = 60 audio minutes/month, listed model cost is about $0.054/month. Ops burden is low-to-medium.

### Option B: Fireworks Streaming ASR v2
- Description: Use the streaming ASR model rather than batch Whisper for every voice clip.
- Pros: Fireworks lists Streaming ASR v2 at $0.0035/audio minute billed per second and it is designed for low-latency streaming (<https://fireworks.ai/models>). It gives lower perceived latency for long live streams.
- Cons: PRD-001@0.2.0 caps voice clips at 15 seconds and Telegram sends a completed file, not a live microphone stream. Streaming integration adds WebSocket/session lifecycle complexity with little UX gain.
- Cost / latency / ops burden: Same 60 minutes/month costs about $0.21/month; still cheap, but about 3.9x Option A.

### Option C: Deepgram or AssemblyAI hosted ASR
- Description: Use a dedicated speech provider instead of Fireworks.
- Pros: Deepgram lists Nova speech-to-text from $0.0058/min to $0.0092/min for common PAYG models and includes concurrency numbers (<https://www.deepgram.com/pricing>). AssemblyAI lists pre-recorded Universal-2 at $0.15/hour and Universal-3 Pro at $0.21/hour (<https://www.assemblyai.com/pricing>).
- Cons: Adds another provider account/key outside the existing OmniRoute/Fireworks topology. Deepgram is about 6.4x to 10.2x Fireworks Whisper V3 Turbo by listed minute price, and AssemblyAI's strongest multilingual page emphasizes many languages but introduces a second billing console.
- Cost / latency / ops burden: About $0.15-$0.55/month for 60 minutes depending on provider/model; low raw cost but higher provider-management burden.

### Option D: Local faster-whisper on the VPS
- Description: Run a local Whisper/faster-whisper stack in the OpenClaw skill host or sidecar.
- Pros: No per-minute provider cost; keeps raw audio local; Phase 0 identified `faster-whisper` as a useful reference for future provider abstraction.
- Cons: PRD-001@0.2.0 v0.1 locks Node 24 TypeScript skills and the current VPS has no GPU. PO Q2 says resource-heavy local transcription should default remote if it risks swap/latency. Local Python/ffmpeg/CTranslate2 also adds runtime not otherwise needed.
- Cost / latency / ops burden: $0 provider cost; high RAM/CPU and packaging risk; likely misses G3 p95 under concurrent load on shared vCPU.

## Decision
We will use **Option A: Fireworks Whisper V3 Turbo hosted transcription**.

Why the losers lost:
- Option B: Streaming ASR is useful for live calls, but Telegram voice clips are bounded files and the cost/complexity delta is not justified.
- Option C: Dedicated ASR providers are viable backups, but they add account/key surface without improving the pilot's cost or topology.
- Option D: Local ASR is the right v0.2 experiment, not the v0.1 default on a no-GPU VPS.

## Consequences
- Positive: Voice cost is effectively negligible relative to the $10 ceiling, leaving budget for text/vision LLM calls.
- Negative / trade-offs accepted: Hosted ASR is an external dependency and must be covered by failure UX: first failure asks for text, second consecutive voice failure opens manual KBJU entry.
- Follow-up work: ARCH-001@0.2.0 Phase 6/7 must specify temporary audio file lifetime, provider timeout, `raw_audio_deleted` high-severity alert, and transcription success/failure metrics.

## References
- Fireworks model library for Whisper V3 Turbo and Streaming ASR v2: <https://fireworks.ai/models>
- Deepgram pricing: <https://www.deepgram.com/pricing>
- AssemblyAI pricing: <https://www.assemblyai.com/pricing>
- Phase 0 voice-skill audit in ARCH-001@0.2.0 §0.2 Capability B
