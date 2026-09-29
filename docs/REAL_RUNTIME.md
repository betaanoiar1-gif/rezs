# REZS real runtime

The repository is the source of truth. Colab is only an execution environment.

## Real Shorts production path

1. A successful Phase 3A planning job is stored in `shorts_planning_jobs`.
2. Phase 3B validates that immutable planning artifact, acquires video material, and creates `PRODUCTION_READY`.
3. Phase 3C submits the exact persisted `specification.mpt_request` to MoneyPrinterTurbo.
4. Phase 3C polls the MPT task until completion.
5. The returned artifact reference is normalized and streamed into the configured REZS artifact directory.
6. The downloaded MP4 is validated for container, video/audio streams, vertical 9:16 geometry, minimum 720x1280 resolution, supported codecs, duration tolerance, agreement between the video and audio stream durations, full FFmpeg decode, size and SHA-256.
7. Only a validated artifact reaches `SUCCEEDED / ARTIFACT_DOWNLOADED`.

Material acquisition in step 2 uses the configured stock providers in fallback
order. When no provider key is set, preparation falls back to scanning a local
materials directory. A preparation that acquires no usable material is
`REJECTED` with `NO_PRODUCTION_MATERIALS` and stores no specification, so an
empty render can never be submitted.

## Whole-pipeline runner

Proves every stage in one process, from a topic to a validated file:

```bash
cd agenttube
node scripts/e2e-full-pipeline.js "why cold water swimming improves focus"
```

It runs the real services, the real MoneyPrinterTurbo HTTP API, real FFmpeg and
the real SQLite schema, then re-probes the delivered file independently rather
than trusting the validation record the pipeline just wrote. It checks aspect
ratio, resolution, both stream durations and the presence of audio against the
file itself, and writes `data/e2e-full-pipeline.json`.

Two inputs can be supplied locally when their upstream is unreachable. Each one
is named in the report, so a run is never mistaken for a fully live one:

- `REZS_E2E_LOCAL_AI=true` — answer the planning prompts from a local
  OpenAI-compatible endpoint the script starts itself. The agents, prompts,
  JSON parsing, schema validation and the rule that refuses template fallback
  all run unchanged; only the model host differs. This relies on the
  `<PROVIDER>_BASE_URL` override.
- `REZS_E2E_SEED_MATERIALS=true` — synthesise vertical clips with FFmpeg
  instead of downloading stock footage.

With provider keys present and both flags unset, the same script is a fully
live run.

## Reproducible Phase 3B to 3C smoke runner

For the narrower case where a planning job already exists:

```bash
cd agenttube
PLANNING_JOB_ID=<existing-succeeded-planning-job> node scripts/phase3c-real-smoke.js
```

Optional environment variables:

- `MPT_BASE_URL` (default `http://127.0.0.1:8080`, matching MoneyPrinterTurbo's own `listen_port`)
- `MPT_POLL_INTERVAL_MS` (default 2000)
- `MPT_MAX_POLLS` (default 300)
- `REZS_SHORTS_LOCAL_MATERIALS_ONLY=true` to force the local directory scan instead of the stock providers

The smoke runner deliberately does not create synthetic production records or
bypass Phase 3B. It consumes a real persisted planning job and exercises the
production service through the same service classes used by the HTTP API, using
the same material acquisition path as `POST /prepare-production`.

## Colab role

Colab should install dependencies, start MoneyPrinterTurbo, provide the
configured AI/media credentials when needed, and execute either runner. No
Colab-only production logic is required in the repository.

When MoneyPrinterTurbo runs on a different host from the agent, note that
adaptive voice calibration reads MoneyPrinterTurbo's task storage directly.
Point `MPT_STORAGE_DIR` at a locally readable `storage/tasks` directory, or set
`MPT_VOICE_RATE` to a fixed rate to skip calibration entirely.
