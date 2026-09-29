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

Other HTTP 422 outcomes are `NO_MEDIA_PROVIDER_CONFIGURED`, `NO_SEARCH_TERMS`, `NO_VIDEO_RESULTS` and `NO_PRODUCTION_MATERIALS`. A provider that is reachable but failing returns HTTP 502; a filesystem fault during local material staging returns HTTP 500 with `MATERIAL_DISCOVERY_FAILED`.

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

## Material acquisition

Phase 3B also acquires the footage the render will use, and stages it where MoneyPrinterTurbo can read it. The request carries `video_source: "local"` plus an explicit `video_materials` list of bare filenames, so the render is deterministic and MoneyPrinterTurbo never reaches the internet.

`services/shorts-material-service.js` collects the plan's `visual_search_terms`, expands abstract terms into concrete ones, and tries each phrasing against every configured provider in order (`REZS_STOCK_PROVIDER_ORDER`, default `pixabay,pexels,coverr`). The first usable asset wins. A provider returning nothing, being rate limited, timing out or being briefly unreachable moves on to the next source; a credential fault (`CONFIG_ERROR`) aborts immediately, because it would fail identically for every term.

Assets are rejected when the staged file is missing, when the same `provider:asset_id` was already selected for another scene, or when the resolution is below 720x720. Downloads are capped by `REZS_STOCK_MAX_ASSET_BYTES`, restricted to HTTPS against a per-provider host allowlist, and written to a temporary file that is renamed into place only once complete.

With no provider key configured, the service falls back to scanning a local directory (`REZS_SHORTS_MATERIALS_DIR`, staged into `REZS_MPT_LOCAL_VIDEOS_DIR`). A missing directory means "nothing staged"; any other filesystem error is reported as `MATERIAL_DISCOVERY_FAILED` rather than silently producing an empty list.

A preparation that acquires no usable material is `REJECTED` with `NO_PRODUCTION_MATERIALS` and stores no specification, so a render with nothing to show can never be submitted.

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
