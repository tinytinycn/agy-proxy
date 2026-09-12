<div align="center">

# Antigravity CLI → OpenAI / Claude / Gemini 代理服务

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/Language-English-blue?style=for-the-badge" alt="English"></a>
  <a href="README_zh.md"><img src="https://img.shields.io/badge/语言-简体中文-red?style=for-the-badge" alt="简体中文"></a>
</p>

<p align="center">
  <a href="README.md">English</a> | <b>简体中文</b>
</p>

将 Google Antigravity CLI (`agy`) 配额转换为标准兼容的 **OpenAI**、**Anthropic (Claude)** 与 **Gemini 原生** API 服务。<br/>
支持**真流式思考输出**、**多工具调用过程可视化**、**三档权限安全模式**、**多账号智能轮询**与**双语管理后台**。

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![i18n](https://img.shields.io/badge/Admin%20UI-中文%20%7C%20English-orange.svg)](#管理控制台)

</div>

---

## 🌟 核心特性

- 🚀 **全协议无缝兼容**：
  - **OpenAI 兼容接口**：`POST /v1/chat/completions`（支持流式与非流式）及 `/v1/models`
  - **Anthropic 兼容接口**：`POST /v1/messages`
  - **Gemini 原生接口**：`POST /v1beta/models/{model}:generateContent`
- 🧠 **真流式思考（Reasoning / Thinking）输出**：
  - 增量分发思考过程，完整适配 OpenAI `delta.reasoning_content` / `delta.reasoning`、Anthropic `thinking_delta` 及 Gemini 原生思考字段；
  - 原生支持 Gemini 3.8 Flash / Pro 等最新思考模型，自动适配 `--effort` 参数（low / medium / high），杜绝 502 崩溃。
- ⚙️ **工具调用过程实时可视化**：
  - 自动捕获 CLI 底层工具执行事件（如运行命令、读写文件、网络搜索等），并实时格式化注入到思考流中（如 `⚙️ [调用工具] ...` 和 `↳ 完成`）；
  - 彻底解决类似 Trae、Cursor、Cline 等长任务 Coding Agent 假死或等待超时的问题。
- 🛡️ **三档权限控制模式（Permission Mode）**：
  - `skip`（默认）：全自动无人值守模式（`--dangerously-skip-permissions`），避免无交互环境下被 CLI 权限弹窗挂起；
  - `accept-edits`：仅自动接受文件编辑修改；
  - `plan`：只读规划模式，保护工作目录不受修改；
  - 支持在管理后台设置中动态切换并实时生效。
- 🌐 **双语管理控制台（Admin UI i18n）**：
  - 内置现代化管理面板，支持**中文 / English 一键无缝切换**并记忆偏好；
  - 提供多账号管理、请求统计（1天 / 7天 / 30天 Token 消耗与模型分布）、额度实时查询、出站代理池检测与配置管理。
- 🔄 **多账号智能轮询与冷却隔离**：
  - 隔离独立主目录（Home），多账号支持并发调用；
  - 遇限流或异常自动冷却并无缝切换至下一可用账号。
- 🌐 **出站代理池（Egress Proxy Pool）**：
  - 支持配置 HTTP / Socks5 代理池，避免请求被单一 IP 限流。

---

## 📋 API 端点清单

| 请求路径 | 协议标准 | 说明 |
|---------|---------|------|
| `POST /v1/chat/completions` | OpenAI | 对话补全，支持 `stream: true/false`，返回思考过程 |
| `POST /v1/messages` | Anthropic | Claude 格式接口，支持思考块 |
| `POST /v1beta/models/{m}:generateContent` | Gemini | Google Gemini 原生 API 端点 |
| `GET /v1/models` | OpenAI | 模型列表查询 |
| `GET /healthz` | 通用 | 服务健康检查 |
| `GET /admin/ui` | 管理后台 | Web 管理面板（本机直接访问，远程需携带 API Key） |

默认监听端口：`127.0.0.1:1413`（或在 `config.json` 中配置）。默认客户端 API Key：`sk-agy-local`。

---

## 🚀 快速上手

### 1. 环境准备
1. 确保已安装 [Node.js](https://nodejs.org/) (>= 18)。
2. 安装并登录官方 Antigravity CLI（`agy`），确保本地能够正常执行 CLI 命令。

### 2. 克隆与安装
```bash
git clone https://github.com/tinytinycn/agy-proxy.git
cd agy-proxy
npm install
```

### 3. 初始化配置文件
```bash
cp config.json.example config.json
cp accounts.json.example accounts.json
cp proxies.txt.example proxies.txt
```

### 4. 启动服务
```bash
node server.js
```
启动成功后，浏览器打开管理后台：[http://127.0.0.1:1413/admin/ui](http://127.0.0.1:1413/admin/ui)

---

## 🛠️ 客户端配置指南

可以将本代理接入各种流行的 AI 编辑器或客户端（如 Trae、Cursor、Cline、NextChat、Cherry Studio 等）。

### Trae IDE / Cursor 配置
1. 打开设置中的 **Model / Custom OpenAI API**；
2. 配置参数：
   - **API Base URL**: `http://127.0.0.1:1413/v1`
   - **API Key**: `sk-agy-local`（或您在 `config.json` 中设置的 `apiKey`）
   - **Model Name**: `gemini-3.8-flash`、`gemini-3.8-pro` 或 `gemini-3.7-flash`
3. 效果体验：
   - 思考链（Thinking）将以折叠块形式正常流式展开；
   - 模型在执行复杂任务时，调用的工具进展会实时显示在思考流中，不会出现无响应超时。

### cURL 调用测试

#### 非流式请求
```bash
curl http://127.0.0.1:1413/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-agy-local" \
  -d '{
    "model": "gemini-3.8-flash",
    "messages": [{"role": "user", "content": "9.11 和 9.9 哪个数字大？简要说明"}]
  }'
```

#### 流式请求（观察思考过程）
```bash
curl http://127.0.0.1:1413/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-agy-local" \
  -d '{
    "model": "gemini-3.8-flash",
    "stream": true,
    "messages": [{"role": "user", "content": "写一个快速排序算法"}]
  }'
```

---

## ⚙️ 核心配置详解 (`config.json`)

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

| 字段 | 类型 | 说明 |
|------|------|------|
| `apiKey` | string | 客户端调用 `/v1/*` 所需的 Bearer Token |
| `permissionMode` | string | CLI 权限模式：`skip`（全自动跳过，推荐）、`accept-edits`、`plan` |
| `rotation` | string | 账号轮询策略：`rotate`（按顺序轮换） |
| `cooldownMs` | number | 账号遇到限流或异常后的冷却时间（毫秒） |
| `defaultModel` | string | 未指定模型时的默认模型 |
| `listenHost` | string | 监听 IP（本机为 `127.0.0.1`，开放远程请设为 `0.0.0.0`） |
| `listenPort` | number | 监听端口（默认 `1413`） |

---

## 🖥️ 部署至 VPS (Linux 服务器)

在无图形界面的云服务器上部署运行：

```bash
export AGY_PROXY_HOST=0.0.0.0
export AGY_PROXY_PORT=1413
export AGY_BIN=/home/ubuntu/.local/bin/agy  # CLI 执行文件路径

# 使用 PM2 守护进程运行
npm install -g pm2
pm2 start server.js --name "agy-proxy"
```

- 远程访问后台管理面板：`http://<VPS_IP>:1413/admin/ui?key=sk-agy-local`
- Linux 账号隔离：系统自动为每个账号在 `homes/` 下创建独立的 `HOME` 目录，支持真正的无锁多账号并发。

---

## 📂 项目结构

```text
├── server.js          # HTTP 网关，处理 OpenAI / Anthropic / Gemini 路由与流式转换
├── agy_cli.js         # CLI 子进程调用包装，流式标签解析与工具事件拦截
├── accounts.js        # 多账号管理、并发锁与轮询调度
├── proxies.js         # 出站 HTTP/Socks5 代理池
├── auth.js            # 账号登录与 OAuth 授权流程
├── quota.js           # 账号余额与配额查询
├── usage.js           # 1天 / 7天 / 30天 请求与 Token 统计
├── dashboard.html     # 管理后台 UI（含中英文 i18n 支持）
└── config.json        # 代理服务配置文件
```

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 协议发布。
