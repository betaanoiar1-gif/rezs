# rezs

`rezs` is an autonomous YouTube Shorts pipeline built by integrating two
vendored upstream projects:

- [AgentTube / YouTube Automation Agent](https://github.com/darkzOGx/youtube-automation-agent) — `agenttube/`, a Node.js agent that plans, orchestrates and tracks work.
- [MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo) — `moneyprinterturbo/`, a Python service that renders the video.

Both are pinned baselines; see [`docs/BASELINE.md`](docs/BASELINE.md) for the
exact upstream commits. The integration layer lives in `agenttube/` and treats
MoneyPrinterTurbo as an external rendering service reached over HTTP.

## Pipeline

A topic becomes a validated vertical video through six persisted phases. Every
phase writes its state to SQLite before moving on, so an interrupted run can be
resumed rather than restarted.

| Phase | Entry point | Produces |
| --- | --- | --- |
| 3A Planning | `POST /api/planning/shorts` | `shorts_planning_jobs` — script, scene timeline, metadata |
| 3B Preparation | `POST /api/planning/shorts/:jobId/prepare-production` | `shorts_production_preparations` — quality gate, staged material, MPT request |
| 3C Production | `POST /api/production/shorts/:preparationId/start` | `production_jobs` — MPT task, downloaded and validated MP4 |
| 3E Review | `POST /api/production/shorts/:preparationId/review` | `productions`, `content_reviews` |
| 3F Approval | `POST /api/production/shorts/:preparationId/review/:action` | approval decision |
| 4 Publishing | `POST /api/production/shorts/:preparationId/schedule` | `publish_schedule` |

Each phase is documented in `docs/`:
[planning](docs/SHORTS_PLANNING.md),
[preparation](docs/SHORTS_PRODUCTION_PREPARATION.md),
[execution](docs/SHORTS_PRODUCTION_EXECUTION.md),
[review and approval](docs/SHORTS_REVIEW_APPROVAL.md),
[publishing handoff](docs/SHORTS_PUBLISHING_HANDOFF.md),
[the MoneyPrinterTurbo contract](docs/PRODUCTION_INTEGRATION.md), and
[the real runtime](docs/REAL_RUNTIME.md).

## How the two projects are integrated

REZS stages every clip locally and submits `video_source: "local"` with an
explicit `video_materials` list, so MoneyPrinterTurbo renders deterministically
from material REZS has already downloaded, validated and de-duplicated. REZS
does not delegate stock search to MoneyPrinterTurbo, and MoneyPrinterTurbo is
never asked to reach the internet during a render.

Media acquisition is a separate, testable layer
(`agenttube/integrations/stock-media.js` and
`agenttube/services/shorts-material-service.js`) that talks to Pixabay, Pexels
and Coverr using the same request and response shapes MoneyPrinterTurbo itself
uses. Providers are tried in order and the first usable asset wins, so one
provider being empty, rate limited or down does not fail a plan.

## Requirements

- Node.js 20+ and npm (`agenttube/`)
- Python 3.10+ (`moneyprinterturbo/`)
- FFmpeg and FFprobe with h264 and AAC support

## Setup

```bash
cd agenttube && npm ci
cp .env.example .env          # then fill in the variables you need

cd ../moneyprinterturbo
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp config.example.toml config.toml
```

All credentials are read from the environment. No key belongs in a tracked
file — `.env` and `config.toml` are both gitignored.

An AI text provider is required for planning. Set one of `CLEANAPIS_API_KEY`,
`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `MOONSHOT_API_KEY`,
`MIMO_API_KEY` or `GLM_API_KEY`; the first one present is used. Each provider
also accepts a `<PROVIDER>_BASE_URL` override for a self-hosted gateway,
regional endpoint or proxy.

At least one of `PIXABAY_API_KEY`, `PEXELS_API_KEY` or `COVERR_API_KEY` is
required for stock footage. Without one, preparation falls back to scanning a
local materials directory.

## Running

```bash
# MoneyPrinterTurbo (defaults to port 8080)
cd moneyprinterturbo && .venv/bin/python main.py

# The agent API (defaults to port 3456)
cd agenttube && npm start
```

`MPT_BASE_URL` tells the agent where MoneyPrinterTurbo is; it defaults to
`http://127.0.0.1:8080`, matching MoneyPrinterTurbo's own `listen_port`.

## Verifying

```bash
cd agenttube
npm run lint
npm run test:integration    # unit, integration and fault-injection tests
npm test                    # legacy end-to-end system suite (needs FFmpeg)
```

To prove the whole pipeline rather than its parts, run the end-to-end runner
against a live MoneyPrinterTurbo. It takes a topic through planning, material
acquisition, preparation, rendering, download and validation, then re-probes
the delivered file independently and writes a report:

```bash
cd agenttube
node scripts/e2e-full-pipeline.js "why cold water swimming improves focus"
```

It reports which inputs were live and which were supplied locally, so a run is
never mistaken for something it was not. See
[`docs/REAL_RUNTIME.md`](docs/REAL_RUNTIME.md) for the offline flags and for
the narrower Phase 3B→3C smoke runner.
