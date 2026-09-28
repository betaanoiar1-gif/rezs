# REZS upstream baseline

Baseline captured on 2026-09-28. This checkpoint vendors two unchanged upstream source trees; it does not yet implement an integration or a Shorts-specific workflow.

## Upstreams

| Component | Repository | Vendored commit | Application version | Latest release observed |
|---|---|---|---|---|
| AgentTube / YouTube Automation Agent | https://github.com/darkzOGx/youtube-automation-agent | `0d7eaf9628ce84e34103f1d1c263dfd89027547e` | `2.10.0` (`package.json`) | `v2.4.0` |
| MoneyPrinterTurbo | https://github.com/harry0703/MoneyPrinterTurbo | `cce2da724e9f8ea944f0282d20f91ae24253e20d` | `1.3.7` (`pyproject.toml`) | `v1.3.7` |

The source trees were copied without their nested `.git` directories. Their exact source commits above are the reproducibility anchors. No application source behavior was changed.

## Runtime inventory

- OS: Debian GNU/Linux 12 (bookworm), Linux x86_64
- Python: 3.11.2
- Node.js installed: 22.22.3
- Node.js used to install/test/start AgentTube: 20.20.2 (satisfies upstream `>=18`)
- npm: 10.9.8
- uv used: 0.12.19
- System FFmpeg: not installed
- System FFprobe: not installed
- Bundled `imageio-ffmpeg`: FFmpeg 7.0.2, available after MPT dependency installation

## Installation

### AgentTube

Upstream procedure:

```bash
cd agenttube
npm ci
```

In this environment, native `sqlite3` installation could not download a prebuilt binary or Node 22 headers because those hosts terminated TLS. Installation was therefore run with Node 20.20.2 and its locally installed headers:

```bash
npx -y -p node@20 node -p 'process.version + " " + process.execPath'
export npm_config_nodedir=/home/user/.npm/_npx/ebaba8b9e55fd0a9/node_modules/node/node_modules/node-linux-x64
npx -y -p node@20 -c 'npm ci'
```

The absolute npm cache path is environment-specific. On a normal host, use the upstream `npm ci` command.

### MoneyPrinterTurbo

Upstream recommends `uv sync --frozen`. Since `uv` was initially unavailable and the official install endpoint had a TLS failure, it was bootstrapped in an isolated temporary virtual environment and then used without changing application source:

```bash
python3 -m venv /tmp/rezs-uv-bootstrap
/tmp/rezs-uv-bootstrap/bin/pip install uv
cd moneyprinterturbo
/tmp/rezs-uv-bootstrap/bin/uv sync --frozen
```

On a normal host with uv installed:

```bash
cd moneyprinterturbo
uv sync --frozen
```

## Validation commands and results

### AgentTube

```bash
cd agenttube
npx -y -p node@20 -c 'npm run lint'
FFMPEG_PATH=/home/user/rezs/moneyprinterturbo/.venv/lib/python3.11/site-packages/imageio_ffmpeg/binaries/ffmpeg-linux-x86_64-v7.0.2 \
  npx -y -p node@20 -c 'npm test'
npx -y -p node@20 -c 'npm start'
curl http://127.0.0.1:3456/health
```

Results:

- Lint: **PASS**.
- Tests: **PASS**, 46 passed and 0 failed. A first run without FFmpeg had 45 passed and one failed; rerunning with the installed MPT FFmpeg binary passed all 46.
- Startup: **PASS** on port 3456 in upstream setup mode.
- Health: **PASS**, HTTP 200 with `status: setup_required` because credentials were intentionally not configured.

### MoneyPrinterTurbo

```bash
cd moneyprinterturbo
.venv/bin/ruff check .
.venv/bin/pytest
.venv/bin/python main.py
curl http://127.0.0.1:8080/ping
```

Results:

- Ruff: **PASS**.
- Tests: **PASS**, 1,425 passed, 20 skipped, 13 warnings.
- Startup: **PASS** on port 8080.
- Health: **PASS**, `GET /ping` returned HTTP 200 and `"pong"`.

Skipped MPT tests are reported as skipped, not passed; they cover optional integrations or environment-dependent functionality.

## Optional dependencies and blocked services

- AgentTube generation/publishing needs an AI provider and YouTube credentials. Neither was configured. Startup safely remained in setup mode.
- MoneyPrinterTurbo media/LLM providers require their respective optional credentials. None was fabricated or tested.
- System FFmpeg and FFprobe are absent. MPT's dependency set supplies an imageio FFmpeg executable, but no system FFprobe.
- MPT's optional TwelveLabs dependency is not installed unless `uv sync --extra twelvelabs` is requested.
- AgentTube dependency audit reported 29 upstream dependency vulnerabilities (2 low, 8 moderate, 18 high, 1 critical). No automatic dependency mutation was performed in this baseline phase.

## Minimal changes from upstream

There are no application source modifications. Only the integration repository's root `README.md`, `.gitattributes`, and this baseline document differ from the two vendored upstream trees. The root attributes file disables trailing-whitespace diagnostics for the vendored trees so they can remain byte-for-byte identical despite pre-existing upstream whitespace; it does not alter application behavior. Runtime-generated and dependency directories remain ignored by the upstream `.gitignore` files.
