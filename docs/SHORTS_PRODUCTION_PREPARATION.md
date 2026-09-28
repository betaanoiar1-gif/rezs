# Shorts production preparation (Phase 3B)

Phase 3B applies a deterministic quality gate to a successful Phase 3A planning job and persists a production-ready MoneyPrinterTurbo specification. It does not submit rendering work, render media, publish, or schedule content.

## API

Prepare a successful planning job:

```bash
curl -sS -X POST http://localhost:3456/api/planning/shorts/short_plan_JOB_ID/prepare-production \
  -H "x-api-key: $API_KEY"
```

Retrieve the durable result:

```bash
curl -sS http://localhost:3456/api/production-preparations/shorts/short_prep_ID
```

A passing gate returns `PRODUCTION_READY`. A mandatory failure returns HTTP 422 with `QUALITY_GATE_FAILED`; the `REJECTED` preparation and all failures remain available through the retrieval endpoint. Preparation IDs are derived deterministically from the planning-job ID, and `planning_job_id` is unique, so retries update the same record rather than creating duplicate work.

## Mandatory quality gates

The service checks:

- topic, content angle, hook, and narration;
- total duration of 60–120 seconds;
- consecutive ordered scenes forming a contiguous timeline equal to total duration;
- positive scene durations, scene narration, visual descriptions, and search terms;
- title, description, hashtags, and category;
- valid HTTP(S) source records whenever research or verification is claimed;
- real AI provider/model provenance and a passing Phase 3A validation result.

Provenance explicitly records AI generation, whether a research provider was invoked, and whether fact-checking was supported by source records. AI generation alone is never labeled research or fact-checking.

The stored specification contains the validated scenes and metadata plus an `mpt_request` with `video_subject`, `video_script`, `video_terms`, and vertical `video_aspect`. Phase 3B does not call `MoneyPrinterTurboClient.create_video`; rendering remains a separate, explicit later action through the existing Phase 2D adapter.

## Verification

From `agenttube/`:

```bash
node --test test/shorts-production-preparation-service.test.js
node --test test/shorts-planning-service.test.js test/shorts-production-preparation-service.test.js test/cleanapis-provider.test.js
npm run test:integration
npm run lint
cd ..
git diff --check
git status --short
```
