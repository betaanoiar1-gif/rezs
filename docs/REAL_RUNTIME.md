# REZS real runtime

The repository is the source of truth. Colab is only an execution environment.

## Real Shorts production path

1. A successful Phase 3A planning job is stored in `shorts_planning_jobs`.
2. Phase 3B validates that immutable planning artifact and creates `PRODUCTION_READY`.
3. Phase 3C submits the exact persisted `specification.mpt_request` to MoneyPrinterTurbo.
4. Phase 3C polls the MPT task until completion.
5. The returned artifact reference is normalized and downloaded into the configured REZS artifact directory.
6. The downloaded MP4 is validated for container, video/audio streams, vertical 9:16 geometry, minimum 720x1280 resolution, supported codecs, duration tolerance, full FFmpeg decode, size and SHA-256.
7. Only a validated artifact reaches `SUCCEEDED / ARTIFACT_DOWNLOADED`.

## Reproducible smoke runner

From the AgentTube directory:

```bash
PLANNING_JOB_ID=<existing-succeeded-planning-job> node scripts/phase3c-real-smoke.js
```

Optional environment variables:

- `MPT_BASE_URL` (default `http://127.0.0.1:8080`)
- `MPT_POLL_INTERVAL_MS` (default 2000)
- `MPT_MAX_POLLS` (default 300)

The smoke runner deliberately does not create synthetic production records or bypass Phase 3B. It consumes a real persisted planning job and exercises the production service through the same service classes used by the HTTP API.

## Colab role

Colab should install dependencies, start MoneyPrinterTurbo, provide the configured AI/media credentials when needed, and execute this runner. No Colab-only production logic is required in the repository.
