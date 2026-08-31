# Antigravity CLI → OpenAI proxy

Local (or VPS) HTTP proxy that turns `agy` (Antigravity CLI) quota into OpenAI / Anthropic / Gemini endpoints. Multi-account round-robin + egress HTTP proxy pool.

Requires **agy.exe** (or `agy` on Linux). Direct Cloud Code HTTP is 403 `SUBSCRIPTION_REQUIRED` — the backend is always a CLI subprocess.

## Endpoints

| Path | Notes |
|------|--------|
| `POST /v1/chat/completions` | OpenAI, stream + non-stream |
| `POST /v1/messages` | Anthropic |
| `POST /v1beta/models/{m}:generateContent` | Gemini native |
| `GET /v1/models` | model list |
| `GET /healthz` | liveness |
| `GET /admin/ui` | dashboard (loopback open; remote needs API key) |

Default listen: `127.0.0.1:1413`. Client key: `sk-agy-local` (change in `config.json`).

## Setup

```bash
cp config.json.example config.json
cp accounts.json.example accounts.json
cp proxies.txt.example proxies.txt
# install agy CLI, log in once
node server.js
```

Dashboard: http://127.0.0.1:1413/admin/ui

Add accounts in **Accounts**: Login (link + code) — open the Google URL, paste the `oauth-callback?code=...` redirect.

## VPS

```bash
export AGY_PROXY_HOST=0.0.0.0
export AGY_PROXY_PORT=1413
node server.js
```

- `/v1/*` always needs `Authorization: Bearer <apiKey>`
- Remote `/admin/*` needs the same key. Dashboard: `http://<ip>:1413/admin/ui?key=sk-agy-local`
- Windows: agy spawn is **serialized** (one Credential Manager target). Linux: isolated `HOME` per account → parallel.

## Layout

| File | Role |
|------|------|
| `server.js` | HTTP server |
| `agy_cli.js` | spawn agy stream-json |
| `accounts.js` | rotation, busy lock |
| `proxies.js` | egress pool |
| `auth.js` | OAuth link+code |
| `quota.js` | `/quota` `/credits` per account |
| `usage.js` | 1d / 7d / 30d request+token stats |
| `dashboard.html` | admin UI |

Do not commit `homes/`, `accounts.json`, `proxies.txt`, `usage.jsonl`,
`oauth-clients.json`, or credential dumps. Copy `oauth-clients.json.example`
to `oauth-clients.json` (client id/secret from the agy binary) for account login.
