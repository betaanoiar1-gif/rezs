# AgentTube → MoneyPrinterTurbo production integration

Phase 2A adds a production-service adapter only. It does not add Shorts orchestration, script generation, TTS providers, quality gates, publishing, or public AgentTube routes.

## API

`agenttube/integrations/moneyprinterturbo.js` exports:

- `MoneyPrinterTurboClient.health()` — calls MPT `GET /ping`.
- `create_video(specification)` — passes a caller-supplied MPT request unchanged to `POST /api/v1/videos` and requires a returned task ID.
- `get_task_status(taskId)` — calls `GET /api/v1/tasks/{id}` and maps native state `1/-1/4` to the AgentTube lifecycle.
- `cancel_task(taskId)` — calls MPT's existing `DELETE /api/v1/tasks/{id}`. MPT may reject deletion of a busy task with HTTP 409; the adapter does not pretend that such a task was cancelled.
- `download_artifact(reference, relativeDestination)` — downloads an artifact without overwriting an existing destination.
- `MoneyPrinterTurboProductionService` — persists submission, bounded polling, cancellation, and terminal states through AgentTube's database API.

MPT's existing request schema remains authoritative; the adapter does not reshape or weaken it.

## Configuration

| Environment variable | Default | Meaning |
|---|---:|---|
| `MPT_BASE_URL` | `http://127.0.0.1:8080` | MPT origin |
| `MPT_API_KEY` | empty | Optional `x-api-key` header |
| `MPT_CONNECT_TIMEOUT_MS` | `5000` | Time allowed to receive response headers |
| `MPT_READ_TIMEOUT_MS` | `30000` | Time allowed to consume response data |
| `MPT_MAX_RETRIES` | `2` | Additional attempts after the first request |
| `MPT_RETRY_DELAY_MS` | `250` | Linear retry-delay base |
| `MPT_ARTIFACT_DIR` | `agenttube/data/mpt-artifacts` | Exclusive artifact destination root |

Constructor options with the corresponding camelCase names override environment values. Production should configure a non-empty MPT API key when MPT is reachable beyond a trusted local network.

## Durable lifecycle

The `production_jobs` SQLite table records:

- `job_id`, `mpt_task_id`
- `status`, `stage`
- `retry_count`, `last_error`
- `artifact_path`
- `created_at`, `updated_at`

Supported statuses are exactly:

```text
SUBMITTED → RUNNING → SUCCEEDED
                    → FAILED
                    → CANCELLED
                    → TIMEOUT
```

Submission failures are persisted as `FAILED`. Polling is bounded by `maxPolls` and ends as `TIMEOUT`; there is no infinite polling loop. MPT state `1` means success, `-1` means failure, and `4` or `0` means active. The MPT deletion endpoint cannot cancel work that MPT reports as busy, so HTTP 409 remains a structured permanent error.

## Retry and errors

`MptError` includes `code`, optional HTTP `status`, and `transient`. Retries apply only to network errors, connect/read timeouts, HTTP 408, HTTP 429, and HTTP 5xx. Validation failures and other HTTP 4xx responses are not retried. Retry count and delay are bounded. Logs identify attempts but never include API keys or request bodies.

## Artifact security

- Destinations must be relative paths below `MPT_ARTIFACT_DIR`.
- Absolute paths and `..` traversal outside the root are rejected.
- Existing files are never overwritten.
- Symlinked destination files and ancestor directories are rejected.
- Absolute remote artifact URLs must have the same origin as `MPT_BASE_URL`.
- MPT `/tasks/...` references are mapped to its verified `/api/v1/download/tasks/...` endpoint.
- Downloads use a unique temporary file and atomic rename.
- A successful download must exist, be a regular file, and contain at least one byte.

## Tests

```bash
cd agenttube
npm run test:integration
npm run lint
npm test
```

The deterministic adapter suite uses injected HTTP and persistence doubles; it does not call paid services, YouTube, or a live MPT instance.
