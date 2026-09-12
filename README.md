<div align="center">

# Antigravity CLI → OpenAI / Claude / Gemini Proxy

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/Language-English-blue?style=for-the-badge" alt="English"></a>
  <a href="README_zh.md"><img src="https://img.shields.io/badge/语言-简体中文-red?style=for-the-badge" alt="简体中文"></a>
</p>

<p align="center">
  <b>English</b> | <a href="README_zh.md">简体中文</a>
</p>

Local (or VPS) HTTP proxy that turns `agy` (Antigravity CLI) quota into standard **OpenAI**, **Anthropic (Claude)**, and **Gemini Native** API endpoints.<br/>
Features **true streaming reasoning**, **tool call visualization**, **configurable permission modes**, **multi-account rotation**, and a **bilingual admin dashboard**.

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![i18n](https://img.shields.io/badge/Admin%20UI-English%20%7C%20中文-orange.svg)](#dashboard)

</div>

---

## 🌟 Highlights

- 🚀 **Full Protocol Compatibility**:
  - **OpenAI**: `POST /v1/chat/completions` (stream & non-stream) + `GET /v1/models`
  - **Anthropic**: `POST /v1/messages` (Claude thinking compatible)
  - **Gemini Native**: `POST /v1beta/models/{model}:generateContent`
- 🧠 **True Streaming Reasoning**:
  - Emits real-time reasoning content into `delta.reasoning_content` and `delta.reasoning` (OpenAI), `thinking_delta` (Anthropic), and native thought parts (Gemini);
  - Native support for Gemini 3.8 Flash / Pro with auto-configured `--effort` (low/medium/high) to prevent 502 errors.
- ⚙️ **Real-time Tool Call Visualization**:
  - Intercepts CLI tool execution events (running commands, file operations, web searches) and injects them live into the thought stream (e.g. `⚙️ [调用工具] ...` and `↳ 完成`);
  - Prevents timeouts and perceived freezes in long-running coding agents like Trae, Cursor, and Cline.
- 🛡️ **Configurable Permission Modes**:
  - `skip` (default): fully automated headless execution (`--dangerously-skip-permissions`);
  - `accept-edits`: auto-approves workspace edits;
  - `plan`: read-only planning mode.
- 🌐 **Modern Bilingual Dashboard (i18n)**:
  - Built-in web dashboard with seamless **English / 中文** switching;
  - Account health status, 1d/7d/30d token and request usage statistics, quota viewer, and egress proxy checker.
- 🔄 **Smart Account Rotation**:
  - Isolated home directories for independent multi-account concurrency;
  - Automatic cooldown and failover on rate limits.
- 🌐 **Egress Proxy Pool**:
  - Route through HTTP / Socks5 proxy pool to avoid IP restrictions.

---

## 📋 Endpoints

| Path | Protocol | Notes |
|------|----------|--------|
| `POST /v1/chat/completions` | OpenAI | Chat completions, stream + non-stream, thinking delta |
| `POST /v1/messages` | Anthropic | Claude messages API with thinking blocks |
| `POST /v1beta/models/{m}:generateContent` | Gemini | Google Gemini native endpoint |
| `GET /v1/models` | OpenAI | Available model list |
| `GET /healthz` | General | Liveness probe |
| `GET /admin/ui` | Dashboard | Web admin console (loopback open; remote needs API key) |

Default listen: `127.0.0.1:1413`. Client key: `sk-agy-local` (configurable in `config.json`).

---

## 🚀 Setup & Quickstart

### 1. Prerequisites
- [Node.js](https://nodejs.org/) (>= 18)
- Official `agy` CLI installed and logged in at least once.

### 2. Install & Configure
```bash
git clone https://github.com/tinytinycn/agy-proxy.git
cd agy-proxy
npm install

cp config.json.example config.json
cp accounts.json.example accounts.json
cp proxies.txt.example proxies.txt
```

### 3. Run
```bash
node server.js
```

Open Dashboard: [http://127.0.0.1:1413/admin/ui](http://127.0.0.1:1413/admin/ui)

---

## 🛠️ Client Integration

### Trae IDE / Cursor
1. Go to settings and add a custom OpenAI API provider.
2. Settings:
   - **API Base URL**: `http://127.0.0.1:1413/v1`
   - **API Key**: `sk-agy-local`
   - **Model**: `gemini-3.8-flash` or `gemini-3.8-pro`
3. Enjoy live thinking collapsible blocks and tool execution steps directly in the chat!

### cURL Examples

#### Streaming (with reasoning)
```bash
curl http://127.0.0.1:1413/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-agy-local" \
  -d '{
    "model": "gemini-3.8-flash",
    "stream": true,
    "messages": [{"role": "user", "content": "Explain quicksort with examples"}]
  }'
```

---

## ⚙️ Configuration (`config.json`)

```json
{
  "apiKey": "sk-agy-local",
  "rotation": "rotate",
  "maxAccountRetries": 4,
  "cooldownMs": 60000,
  "defaultModel": "gemini-3.8-flash",
  "permissionMode": "skip",
  "adminAuth": false,
  "listenHost": "127.0.0.1",
  "listenPort": 1413,
  "maxInflight": 8,
  "egress": {
    "mode": "rotate",
    "enabled": false,
    "failThreshold": 3
  }
}
```

---

## 🖥️ VPS Deployment (Linux)

```bash
export AGY_PROXY_HOST=0.0.0.0
export AGY_PROXY_PORT=1413
export AGY_BIN=/home/ubuntu/.local/bin/agy

npm install -g pm2
pm2 start server.js --name "agy-proxy"
```

- Remote dashboard: `http://<VPS_IP>:1413/admin/ui?key=sk-agy-local`
- Linux accounts run under isolated `homes/` for parallel execution.

---

## 📂 Layout

| File | Role |
|------|------|
| `server.js` | HTTP gateway (OpenAI / Anthropic / Gemini routing & streaming) |
| `agy_cli.js` | CLI subprocess execution, stream tag parsing & tool interception |
| `accounts.js` | Account pool, concurrency lock, and rotation |
| `proxies.js` | Egress HTTP/Socks5 pool |
| `auth.js` | OAuth login flow via CLI |
| `quota.js` | `/quota` balance checking per account |
| `usage.js` | 1d / 7d / 30d request and token statistics |
| `dashboard.html` | Admin UI with English / Chinese i18n support |
| `config.json` | Server and proxy configuration |

---

## 📄 License

Distributed under the [MIT License](LICENSE).
