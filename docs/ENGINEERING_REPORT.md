# REZS engineering report

Reverse engineering, audit and hardening of `betaanoiar1-gif/rezs`.
Branch `arena/01a0eef2-rezs`, branched from `main` at `5fca11f`, session
baseline `6d76fc9`.

Guiding constraint throughout: **preserve behaviour, improve implementation.**
No framework was swapped, no phase was redesigned, no working feature was
removed, and the pipeline does exactly what it did before — it now fails
honestly when it cannot.

---

## 1. System understanding

REZS is an autonomous YouTube Shorts factory assembled from two vendored
upstream projects that were never designed to work together:

- **AgentTube** (`agenttube/`, Node 22, Express on :3456, SQLite) — a
  "Lumen" agent that plans content with an LLM, orchestrates work and owns
  all durable state.
- **MoneyPrinterTurbo 1.3.7** (`moneyprinterturbo/`, Python 3.11, FastAPI on
  :8080) — renders the video: TTS, subtitles, material concatenation, FFmpeg
  encoding.

The integration is deliberately one-directional. AgentTube treats
MoneyPrinterTurbo as a dumb rendering service reached over HTTP: it does all
the thinking, acquires and validates every asset itself, then hands
MoneyPrinterTurbo a fully-specified job with local file references. This is the
project's central architectural decision and the audit preserved it.

A topic becomes a validated vertical MP4 through six persisted phases:

| Phase | Endpoint | Table |
| --- | --- | --- |
| 3A Planning | `POST /api/planning/shorts` | `shorts_planning_jobs` |
| 3B Preparation | `POST /api/planning/shorts/:jobId/prepare-production` | `shorts_production_preparations` |
| 3C Production | `POST /api/production/shorts/:preparationId/start` | `production_jobs` |
| 3E Review | `POST …/review` | `productions`, `content_reviews` |
| 3F Approval | `POST …/review/:action` | approval decision |
| 4 Publishing | `POST …/schedule` | `publish_schedule` |

### What the code actually does, not what the docs claimed

Phase 1 was read-only. The README asserted the two upstreams were "present as
an unchanged baseline" and that the Shorts layers were "not part of this
checkpoint". Both were false by dozens of commits. Git history
(`cb962b0..6d76fc9`, 42 files, +7363/−2182) was the reliable narrative; the
prose was not. Everything below comes from source, schema, tests and observed
runtime behaviour.

---

## 2. Architecture

```
topic
  │
  ▼  ShortsPlanningService ── ContentStrategyAgent ─┐
     (3A)                     ScriptWriterAgent     ├─ AITextService ─► LLM provider
                              SEOOptimizerAgent    ─┘
  │  plan artifact: script, contiguous scene timeline, metadata, provenance
  ▼
  ShortsProductionPreparationService (3B)
     ├─ validateProductionPlan()      deterministic quality gate
     └─ ShortsMaterialService         search → rank → download → stage → dedup
            └─ stock-media.js         Pixabay │ Pexels │ Coverr
  │  specification.mpt_request  (video_source: "local", explicit materials)
  ▼
  ShortsProductionExecutionService (3C)
     └─ MoneyPrinterTurboProductionService ─► MPT /api/v1/videos ─► render
            └─ bounded poll ─► download_artifact ─► validateVideoArtifact
  │  SUCCEEDED / ARTIFACT_DOWNLOADED
  ▼
  review (3E) → approval (3F) → schedule (4)
```

Every arrow crosses a persistence boundary. State is written before the next
step begins, which is what makes restart recovery possible at all.

### The integration boundary

MoneyPrinterTurbo natively searches Pexels, Pixabay and Coverr itself
(`app/services/material.py`). REZS does **not** use that. It stages every clip
into `storage/local_videos/` and submits `video_source: "local"` with an
explicit `video_materials` list of bare filenames, which
`video.py:preprocess_video` resolves through
`file_security.resolve_path_within_directory`.

This is the right call and was left alone: it makes renders deterministic and
reproducible, keeps MoneyPrinterTurbo offline during a render, and puts asset
validation under REZS's control where the durable state lives. The audit's job
was to make REZS's half of that bargain trustworthy, not to replace it.

Offline TTS uses the REZS-added `local_espeak:<voice>` path in `voice.py`,
backed by the bundled `espeakng_loader` shared library — no network, no cloud
TTS key.

---

## 3. Core behaviour contract

Taken from the implementation, not invented.

**Core behaviour.** Turn one topic string into one validated, human-reviewable
vertical MP4, with every intermediate state durably recorded and every
important operation safe to repeat.

**Required inputs.** A non-empty topic (≤500 chars); one AI text provider
credential; at least one stock provider key *or* a populated local materials
directory; a reachable MoneyPrinterTurbo; FFmpeg/FFprobe with h264 + AAC.

**Processing pipeline.** Research (optional) → strategy → script → scene
timeline → SEO metadata → validation → quality gate → material acquisition →
MPT specification → submit → poll → download → validate → review → approve →
schedule.

**Required outputs.** A plan artifact whose scene narration concatenates to
exactly the script; a `PRODUCTION_READY` preparation carrying an immutable
`mpt_request`; an MP4 that is 9:16, ≥720×1280, h264/hevc/vp9/av1 + aac/opus/mp3,
60–120 s, within 3 s of the approved duration, fully decodable and SHA-256
hashed.

**External dependencies.** LLM provider (OpenAI-compatible or Gemini); Pixabay
/ Pexels / Coverr; MoneyPrinterTurbo HTTP API; FFmpeg/FFprobe; SQLite; eSpeak NG.

**Real state model.**

- Planning: `PENDING → RUNNING → SUCCEEDED | BLOCKED | FAILED`
- Preparation: `VALIDATING → PRODUCTION_READY | REJECTED`
- Production: `QUEUED → SUBMITTED → RUNNING → SUCCEEDED` (stage
  `ARTIFACT_DOWNLOADED`), plus `FAILED | CANCELLED | TIMEOUT`; stages include
  `SUBMISSION_FAILED`, `ARTIFACT_DOWNLOAD_FAILED`, `ARTIFACT_VALIDATION_FAILED`,
  `POLL_TIMEOUT`, `MPT_TASK_LOST`, `MPT_RECOVERY_FAILED`.
- MoneyPrinterTurbo native state: `1` SUCCEEDED, `-1` FAILED, `4`/`0` RUNNING.

**Invariants.** Narration 60–120 s at 150 wpm; scene timeline contiguous and
equal to total (±0.11 s); concatenated scene narration identical to the script;
`metadata.generationSource === 'ai'` (template fallback is a hard failure for
autonomous planning); IDs deterministic — `short_prep_<sha256(planningJobId)[0:24]>`,
`short_prod_<sha256(preparationId)[0:24]>`.

---

## 4. Initial audit

### Build state at session baseline `6d76fc9`

| Check | Result |
| --- | --- |
| `npm run lint` | **3 errors** |
| `npm run test:integration` | **119 / 124** — 5 failures |
| `npm test` (legacy system suite) | **45 / 46** — 1 failure |
| GitHub Actions | **last 15 runs all red** |
| `npm audit` | 29 vulnerabilities (1 critical, 18 high) |

The project had never been green. Two history worktrees (`43677dc`, `d7575f1`)
confirmed the failing tests were failing on the commits that introduced them.

### Problem matrix

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| 1 | Critical | MPT client defaulted to port **8090**; MPT listens on **8080**. Every real run needed a manual override. | Fixed |
| 2 | Critical | Lost-task recovery recursed into itself with no bound — unbounded retry against a permanently failing task. | Fixed |
| 3 | High | `catch (_error) { return [] }` in material discovery: every I/O fault became "no footage", and nothing checked for emptiness → MPT asked to render nothing. | Fixed |
| 4 | High | Artifact validation trusted the **container** duration, which reports the longer stream. Truncated narration passed. | Fixed |
| 5 | High | `download_artifact` buffered whole MP4s via `arrayBuffer()` — two copies of a 45 MB file in memory. | Fixed |
| 6 | High | Voice calibration shelled out to a bare `ffprobe`, ignoring `FFMPEG_PATH`/`FFPROBE_PATH`; silently measured nothing, then failed after 20 retries. | Fixed |
| 7 | High | Single media provider (Pixabay). One empty result failed the whole plan despite Pexels/Coverr keys being available. | Fixed |
| 8 | High | 29 dependency vulnerabilities, 1 critical. | Partly fixed (29→13) |
| 9 | Medium | Media acquisition was an inline closure in an Express route — untestable, and the smoke runner used a different path entirely. | Fixed |
| 10 | Medium | Pixabay client swallowed cache and filesystem errors. | Fixed |
| 11 | Medium | Provider base URLs hard-coded; no way to switch endpoint without editing source. | Fixed |
| 12 | Medium | Three preparation tests silently depended on ambient files in the developer's storage directory. | Fixed |
| 13 | Medium | Test suite wrote its cache into the working tree (`storage/local_videos/.pixabay-search-cache`). | Fixed |
| 14 | Medium | `_fetchOnce` classifies every exception as `NETWORK_ERROR`, masking bugs. | Open |
| 15 | Medium | `POST …/start` runs the full bounded poll synchronously inside the HTTP request. | Open |
| 16 | Low | No unique constraint on `publish_schedule.production_id`. | Open |
| 17 | Low | Search cache has a TTL but no eviction and no negative caching. | Open |
| 18 | Low | Duration integrity compares against a 150-wpm *estimate*; `MPT_VOICE_RATE` short-circuits calibration. | Open, documented |

---

## 5. Changes

Eleven commits, each typed and self-contained.

**Correctness of the green build** — `08ccf38`, `d594672`, `70aa913`, `559db0c`.
Port default corrected to 8080 against MPT's own `config.py:581`. Lost-task
recovery converted from self-recursion to a bounded `for(;;)` with
`MAX_LOST_TASK_RECOVERIES = 3` and a terminal `MPT_RECOVERY_FAILED` when
`retry_count` stops increasing. Pixabay error swallowing removed. Two test
defects fixed — an unescaped `/q=ocean+water/` regex and a ranking expectation
that contradicted the implementation — and the shared cache directory isolated.

**Multi-provider media** — `60b5996`. New `integrations/stock-media.js`
(one `StockVideoClient` base; Pixabay, Pexels and Coverr subclasses sharing
cache, ranking, download and safety) and `services/shorts-material-service.js`
(term collection, concrete-term expansion, ordered provider fallback,
cross-term de-duplication, resolution gate). Request and response shapes mirror
MoneyPrinterTurbo's own `material.py`, which is the authoritative reference for
all three APIs. Both the HTTP route and the smoke runner now call the same
service, closing the entry-point divergence.

`integrations/pixabay.js` was **removed**, not kept alongside.
`PixabayStockClient` absorbs every behaviour it had — same ranking order, same
`pixabay-<id>.mp4` staged names, same staging directory, same provenance —
and adds size caps, a host allowlist and provider-scoped caching. Its only
remaining importer was its own test; all three of its cases were carried into
`test/stock-media.test.js`.

**MoneyPrinterTurbo adapter** — `54ee499`. Calibration now uses
`getMediaDuration()`, inheriting the project's FFmpeg resolution and its
metadata fallback. `download_artifact` streams to disk. Validation gained
per-stream durations and an audio/video agreement check.

**AI provider flexibility** — `7a9d31b`. `<PROVIDER>_BASE_URL` override,
validated at construction, with defaults unchanged.

**Material fault honesty** — `a40acc5`. Only `ENOENT` means "nothing staged";
everything else is `MATERIAL_DISCOVERY_FAILED`. A materialless preparation is
`REJECTED` with `NO_PRODUCTION_MATERIALS` and stores no specification.

**Testing** — `b26751d` (E2E runner), `44882d7` (fault injection).

**Security** — `fdb9526`. 16 advisories closed inside existing semver ranges.

**Documentation** — `9b70f25`.

---

## 6. Reliability

**Provider fallback.** Per term, the service tries every phrasing from
`expandSearchTerm(term)` — the original, concrete substitutions from a
15-entry abstract→concrete map, then `"<term> habit"` and `"<term> routine"` —
against every configured provider in order. First usable asset wins.

Recoverable, continue to the next source: `NO_VIDEO_RESULTS`,
`PROVIDER_RATE_LIMITED`, `PROVIDER_HTTP_ERROR`, `PROVIDER_TIMEOUT`,
`PROVIDER_NETWORK_ERROR`, `PROVIDER_INVALID_RESPONSE`,
`PROVIDER_DOWNLOAD_FAILED`, `INVALID_ASSET_URL`, `ASSET_TOO_LARGE`,
`EMPTY_ASSET`.

`CONFIG_ERROR` is deliberately **not** recoverable. A missing or rejected
credential fails identically for every term and provider; retrying it across
the whole term list only delays a certain failure and burns rate limit. It
aborts on the first occurrence, and a fault-injection test pins that at exactly
one attempt.

**Bounded recovery.** Polling, retries and lost-task recovery are all bounded.
Recovery stops after 3 attempts, and stops early if `retry_count` fails to
increase — the signal that the recovery is not making progress.

**Timeouts.** Separate connect and read timeouts, `AbortController` on every
outbound request, explicit poll ceilings.

---

## 7. State integrity

The hardest class of bug here is disagreement between MoneyPrinterTurbo's
in-memory task state, the SQLite record, the local process and the file on
disk. Four mechanisms keep them aligned:

1. **Deterministic IDs.** Preparation and production IDs are SHA-256 digests of
   their parent ID, so a retry addresses the same row instead of forking a new
   lineage.
2. **Database constraints as the final arbiter.** `production_jobs` has
   `UNIQUE(preparation_id)` and `UNIQUE(mpt_task_id)`. Fault-injection tests
   drive two concurrent creates for one preparation and confirm exactly one
   succeeds, and confirm a second job cannot claim a task another job owns —
   which would otherwise let two jobs poll one render and both claim its output.
3. **Lost-task recovery.** A task MoneyPrinterTurbo no longer knows about is
   classified `MPT_TASK_LOST`, re-submitted a bounded number of times, and
   terminates in `MPT_RECOVERY_FAILED` rather than looping.
4. **Existence is never proof.** The pipeline reaches `SUCCEEDED` only after
   probing, decoding and hashing the actual file.

Restart recovery is tested: a job interrupted mid-render keeps its external
task handle, so a fresh process resumes rather than orphaning a live render.

---

## 8. Security

**Secrets.** No key appears in source, git, logs, error messages or this
report. `.env.example` declares variable *names* only. `.env` and
`config.toml` are gitignored. Provider keys are read from the environment at
construction.

**Filesystem.** Artifact destinations must resolve inside `MPT_ARTIFACT_DIR`;
traversal and symlinks are rejected before any request is made — a
fault-injection test asserts `../escape.mp4`, `/etc/passwd` and
`job/../../escape.mp4` never reach `fetch`. No overwrite. Downloads go to a
temporary file and are renamed atomically, so a partial transfer is never
visible at the final path. On the MoneyPrinterTurbo side, local material is
resolved through `file_security.resolve_path_within_directory`.

**SSRF.** Stock downloads require HTTPS and must match a per-provider host
allowlist. The AI base URL override is validated as absolute `http`/`https`,
rejecting `file://` and `ftp://`.

**Resource exhaustion.** `REZS_STOCK_MAX_ASSET_BYTES` caps asset size;
artifact downloads stream rather than buffer.

**Dependencies.** 29 → 13 advisories. The remaining 13 require major bumps of
`sharp`, `sqlite3` and `node-cron`; `sqlite3` 6.x changes the native binding
the whole database layer rests on and deserves its own verified upgrade.

---

## 9. Performance

Only measured problems were touched, per the standing instruction that
optimisation must be proven first.

- **Artifact download memory.** `arrayBuffer()` held the encoded body *and* the
  copied `Buffer` simultaneously — ~91 MB peak for the 45.6 MB artifact this
  session produced. Streaming makes peak memory flat regardless of size.
- **Wasted calibration retries.** The bare-`ffprobe` bug caused 20 failed
  measurement attempts per calibration iteration before erroring. Now the
  measurement succeeds on the first attempt: the observed run converged in two
  iterations, 0.82 → 0.7724, landing 66.43 s against a 66 s target.
- **Search caching.** Provider searches are cached per provider with a TTL,
  avoiding repeat calls for terms shared across scenes.

Not touched, because no measurement justified it: FFmpeg encoder settings,
concat strategy, database indexing beyond what exists.

---

## 10. Testing

| Suite | Before | After |
| --- | --- | --- |
| `npm run lint` | 3 errors | **clean** |
| `npm run test:integration` | 119 / 124 | **186 / 186** |
| `npm test` (legacy system) | 45 / 46 | **46 / 46** |
| MoneyPrinterTurbo `pytest` | never run | **1433 passed, 20 skipped, 10639 subtests** |

New test files: `test/stock-media.test.js` (20), `test/shorts-material-service.test.js`
(18), `test/ai-text-service.test.js` (10), `test/fault-injection.test.js` (11).

**Fault injection** covers what the suite previously ignored — how the system
behaves when the world breaks:

- unreadable materials directory → `MATERIAL_DISCOVERY_FAILED` with the errno,
  not an empty list (skips cleanly when run as root, rather than asserting a lie)
- no acquirable footage → `REJECTED`, no specification persisted
- total provider outage → every term and attempt reported
- one provider down → the next takes over
- credential fault → exactly one attempt, then abort
- download dying mid-stream → no destination file, no `.part` file
- empty response body → `EMPTY_ARTIFACT`
- path traversal → refused before `fetch`
- interrupted job → external task handle survives for resume
- concurrent double-submit → exactly one job
- two jobs claiming one task → rejected

**Test hygiene.** Three preparation tests passed only because they read
whatever happened to be in the developer's `storage/local_videos`. Verified by
running against an empty directory (3 failures), then fixed to stage their own
material. The whole suite is now re-verified against a forced-empty ambient
directory.

---

## 11. End-to-end proof

`scripts/e2e-full-pipeline.js` runs the real services, the real
MoneyPrinterTurbo HTTP API, real FFmpeg and the real SQLite schema, then
**re-probes the delivered file independently** rather than trusting the
validation record the pipeline just wrote.

Three full runs completed, on two topics, including one after the dependency
upgrade. Representative run, 278 s wall clock:

| Stage | Evidence |
| --- | --- |
| Input | `"why cold water swimming improves focus"` |
| AI planning | `short_plan_2fb715ef…` `SUCCEEDED`, 5 scenes, 66 s narration, `generationSource: ai` |
| Material | 4 vertical clips staged, de-duplicated, resolution-checked |
| Preparation | `short_prep_36b23722963b4e6f62b9bb4e` `PRODUCTION_READY`, 8 quality checks, aspect `9:16` |
| Calibration | 0.82 → 0.7724 in 2 iterations; 62.17 s → 66.43 s against 66 s |
| Production | `short_prod_25c44ea0c578982cf06d5826` → MPT task `a21b2817…`, `SUCCEEDED / ARTIFACT_DOWNLOADED`, `retry_count` 0 |
| Artifact | 45,612,435 bytes, SHA-256 `0481b535…db633` |
| Geometry | 1080×1920, aspect 0.5625 — exactly 9:16 |
| Codecs | h264 / aac, 30 fps, 44.1 kHz stereo |
| Duration | container 66.57 s; video 66.5667 s; audio 66.57 s — 0.003 s drift |
| Audio reality | mean −24.3 dB, peak −4.9 dB, **zero** silent gaps > 3 s |
| Subtitles | burned in and correctly timed — frame at t=33 s reads "Breathe out slowly instead of gasping", verbatim from the planned script |

The subtitle text matching the planned scene narration is the clearest proof
the whole chain held: the words the LLM wrote in Phase 3A survived scene
association, TTS, subtitle generation and the final encode into the pixels of
the delivered file.

### Honest limitations

Network egress in the verification environment is allowlisted. `pixabay.com`,
`api.pexels.com`, `coverr.co` and `www.cleanapis.com` are **all unreachable**,
as are `deb.debian.org` and `nodejs.org`. Consequently:

- **AI planning** ran against a local OpenAI-compatible endpoint. The agents,
  prompts, JSON parsing, schema validation and the rule refusing template
  fallback all executed unchanged — only the model host differed. This is
  exactly what the new `<PROVIDER>_BASE_URL` override makes possible.
- **Stock footage** was synthesised with FFmpeg instead of downloaded. The
  multi-provider chain is covered by 38 unit tests and 5 fault-injection tests
  against the response shapes taken from MoneyPrinterTurbo's own client, but it
  has **not** been exercised against the live APIs.

Both substitutions are named in the generated report so a run can never be
mistaken for something it was not. With provider keys present and both flags
unset, the same script is a fully live run. **Everything else was real**: real
eSpeak NG synthesis, real FFmpeg 7.0.2 encoding, real MoneyPrinterTurbo task
lifecycle, real HTTP artifact transfer, real SQLite state.

---

## 12. Remaining risks

| Risk | Impact | Recommendation |
| --- | --- | --- |
| Live stock providers never exercised end to end | Medium | Run `scripts/e2e-full-pipeline.js` with real keys on a network that can reach them. This is the single highest-value next step. |
| `POST …/start` polls synchronously inside the request | Medium | A render takes minutes; the HTTP client holds a connection throughout. Move to a background worker reading `production_jobs`. Deferred — it changes the API's observable timing, which is a behaviour change. |
| `_fetchOnce` labels every exception `NETWORK_ERROR` | Medium | A `TypeError` in the adapter is reported as a network fault and retried pointlessly. Narrow the classification. |
| Duration integrity anchors on a 150-wpm estimate | Medium | The ±3 s gate compares against a word-count estimate, not the intended runtime. `MPT_VOICE_RATE` skips calibration entirely. Documented; worth revisiting. |
| Voice calibration needs local MPT storage | Medium | A remote MoneyPrinterTurbo needs `MPT_STORAGE_DIR` or `MPT_VOICE_RATE`. Now a clear, actionable error. Fetching the audio over HTTP would remove the constraint. |
| 13 open advisories needing major bumps | Medium | `sharp`, `sqlite3` 6.x, `node-cron` 4.x. `sqlite3` touches the native binding under the whole data layer. |
| No unique constraint on `publish_schedule.production_id` | Low | One production could be scheduled twice. |
| Search cache has no eviction or negative caching | Low | Unbounded growth; repeated misses re-hit providers. |

---

## 13. Changed files

26 files, +3004 / −307, across `6d76fc9..HEAD`.

**New**
- `agenttube/integrations/stock-media.js` — multi-provider stock layer
- `agenttube/services/shorts-material-service.js` — acquisition orchestration
- `agenttube/scripts/e2e-full-pipeline.js` — whole-pipeline runner
- `agenttube/test/stock-media.test.js`, `test/shorts-material-service.test.js`,
  `test/ai-text-service.test.js`, `test/fault-injection.test.js`
- `docs/ENGINEERING_REPORT.md`

**Removed**
- `agenttube/integrations/pixabay.js`, `agenttube/test/pixabay.test.js` —
  fully absorbed by `PixabayStockClient` (§5)

**Modified**
- `agenttube/index.js` — route delegates to the service; error→status mapping widened
- `agenttube/integrations/moneyprinterturbo.js` — FFmpeg resolution, streaming download
- `agenttube/services/shorts-production-execution-service.js` — bounded recovery, per-stream durations, A/V check
- `agenttube/services/shorts-production-preparation-service.js` — material fault handling, empty-material rejection
- `agenttube/utils/ai-text-service.js` — base URL override
- `agenttube/scripts/phase3c-real-smoke.js` — provider-aware discovery
- `agenttube/.env.example`, `.gitignore`, `eslint.config.js`, `package-lock.json`
- `agenttube/test/moneyprinterturbo.test.js`, `test/shorts-production-execution-service.test.js`, `test/shorts-production-preparation-service.test.js`
- `README.md`, `docs/REAL_RUNTIME.md`, `docs/SHORTS_PLANNING.md`, `docs/SHORTS_PRODUCTION_EXECUTION.md`, `docs/SHORTS_PRODUCTION_PREPARATION.md`

---

## 14. Git commits

| Commit | Type | Summary |
| --- | --- | --- |
| `08ccf38` | fix | surface Pixabay cache and filesystem errors instead of swallowing them |
| `d594672` | test | fix the unescaped query assertion and pin the ranking contract |
| `70aa913` | fix | align the default base URL with MoneyPrinterTurbo's listen port |
| `559db0c` | fix | bound lost-MPT-task recovery with an explicit loop |
| `60b5996` | feat | multi-provider stock acquisition with ordered fallback |
| `54ee499` | fix | honour configured FFmpeg tooling, stream artifacts, verify narration length |
| `7a9d31b` | feat | allow a provider endpoint override without editing provider code |
| `b26751d` | test | whole-pipeline verification runner |
| `a40acc5` | fix | stop silently turning material faults into an empty plan |
| `44882d7` | test | cover the failure modes the pipeline must survive |
| `9b70f25` | docs | describe the system that exists rather than a vendored baseline |
| `fdb9526` | security | apply the non-breaking half of the advisory backlog |

No force pushes. No history rewritten after publication. No unrelated changes
bundled.

---

## Definition of done

| Criterion | State |
| --- | --- |
| Architecture coherent and documented | Met |
| Core behaviour preserved | Met — no phase, endpoint, table or workflow changed |
| AI provider selection, validation, provenance | Met; automatic cross-provider failover does not exist and is documented as absent |
| Multi-source media with valid files | Met in code and tests; **not** verified against live provider APIs |
| Real video with correct duration, aspect, audio, subtitles | Met — verified independently three times |
| DB state consistent with external state; safe retry; working recovery | Met |
| Restart, timeout, crash handling and idempotency | Met |
| Secrets, filesystem, URL and API security | Met; 13 advisories remain, needing major bumps |
| Unit, integration, E2E and failure tests | Met — 186 + 46 + 1433, plus 11 fault-injection tests |
| Documentation reflects the real implementation | Met |
