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

## 2. Environment assessment

### 2.1 Secrets mechanism available in Arena

The runtime is an **E2B sandbox** (`/run/e2b`, `E2B_SANDBOX_ID`). Its entire
environment is 16 variables. There is **no secrets mount** — `/run/secrets`,
`/var/run/secrets`, `/etc/secrets`, `/vault`, `~/.secrets` and
`~/.config/secrets` are all absent, `/etc/environment` is empty (0 bytes), and
no metadata service listens locally.

What does exist is proof that the platform can inject environment variables:
`GH_TOKEN` and `GITHUB_TOKEN` are present in the sandbox and were placed there
by Arena, not by this repository.

**So the mechanism is environment-variable injection at sandbox creation.**
It must be configured from the Arena side — it cannot be created, enumerated
or written from inside the sandbox, and nothing in this repository can grant
itself a credential. No `.env` file exists, and `.env` is gitignored
(`agenttube/.gitignore:8`), so a committed secret is not possible through the
normal path.

### 2.2 How the project consumes secrets without leaking them

Already implemented; nothing further is required:

- Every entry point calls `dotenv`, then reads `process.env.<NAME>` only.
  The six names are `CLEANAPIS_API_KEY`, `CLEANAPIS_MODEL`,
  `CLEANAPIS_BASE_URL`, `PIXABAY_API_KEY`, `PEXELS_API_KEY`, `COVERR_API_KEY`.
- No code path logs a credential value. The only `process.env` value reaching
  a log is `MPT_BASE_URL`, a local address.
- Provider errors carry `{ provider, status }`, never the request URL or
  headers, so a Pixabay key in a query string cannot reach a message.
- The validation harness reports credentials as `set (N characters)` or
  `NOT SET`, never the value, and passes anything that could contain a key
  through `redact()`. Covered by `test/live-validation-redaction.test.js`.

### 2.3 Egress status

Probed at DNS, TCP and TLS, then **re-probed with the system CA bundle** to
separate a trust problem from a blocked route:

| Host | Role | DNS | TCP :443 | TLS | Verdict |
| --- | --- | --- | --- | --- | --- |
| `www.cleanapis.com` | Clean APIs | resolves | connects | `ECONNRESET` | **BLOCKED** |
| `pixabay.com` | Pixabay API + media | resolves | connects | `ECONNRESET` | **BLOCKED** |
| `cdn.pixabay.com` | Pixabay media CDN | resolves | connects | `ECONNRESET` | **BLOCKED** |
| `api.pexels.com` | Pexels API | resolves | connects | `ECONNRESET` | **BLOCKED** |
| `videos.pexels.com` | Pexels media CDN | resolves | connects | `ECONNRESET` | **BLOCKED** |
| `player.vimeo.com` | Pexels media fallback | resolves | connects | `ECONNRESET` | **BLOCKED** |
| `api.coverr.co` | Coverr API | resolves | connects | `ECONNRESET` | **BLOCKED** |
| `storage.coverr.co` | Coverr media CDN | resolves | connects | `ECONNRESET` | **BLOCKED** |
| `cdn.coverr.co` | Coverr media CDN | resolves | connects | `ECONNRESET` | **BLOCKED** |
| `registry.npmjs.org` | control | resolves | connects | OK, issuer *Google Trust Services* | reachable, passthrough |
| `github.com` | control | resolves | connects | OK, issuer **E2B** | reachable, **TLS-intercepted** |

Egress leaves through an E2B proxy that behaves three different ways, and the
difference matters:

1. **Passthrough** — `registry.npmjs.org` presents its real certificate.
2. **Intercepted** — `github.com` presents a certificate issued by
   `O = E2B, CN = E2B Proxy CA`, which is present in the system CA bundle
   (`/etc/ssl/certs/ca-certificates.crt`, 143 certs) but **not** in Node's
   built-in store. Node therefore fails such a host with
   `UNABLE_TO_VERIFY_LEAF_SIGNATURE` until it is told to trust the system
   bundle.
3. **Blocked** — all nine provider hosts are reset at the TLS handshake.

The reset persists with the system CA bundle loaded, which rules out a
certificate problem: these hosts are **not on the egress allowlist**. This is
an environment restriction, not a provider outage and not a rejected key. No
attempt was made to work around it.

### 2.4 Consequence for the live run

`NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt` will very likely be
required once the providers are allowlisted, because an allowlisted host is
served through the intercepting proxy, exactly like `github.com`. Without it,
every provider call fails with a certificate error that looks like a provider
fault. This is ordinary configuration — pointing Node at the trust store curl
and git already use — not a bypass.

**The two blockers are independent.** Supplying credentials alone will not
produce a live run while egress is blocked, which is why the harness probes
reachability even when a key is absent.

### 2.5 Whether the platform exposes controls for either

Checked against Arena's own documentation rather than assumed. The help centre
holds 34 articles across four collections (How To 18, Troubleshooting 10,
Policies 5, Experiments 1). None concerns secrets, environment variables, or
network configuration.

"How to use coding in Agent Mode" enumerates the whole coding feature set —
connect GitHub, work in a sandbox copy of the repository, review a diff, drive
the git workflow, request a preview, watch the Checks window, one pull request
per session. The settings control it describes manages repositories and the
GitHub connection, nothing else. "How to use Agent Mode" lists the tools as web
search, image generation, file upload, coding assistance and a sandbox/bash
environment.

**Conclusion: Arena currently exposes no user-facing mechanism to set custom
sandbox environment variables, and none to modify the egress allowlist.** The
platform clearly has the capability — `GH_TOKEN` is injected for the GitHub
integration, and the allowlist already admits `registry.npmjs.org`, `pypi.org`
and `github.com` — but it is not surfaced as a user setting, and it cannot be
reached from inside the sandbox.

This is worth stating plainly because comparable platforms do document these
controls: Codex exposes a `domains` allowlist and setup-scoped secrets, Claude
Code exposes `sandbox.network.allowedDomains` and `sandbox.credentials.envVars`,
and Google's Agent Platform exposes a domain allowlist. Arena documents neither,
so this is a platform gap to raise with Arena support, not a configuration step
that was missed.

No workaround was attempted. Building an egress proxy or relaying the provider
APIs through a permitted host would defeat a deliberate security control and
would change the architecture, so the status stays `UNREACHABLE`.

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

### 8.1 Variables to set in Arena (names only — never paste values into chat, source or Git)

| Variable | Required | Purpose |
| --- | --- | --- |
| `CLEANAPIS_API_KEY` | yes | Clean APIs authentication |
| `CLEANAPIS_MODEL` | **yes** | Clean APIs publishes no model list, so the service refuses to guess one |
| `PIXABAY_API_KEY` | yes | Pixabay authentication |
| `PEXELS_API_KEY` | yes | Pexels authentication |
| `COVERR_API_KEY` | yes | Coverr authentication |
| `CLEANAPIS_BASE_URL` | optional | Only to override the default endpoint |

They must arrive as process environment variables in the sandbox, the same way
`GH_TOKEN` already does. No repository change is needed to consume them.

### 8.2 Domains to allowlist for egress

API hosts alone are not enough: search would succeed and every download would
fail. The media CDNs are required, and this list is taken from the host
allowlist the code itself enforces in `integrations/stock-media.js`.

| Provider | API host | Download hosts |
| --- | --- | --- |
| Clean APIs | `www.cleanapis.com` | — |
| Pixabay | `pixabay.com` | `cdn.pixabay.com` |
| Pexels | `api.pexels.com` | `videos.pexels.com`, `player.vimeo.com` |
| Coverr | `api.coverr.co` | `storage.coverr.co`, `cdn.coverr.co`, `coverr.co` |

### 8.3 Final commands

Per-component live validation:

```bash
cd agenttube
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
FFMPEG_PATH=/home/user/.local/bin/ffmpeg \
FFPROBE_PATH=/home/user/.local/bin/ffprobe \
MPT_BASE_URL=http://127.0.0.1:8080 \
node scripts/live-integration-validation.js
```

Full live end-to-end, with no substitution flags set:

```bash
cd agenttube
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
FFMPEG_PATH=/home/user/.local/bin/ffmpeg \
FFPROBE_PATH=/home/user/.local/bin/ffprobe \
MPT_BASE_URL=http://127.0.0.1:8080 \
MPT_VOICE_NAME="local_espeak:en-us" \
MPT_POLL_INTERVAL_MS=3000 MPT_MAX_POLLS=600 \
node scripts/e2e-full-pipeline.js "why cold water swimming improves focus"
```

MoneyPrinterTurbo must be running first:

```bash
cd moneyprinterturbo && PATH="$HOME/.local/bin:$PATH" .venv/bin/python main.py
```

Omitting `REZS_E2E_LOCAL_AI` and `REZS_E2E_SEED_MATERIALS` is what makes the
E2E fully live; with providers configured it uses them automatically. The
validation harness exits non-zero unless every component is `PASS`, so it is
safe to gate on. Neither `NO_CREDENTIAL` nor `UNREACHABLE` is treated as
success.

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
