# Shorts production execution (Phase 3C)

Phase 3C executes a `PRODUCTION_READY` Phase 3B specification through the existing MoneyPrinterTurbo adapter. It does not regenerate content, weaken quality gates, publish to YouTube, schedule content, run analytics, batch jobs, or add n8n/Hermes automation.

## Architecture and provenance

The persisted chain is:

```text
shorts_planning_jobs
  → shorts_production_preparations
    → production_jobs
      → MoneyPrinterTurbo task ID
        → securely downloaded and validated MP4
```

`production_jobs` retains the planning and preparation IDs, MPT task ID, lifecycle, retry/error fields, artifact reference/path, validation result, and completion timestamp. The approved script and complete MPT request remain immutable in the Phase 3B preparation record and are queryable with the chain.

## API

Start and synchronously execute bounded production:

```bash
curl -sS -X POST http://localhost:3456/api/production/shorts/short_prep_ID/start \
  -H "x-api-key: $API_KEY"
```

Retrieve persisted state and the full provenance chain without mutating it:

```bash
curl -sS http://localhost:3456/api/production/shorts/short_prod_ID
```

Only a preparation with status `PRODUCTION_READY`, a passing quality result, and an MPT request is accepted. The exact approved `video_subject`, `video_script`, `video_terms`, and vertical `video_aspect` are submitted unchanged.

## State machine and idempotency

```text
QUEUED → SUBMITTED → RUNNING → SUCCEEDED → ARTIFACT_DOWNLOADED
                            ↘ FAILED
                            ↘ CANCELLED
                            ↘ TIMEOUT
```

The production ID is deterministically derived from the preparation ID, which is also unique in `production_jobs`. Starting the same preparation again reuses active/successful work and never creates a second MPT task. A terminal failed production is preserved and returns `PRODUCTION_ALREADY_EXISTS`; retry policy cannot silently erase its provenance.

Polling uses the existing bounded `MoneyPrinterTurboProductionService`. Submission, timeout, MPT failure, download failure, and validation failure remain explicit persisted states.

## Artifact security and validation

Downloads use the existing adapter protections: relative destinations under `MPT_ARTIFACT_DIR`, same-origin remote URLs, traversal and symlink rejection, no overwrite, non-empty output, temporary file, and atomic rename. The response body is streamed to that temporary file rather than buffered in memory, so peak memory does not scale with artifact size, and a transfer that dies mid-stream leaves neither a destination file nor a leftover part file.

After download, Phase 3C additionally requires:

- a regular, non-empty MP4 container;
- video and audio streams;
- vertical 9:16 orientation and at least 720×1280 resolution;
- H.264/HEVC/VP9/AV1 video and AAC/Opus/MP3 audio;
- duration within three seconds of the approved Phase 3B duration;
- video and audio stream durations agreeing within two seconds;
- complete FFmpeg decoding of both streams from beginning to end.

The container reports the longer of its streams, so the container duration alone cannot prove the narration survived. A concat or mux mistake that leaves a full-length video track over a truncated audio track passes every other check and produces a Short that goes silent part-way through; comparing the two stream durations catches it. The two-second tolerance is wide enough for normal final-frame padding. Per-stream durations are optional, because the FFmpeg-metadata fallback cannot report them, and their absence is not treated as a failure.

FFprobe JSON is preferred; FFmpeg metadata parsing is the fallback. The validation result, size, SHA-256, container duration, per-stream durations, resolution, codecs, and both documented tolerances are persisted.

## Error codes

Phase 3C returns structured errors including `PREPARATION_NOT_FOUND`, `PREPARATION_NOT_READY`, `PRODUCTION_ALREADY_EXISTS`, `MPT_SUBMISSION_FAILED`, `MPT_TIMEOUT`, `MPT_FAILED`, `ARTIFACT_DOWNLOAD_FAILED`, and `ARTIFACT_VALIDATION_FAILED`. Credential-like values are redacted before errors are persisted or returned.

## Verification

```bash
cd agenttube
node --test test/shorts-production-execution-service.test.js
node --test test/shorts-planning-service.test.js test/shorts-production-preparation-service.test.js test/shorts-production-execution-service.test.js test/cleanapis-provider.test.js
node --test test/moneyprinterturbo.test.js
npm run test:integration
npm run lint
cd ..
git diff --check
git status --short
```

Deterministic tests inject the MPT adapter and artifact probe/decode operations. A real integration run requires a running local MoneyPrinterTurbo service, its local eSpeak provider, local vertical visual material, and usable FFmpeg tooling; no Clean APIs or paid service is required.

YouTube publishing is **not** part of Phase 3C. Scheduling, analytics, batch generation, n8n, and Hermes are also outside this phase.
