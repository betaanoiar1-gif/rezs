# Topic-to-YouTube-Shorts planning (Phase 3A)

Phase 3A turns one topic into a persisted, validated planning artifact. It does **not** render media, submit MoneyPrinterTurbo work, or upload/publish to YouTube.

## Setup

From `agenttube/`:

```bash
npm install
npm run credentials:setup
```

The workflow uses AgentTube's existing AI text-provider configuration. It does not select a paid provider or fall back to template-generated content. At least one provider supported by `AITextService` must be explicitly configured. API mutations use the existing optional `API_KEY` protection.

`AITextService` selects the first provider whose key variable is set, in this order: `CLEANAPIS_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `MOONSHOT_API_KEY`, `MIMO_API_KEY`, `GLM_API_KEY`, then `GEMINI_API_KEY`. Every provider except Gemini speaks the OpenAI chat-completions protocol, so each accepts a `<PROVIDER>_BASE_URL` override (`OPENAI_BASE_URL`, `CLEANAPIS_BASE_URL`, `MOONSHOT_BASE_URL`, and so on) pointing at a self-hosted gateway, regional endpoint or proxy. The override must be an absolute `http`/`https` URL and is validated at construction; unset, each provider uses its documented endpoint. Clean APIs publishes no model list, so `CLEANAPIS_MODEL` is required for it — the service refuses to guess a model rather than borrowing another provider's default.

There is no automatic failover between providers. The selected provider is used for all three planning agents, and a provider failure fails the job rather than silently degrading to a template.

AgentTube currently has no configured general-purpose factual research provider. Consequently, normal artifacts contain empty `research.sources`, set `research.claimed_verified` to `false`, and include a warning that the plan is not fact-checked. A research integration may only claim verification when it returns real source records with titles and HTTP(S) URLs.

## API

Create a plan:

```bash
curl -sS -X POST http://localhost:3456/api/planning/shorts \
  -H 'Content-Type: application/json' \
  -H "X-API-Key: $API_KEY" \
  --data '{"topic":"Why do astronauts appear weightless in space?"}'
```

Retrieve the durable job:

```bash
curl -sS http://localhost:3456/api/planning/shorts/short_plan_JOB_ID
```

A successful create returns HTTP 201 and a `SUCCEEDED` job. Invalid topics return HTTP 400. Missing provider setup returns HTTP 503 with `AI_PROVIDER_UNAVAILABLE`; the corresponding job is persisted as `BLOCKED`, and its ID is returned in `error.details.job_id`. Provider or validation failures return HTTP 502 and persist a `FAILED` job. Job IDs use the stable `short_plan_<UUID>` format.

Planning records live in `shorts_planning_jobs`, separate from `production_jobs`.

## Artifact and validation

The artifact contains:

- topic, angle, audience, and content type;
- research availability, findings, verification flag, and source records;
- opening hook and narration script;
- ordered scenes with narration segments, visual guidance, search terms, and timing;
- a total narration estimate computed at 150 spoken words per minute;
- title, description, hashtags, and YouTube category;
- AI provider provenance, warnings, and explicit validation checks.

Validation rejects absent topics, scripts, hooks, scenes, or metadata; duration outside 60–120 seconds; malformed/non-HTTP source URLs; and claimed verification without source records. Strategy, script, and SEO results must report `metadata.generationSource: "ai"`; template fallback is treated as generation failure.

## Verification

Mocked deterministic tests (not live AI execution):

```bash
cd agenttube
node --test test/shorts-planning-service.test.js
npm test
npm run test:integration
npm run lint
cd ..
git diff --check
```

A real topic execution is only attempted when an AI text provider is configured. If no provider credentials are available, live execution is **BLOCKED**, not passed or simulated. Test fixtures exercise the orchestration and validation logic but do not constitute factual verification or live-provider evidence.
