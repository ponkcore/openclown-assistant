---
id: ADR-007
title: Data Hosting Jurisdiction Shortlist
status: proposed
arch_ref: ARCH-001@0.2.0
created: 2026-04-26
updated: 2026-04-26
superseded_by: null
---

# ADR-007: Data Hosting Jurisdiction Shortlist

## Context
PRD-001@0.2.0 §7 leaves stored-record hosting jurisdiction for PO selection from an Architect shortlist. Stored records include biometric profile, transcripts, confirmed/manual meals, summaries, and audit logs. Raw voice/photo media is not retained. PO Q4 asked for RU domestic, EU, US, and hybrid options with concrete cost, latency-from-RU-user, and legal-exposure trade-offs. The current pilot VPS is temporary but is the resource floor.

## Options Considered (>=3 real options, no strawmen)
### Option A: RU domestic provider such as Selectel
- Description: Host the Postgres volume and OpenClaw skill on a Russian provider, with Selectel as the concrete reference provider.
- Pros (concrete): Selectel advertises Russian cloud servers in 3 regions, 6 availability zones, 17 pools, up to 10 Gbit/s network, 3 TB free traffic, DDoS protection, and 152-FZ positioning (<https://selectel.ru/services/cloud/servers/>). This minimizes Russian-user-to-storage RTT if both users are in Russia.
- Cons (concrete, with sources): If model providers remain Fireworks/OpenAI/other non-RU endpoints, model-bound data still leaves RU jurisdiction for inference. RU domestic hosting also concentrates legal exposure in Russian personal-data rules and may complicate future EU/US customer expansion.
- Cost / latency / ops burden: Selectel lists Standard Line from 948.50 RUB/month (<https://selectel.ru/services/cloud/servers/>). From the current VPS, `ping speedtest.selectel.ru` averaged 37.1 ms on 2026-04-26; RU users to RU hosting should usually be lower, but must be measured at deploy.

### Option B: EU provider such as Hetzner Germany/Finland
- Description: Keep stored records on an EU VPS or EU volume-backed Postgres, using Hetzner Germany/Finland as the reference provider if migrating.
- Pros (concrete): Hetzner documents cloud locations in Germany and Finland (`fsn1`, `nbg1`, `hel1`) and says its Germany/Finland data center parks are ISO/IEC 27001 certified (<https://docs.hetzner.com/cloud/general/locations/>). Hetzner states GDPR compliance and 99.9% uptime promise on its cloud page (<https://www.hetzner.com/cloud/>). EU GDPR is a single legal framework for personal data and applies throughout the EEA (<https://commission.europa.eu/law/law-topic/data-protection/legal-framework-eu-data-protection_en>).
- Cons (concrete, with sources): Russian-user latency is higher than local RU hosting if users are in Russia. EU hosting does not solve inference transfers to non-EU model providers unless model/provider data processing is separately constrained.
- Cost / latency / ops burden: Current VPS-to-Hetzner `fsn1` averaged 1.2 ms and `hel1` averaged 25.4 ms on 2026-04-26, indicating the current host is likely already near Hetzner Germany; RU users should be validated with user-side telemetry. VPS cost is already sunk for v0.1.

### Option C: US provider such as DigitalOcean US region
- Description: Move stored records to a US VPS/provider region.
- Pros: DigitalOcean droplets start at $4/month for 512 MiB and $6/month for 1 GiB, with predictable monthly caps (<https://www.digitalocean.com/pricing/droplets>). It provides broad tooling and regions including New York/San Francisco per the pricing page.
- Cons: Worst fit for Russian-language pilot latency and legal exposure. US hosting adds cross-border personal-data considerations without a product need.
- Cost / latency / ops burden: Low infra cost, but `ping nyc3.digitaloceanspaces.com` averaged 87.4 ms from the current VPS on 2026-04-26, and RU-user RTT would typically be higher than EU/RU options.

### Option D: Hybrid storage in RU/EU with non-retained remote model processing
- Description: Keep durable Postgres records in RU or EU, but send transient text/audio/photo payloads to OmniRoute/Fireworks providers for inference, deleting raw media locally after extraction.
- Pros: Matches the actual v0.1 architecture: durable records stay in the selected jurisdiction while inference providers process only bounded transient payloads. Avoids forcing local GPU/STT/VLM onto the VPS.
- Cons: This is not pure data localization; transcripts, meal text, and photos may cross borders transiently for inference. Requires clear logging that raw media is deleted locally and no raw prompts/media are stored in logs.
- Cost / latency / ops burden: Same storage cost as Option A or B; inference latency includes provider round trip; ops burden is medium because data-flow documentation must be precise.

## Decision
We will recommend **Option B with Option D's processing pattern: EU durable storage on the current/portable VPS, with transient remote inference via OmniRoute/Fireworks and no raw media retention**.

Ranked shortlist for PO selection:
- Rank 1: EU durable storage, Hetzner Germany/Finland style. Best balance for the existing VPS, GDPR framework, low cost, and future non-RU product direction.
- Rank 2: RU domestic durable storage, Selectel style. Best if PO prioritizes Russian data-localization posture and RU-user RTT above future cross-border portability.
- Rank 3: Hybrid RU durable storage plus remote inference. Viable if RU storage is selected, but it must be documented as hybrid because inference still leaves RU.
- Rank 4: US durable storage. Technically simple, but weakest for the Russian pilot because latency/legal exposure increase without PRD benefit.

Why the losers lost:
- Option A: It is a strong legal-locality choice for RU users, but the pilot already depends on non-RU inference providers and the current VPS appears EU-located.
- Option C: US hosting adds latency and legal exposure without improving any KPI.
- Option D: Hybrid is the unavoidable processing pattern, not a standalone durable-storage jurisdiction.

## Consequences
- Positive: The architecture can proceed with EU durable storage while explicitly documenting transient inference transfers and allowing PO to select RU if desired.
- Negative / trade-offs accepted: Final jurisdiction remains a PO ratification item before `accepted` status; telemetry must validate user-perceived latency during pilot.
- Follow-up work: ARCH-001@0.2.0 §12 must keep OQ-3 open until PO records the selected jurisdiction, and §10 must include a VPS migration runbook that moves Docker volumes and secrets.

## References
- Selectel cloud servers: <https://selectel.ru/services/cloud/servers/>
- Hetzner cloud locations: <https://docs.hetzner.com/cloud/general/locations/>
- Hetzner cloud page: <https://www.hetzner.com/cloud/>
- DigitalOcean droplet pricing: <https://www.digitalocean.com/pricing/droplets>
- European Commission EU data protection legal framework: <https://commission.europa.eu/law/law-topic/data-protection/legal-framework-eu-data-protection_en>
- Architect ping measurements from current VPS on 2026-04-26: Selectel avg 37.1 ms, Hetzner `fsn1` avg 1.2 ms, Hetzner `hel1` avg 25.4 ms, DigitalOcean NYC endpoint avg 87.4 ms.
