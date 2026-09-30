# Live external integration validation

Objective: move the project from *"works locally and is well tested"* to
*"works against the real external services it will use in production."*

**Outcome: the objective was not reached, and this document does not pretend
otherwise.** Two independent blockers prevented any live external call. Both
are environmental, neither is a defect in the code, and both are recorded here
precisely so they can be removed.

Run with:

```bash
cd agenttube && node scripts/live-integration-validation.js
```

---

## 1. Result table

| Component | Live? | Result | Evidence |
| --- | :---: | --- | --- |
| Clean APIs (AI) | NO | `NO_CREDENTIAL` | `CLEANAPIS_API_KEY` is not set. Also `PROVIDER_UNREACHABLE`: `www.cleanapis.com` — TLS handshake failed (ECONNRESET) |
| Pixabay | NO | `NO_CREDENTIAL` | `PIXABAY_API_KEY` is not set. Also `PROVIDER_UNREACHABLE`: `pixabay.com` — TLS handshake failed (ECONNRESET) |
| Pexels | NO | `NO_CREDENTIAL` | `PEXELS_API_KEY` is not set. Also `PROVIDER_UNREACHABLE`: `api.pexels.com` — TLS handshake failed (ECONNRESET) |
| Coverr | NO | `NO_CREDENTIAL` | `COVERR_API_KEY` is not set. Also `PROVIDER_UNREACHABLE`: `api.coverr.co` — TLS handshake failed (ECONNRESET) |
| Provider fallback | NO | `NOT_TESTED` | No media provider was live; ordering and error classification remain covered offline only |
| MoneyPrinterTurbo | **YES** | **PASS** | HTTP 200 at `http://127.0.0.1:8080/docs`; client default URL matches |
| FFmpeg | **YES** | **PASS** | 7.0.2-static; real h264 + aac encode at 540×960, full decode |
| eSpeak NG | **YES** | **PASS** | Real synthesis via `voice.local_espeak_tts`, 1.912 s, pcm_s16le @ 22050 Hz |
| SQLite | **YES** | **PASS** | initialize, write/read, update, and `UNIQUE` constraint enforced |
| Final MP4 (live chain) | NO | `NOT_TESTED` | Not attempted: the live chain is incomplete upstream |

Totals: **4 PASS · 4 NO_CREDENTIAL · 2 NOT_TESTED · 0 FAIL**

Machine-readable: `agenttube/data/live-validation.json`.

---

## 2. The two blockers

### Blocker A — no credentials are present

No provider credential exists in this environment. Checked by name, never by
value:

```
CLEANAPIS_API_KEY    NOT SET
CLEANAPIS_MODEL      NOT SET
PIXABAY_API_KEY      NOT SET
PEXELS_API_KEY       NOT SET
COVERR_API_KEY       NOT SET
```

There is no `.env` file, and no secret-management mount is present. The only
credentials in the environment are `GH_TOKEN` / `GITHUB_TOKEN`, used for git.

### Blocker B — provider egress is blocked

Reachability was probed at three layers to avoid blaming the wrong thing:

| Host | DNS | TCP :443 | TLS | Verdict |
| --- | --- | --- | --- | --- |
| `www.cleanapis.com` | resolves | connects | **ECONNRESET** | blocked |
| `pixabay.com` | resolves | connects | **ECONNRESET** | blocked |
| `api.pexels.com` | resolves | connects | **ECONNRESET** | blocked |
| `api.coverr.co` | resolves | connects | **ECONNRESET** | blocked |
| `registry.npmjs.org` | resolves | connects | succeeds | **reachable** |

DNS resolves and TCP completes, then the TLS handshake is reset. That is the
signature of an egress allowlist terminating the connection, not a provider
outage or a bad key. `registry.npmjs.org` succeeding through the same stack
proves the network path itself is healthy.

**Both blockers are independent.** Supplying credentials alone would not
produce a live run while egress is blocked, which is exactly why the harness
probes reachability even when a key is absent.

---

## 3. What was validated live

Four components were exercised for real, not simulated.

**MoneyPrinterTurbo** — started from the vendored tree, answered HTTP 200, and
the adapter's default base URL matches its actual listen port.

**FFmpeg 7.0.2-static** — encoded a real h264 + aac file and decoded it fully.
These are the exact codecs artifact validation requires.

**eSpeak NG** — real offline synthesis through `voice.local_espeak_tts`, the
REZS-added path, producing 1.912 s of pcm_s16le audio. No cloud TTS involved.

**SQLite** — initialize, write, read, update, and the `UNIQUE` constraint on
`production_jobs.preparation_id` correctly rejecting a duplicate.

The rendering half of the pipeline is therefore genuinely proven against real
services. It is the *external* half — AI and stock media — that remains
unproven.

---

## 4. What could not be validated, and what covers it meanwhile

| Requirement | State | Offline coverage that exists |
| --- | --- | --- |
| Clean APIs auth, model selection, request/response, parsing, schema validation, empty response, timeout, retry, provenance | `NOT_TESTED` | `test/ai-text-service.test.js` (10 tests): selection order, endpoint override scoping, precedence, inert-with-no-credentials, Clean APIs refusing to guess a model |
| Pixabay / Pexels / Coverr auth, search, ranking, download, staging, provenance, duration, dimensions, filename, integrity | `NOT_TESTED` | `test/stock-media.test.js` (20 tests) against the response shapes taken from MoneyPrinterTurbo's own `material.py` |
| Live fallback: success → no-result → failure → total exhaustion | `NOT_TESTED` | `test/shorts-material-service.test.js` (18) and `test/fault-injection.test.js` (11), including `CONFIG_ERROR` aborting after exactly one attempt |
| Full live E2E producing a final MP4 | `NOT_TESTED` | Three substituted E2E runs previously produced a validated 1080×1920 h264/aac Short |

Offline coverage is not a substitute for a live call, and this table does not
present it as one. It is what stands behind the code until the blockers are
removed.

---

## 5. Substitutions used

**None were used in this validation.** The harness has no substitution path;
a component is either live or reported as not live.

One clearly-labelled substituted run was performed separately, only to confirm
the rebuilt environment still renders after the sandbox was reset. It used
`REZS_E2E_LOCAL_AI=true` and FFmpeg-synthesised footage, is recorded as
`SUBSTITUTED`, and is **not** evidence of live integration.

---

## 6. Failure scenarios re-verified

Re-run after the environment rebuild; all previous fixes still hold.

| Scenario | Result |
| --- | --- |
| Media provider I/O fault → not reported as "no footage" | PASS |
| No acquirable footage → `REJECTED`, no specification persisted | PASS |
| Total provider outage → every term and attempt reported | PASS |
| One provider down → next takes over | PASS |
| `CONFIG_ERROR` → aborts after exactly one attempt, no retry loop | PASS |
| Download dies mid-stream → no destination file, no `.part` file | PASS |
| Empty artifact → `EMPTY_ARTIFACT`, nothing stored | PASS |
| Path traversal → refused before the request is made | PASS |
| Process restart mid-render → external task handle survives | PASS |
| Concurrent double-submit → exactly one job | PASS |
| Two jobs claiming one task → rejected | PASS |

Suite totals after rebuild: **lint clean · 197/197 integration · 46/46 legacy
system**.

---

## 7. Provenance the harness records

For each live media asset, without exposing any secret:

```
provider, asset_id, source_url (redacted), page_url (redacted), author,
staged_file, staged_bytes, reported_duration, measured_duration,
measured_resolution, video_codec, audio_codec
```

For a live AI run: provider, model, endpoint (redacted), planning job id,
scene count, estimated duration, title, validation checks.

Secret redaction is enforced in code and covered by
`test/live-validation-redaction.test.js` (11 tests): query-string keys in six
spellings, bearer tokens, keys inside multi-line stack traces, repeated
occurrences, and credential state reporting length without value. This matters
specifically because Pixabay authenticates with a `key` query parameter, so an
unredacted URL in a report would publish the credential.

---

## 8. To complete this validation

Two things are required, and the second is the one usually forgotten:

1. **Provide the credentials** as environment variables — `CLEANAPIS_API_KEY`,
   `CLEANAPIS_MODEL` (Clean APIs publishes no model list, so it must be named),
   `PIXABAY_API_KEY`, `PEXELS_API_KEY`, `COVERR_API_KEY`.
2. **Allow egress** to `www.cleanapis.com`, `pixabay.com`, `api.pexels.com`,
   `api.coverr.co`, plus the CDN hosts the providers redirect downloads to.

Then:

```bash
cd agenttube
node scripts/live-integration-validation.js          # per-component live table
node scripts/e2e-full-pipeline.js "your topic"       # no substitution flags
```

The harness exits non-zero unless every component is `PASS`, so it is safe to
gate on.

---

## 9. Definition of done

| Target | State |
| --- | --- |
| LIVE AI E2E | `NOT_TESTED` — no credential, host unreachable |
| LIVE Pixabay | `NOT_TESTED` — no credential, host unreachable |
| LIVE Pexels | `NOT_TESTED` — no credential, host unreachable |
| LIVE Coverr | `NOT_TESTED` — no credential, host unreachable |
| LIVE MoneyPrinterTurbo | **PASS** |
| REAL FFmpeg | **PASS** |
| REAL TTS | **PASS** |
| FINAL VALIDATION | `NOT_TESTED` — blocked upstream |

**This phase is not complete.** Four of eight targets are blocked by the
environment. No substitution was used to make the numbers look better, and no
component is claimed as live that was not.
