'use strict';
// Antigravity (agy) -> OpenAI / Anthropic / Gemini compatible proxy
// Port default 1413. Multi-akun round-robin + egress proxy round-robin.
//
// Endpoint:
//   GET  /v1/models                       (OpenAI)
//   POST /v1/chat/completions             (OpenAI, stream + non-stream)
//   POST /v1/messages                     (Anthropic, stream + non-stream)
//   POST /v1beta/models/{m}:streamGenerateContent (Gemini native)
//   GET  /v1beta/models                   (Gemini)
//   GET  /healthz
//   ADMIN (loopback only, tanpa auth):
//   GET  /admin/state  /admin/accounts  /admin/egress  /admin/quota
//   POST /admin/accounts/{disable,enable,reset}  /admin/egress/{load,config,reset,check}
//   GET  /admin/ui                        (dashboard web)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const agy = require('./agy_cli.js');
const accounts = require('./accounts.js');
const proxies = require('./proxies.js');
const auth = require('./auth.js');
const quotaMod = require('./quota.js');
const usage = require('./usage.js');

const DIR = __dirname;
const PORT = parseInt(process.env.AGY_PROXY_PORT || '1413', 10);

const CONFIG_FILE = path.join(DIR, 'config.json');
let config = {
  apiKey: 'sk-agy-local',
  rotation: 'rotate',
  maxAccountRetries: 4,
  cooldownMs: 60000,
  defaultModel: 'gemini-3.7-flash-low',
  adminAuth: false,
  listenHost: '127.0.0.1',
  maxInflight: 8,
  egress: { enabled: false, mode: 'rotate', failThreshold: 3 },
};
if (fs.existsSync(CONFIG_FILE)) {
  try { config = Object.assign({}, config, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); }
  catch (e) { console.error('[config] parse gagal, pakai default:', e.message); }
}
const HOST = process.env.AGY_PROXY_HOST || config.listenHost || '127.0.0.1';
const BIND_PUBLIC = HOST === '0.0.0.0' || HOST === '::';
proxies.setConfig(config.egress || {});
proxies.load();

let MODEL_CACHE = agy.listModels();

// ---------------- util ----------------
function sendJson(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'X-Agy-Account,X-Agy-Egress',
  }, extraHeaders || {}));
  res.end(body);
}
function readBody(req, limitBytes = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('body terlalu besar')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function newId(p) { return (p || 'chatcmpl-') + crypto.randomBytes(12).toString('hex'); }
function nowSec() { return Math.floor(Date.now() / 1000); }
function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
}
function clientIp(req) {
  return (req.socket.remoteAddress || '').replace('::ffff:', '');
}

// Autentikasi klien untuk /v1/*
function authorized(req, url) {
  if (!config.apiKey) return true;
  const h = req.headers['authorization'] || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  const xkey = req.headers['x-api-key'] || '';
  let keyParam = '';
  try { keyParam = url.searchParams.get('key') || ''; } catch (e) { keyParam = ''; }
  return bearer === config.apiKey || xkey === config.apiKey || keyParam === config.apiKey;
}

// ---------------- konversi format ----------------
// OpenAI messages -> satu prompt teks bergaya percakapan.
function openaiMessagesToPrompt(messages) {
  const parts = [];
  if (Array.isArray(messages)) {
    for (const m of messages) {
      const role = (m.role || 'user');
      let content = m.content;
      if (Array.isArray(content)) {
        content = content.map(c => (c && (c.text || c.content)) || '').filter(Boolean).join('\n');
      }
      if (role === 'system') parts.push('[SYSTEM]\n' + content);
      else if (role === 'assistant') parts.push('[ASSISTANT]\n' + content);
      else parts.push('[USER]\n' + content);
    }
  }
  return parts.join('\n\n') || '';
}

// Anthropic messages -> prompt (system terpisah).
function anthropicToPrompt(body) {
  const sys = typeof body.system === 'string' ? body.system
    : Array.isArray(body.system) ? body.system.map(s => s && s.text || '').join('\n') : '';
  const parts = [];
  if (sys) parts.push('[SYSTEM]\n' + sys);
  for (const m of body.messages || []) {
    let content = m.content;
    if (Array.isArray(content)) content = content.map(c => (c && (c.text || c.content)) || '').filter(Boolean).join('\n');
    parts.push((m.role === 'assistant' ? '[ASSISTANT]\n' : '[USER]\n') + content);
  }
  return parts.join('\n\n');
}

function usageFromAgy(u, model) {
  const inp = (u && u.input_tokens) || 0;
  const out = (u && u.output_tokens) || 0;
  return {
    prompt_tokens: inp,
    completion_tokens: out,
    total_tokens: inp + out,
    prompt_tokens_details: { cached_tokens: (u && u.cache_read_tokens) || 0 },
    completion_tokens_details: { reasoning_tokens: (u && u.thinking_tokens) || 0 },
  };
}

// ---------------- inti: jalankan ke agy dengan rotasi akun ----------------
const recentReqs = [];
function logReq(entry) {
  recentReqs.unshift(entry);
  if (recentReqs.length > 80) recentReqs.length = 80;
  usage.append(entry);
}

let inflight = 0;
const MAX_INFLIGHT = parseInt(process.env.AGY_MAX_INFLIGHT || String(config.maxInflight || 32), 10);
const waitQueue = [];

let quotaCache = { at: 0, data: null };
const QUOTA_TTL_MS = 60 * 1000;

async function withSlot(fn) {
  while (inflight >= MAX_INFLIGHT) {
    await new Promise(r => waitQueue.push(r));
  }
  inflight++;
  try { return await fn(); }
  finally {
    inflight--;
    const n = waitQueue.shift();
    if (n) n();
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function acquireAccount(mode, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const acct = accounts.acquireNext(mode === 'lru' ? 'lru' : 'rotate');
    if (acct) return acct;
    await sleep(40);
  }
  return null;
}

const SERIAL_CRED = process.env.AGY_SERIAL_CRED
  ? process.env.AGY_SERIAL_CRED !== '0'
  : process.platform === 'win32';

async function runAgyForAccount(acct, prompt, opts, egress) {
  const run = () => agy.runOnce(prompt, {
    model: opts.model,
    cwd: acct.geminiDir || process.cwd(),
    home: acct.geminiDir || undefined,
    proxyUrl: egress ? egress.url : undefined,
    timeoutSec: opts.timeoutSec || 300,
    effort: opts.effort,
  });
  if (!SERIAL_CRED) return run();
  return auth.withCredLock(async () => {
    await auth.activateAccountToken(acct);
    return run();
  });
}

async function runWithRotation(prompt, opts) {
  return withSlot(() => runWithRotationInner(prompt, opts));
}

async function runWithRotationInner(prompt, opts) {
  const maxTries = config.maxAccountRetries || 4;
  const waitAcctMs = opts.waitAcctMs || 180000;
  const mode = config.rotation === 'lru' ? 'lru' : 'rotate';
  let lastErr = null;
  const tried = [];

  for (let attempt = 0; attempt < maxTries; attempt++) {
    const acct = await acquireAccount(mode, waitAcctMs);
    if (!acct) {
      return { ok: false, status: 503, error: 'tidak ada akun (semua sibuk/cooldown/disabled)', tried };
    }
    const egress = proxies.pick(acct.label);
    tried.push({ label: acct.label, egress: egress ? egress.host : 'direct' });

    const t0 = Date.now();
    let r;
    try {
      r = await runAgyForAccount(acct, prompt, opts, egress);
    } catch (e) {
      accounts.markError(acct, e.message, config.cooldownMs);
      lastErr = e.message;
      logReq({ t: Date.now(), ok: false, account: acct.label, egress: egress ? egress.host : 'direct', model: opts.model, ms: Date.now() - t0, err: String(e.message).slice(0, 180), proto: opts.proto || '-' });
      continue;
    } finally {
      accounts.release(acct);
    }

    if (r.ok && r.text && r.text.trim()) {
      accounts.markOk(acct, r.usage, { durationMs: r.durationMs });
      if (egress) proxies.reportOk(egress, r.durationMs);
      logReq({ t: Date.now(), ok: true, account: acct.label, egress: egress ? egress.host : 'direct', model: opts.model, ms: r.durationMs, tokens_in: (r.usage && r.usage.input_tokens) || 0, tokens_out: (r.usage && r.usage.output_tokens) || 0, proto: opts.proto || '-' });
      return { ok: true, text: r.text, account: acct.label, egress: egress ? egress.host : 'direct', usage: r.usage, durationMs: r.durationMs, tried };
    }

    const msg = (r.raw && (r.raw.err || r.raw.stderr)) || r.text || 'respon kosong';
    accounts.markError(acct, msg, accounts.isQuotaError(msg) ? config.cooldownMs : 0);
    if (egress) proxies.reportFail(egress, msg);
    lastErr = msg;
    logReq({ t: Date.now(), ok: false, account: acct.label, egress: egress ? egress.host : 'direct', model: opts.model, ms: Date.now() - t0, err: String(msg).slice(0, 180), proto: opts.proto || '-' });
    if (accounts.isAuthError(msg)) accounts.setDisabled(acct.label, true);
  }

  const status = accounts.isQuotaError(lastErr) ? 429 : 502;
  return { ok: false, status, error: String(lastErr || 'gagal').slice(0, 500), tried };
}

// ---------------- handler OpenAI ----------------
async function handleOpenAIChat(req, res, body) {
  let payload;
  try { payload = JSON.parse(body); }
  catch (e) { return sendJson(res, 400, { error: { message: 'JSON tidak valid', type: 'invalid_request_error' } }); }

  const model = payload.model || config.defaultModel;
  const prompt = openaiMessagesToPrompt(payload.messages);
  if (!prompt) return sendJson(res, 400, { error: { message: 'messages kosong', type: 'invalid_request_error' } });

  const wantStream = !!payload.stream;
  const maxTokens = payload.max_tokens || payload.max_completion_tokens;

  const r = await runWithRotation(prompt, { model, timeoutSec: 300, proto: 'openai' });
  const hdr = { 'X-Agy-Account': r.account || '-', 'X-Agy-Egress': r.egress || '-' };

  if (!r.ok) {
    return sendJson(res, r.status, { error: { message: r.error, type: 'upstream_error', tried: r.tried } }, hdr);
  }

  const text = r.text;
  const id = newId('chatcmpl-');
  const usage = usageFromAgy(r.usage, model);

  if (wantStream) {
    res.writeHead(200, Object.assign({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    }, hdr));
    // kirim per potongan kecil agar klien melihat streaming nyata
    const chunkSize = 24;
    const created = nowSec();
    for (let i = 0; i < text.length; i += chunkSize) {
      const piece = text.slice(i, i + chunkSize);
      const ev = {
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
      };
      res.write('data: ' + JSON.stringify(ev) + '\n\n');
      await new Promise(s => setTimeout(s, 8));
    }
    const fin = {
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage,
    };
    res.write('data: ' + JSON.stringify(fin) + '\n\n');
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  const resp = {
    id, object: 'chat.completion', created: nowSec(), model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop', logprobs: null }],
    usage,
    system_fingerprint: 'agy-' + (r.account || 'na'),
  };
  if (maxTokens) resp.usage.completion_tokens = Math.min(resp.usage.completion_tokens, maxTokens);
  return sendJson(res, 200, resp, hdr);
}

// ---------------- handler Anthropic ----------------
async function handleAnthropicMessages(req, res, body) {
  let payload;
  try { payload = JSON.parse(body); }
  catch (e) { return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'JSON tidak valid' } }); }

  const model = payload.model || config.defaultModel;
  const prompt = anthropicToPrompt(payload);
  if (!prompt) return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages kosong' } });

  const wantStream = !!payload.stream;
  const r = await runWithRotation(prompt, { model, timeoutSec: 300, proto: 'anthropic' });
  const hdr = { 'X-Agy-Account': r.account || '-', 'X-Agy-Egress': r.egress || '-' };

  if (!r.ok) return sendJson(res, r.status, { type: 'error', error: { type: 'upstream_error', message: r.error, tried: r.tried } }, hdr);

  const text = r.text;
  const id = newId('msg_');
  const inp = (r.usage && r.usage.input_tokens) || 0;
  const out = (r.usage && r.usage.output_tokens) || 0;

  if (wantStream) {
    res.writeHead(200, Object.assign({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    }, hdr));
    const send = (ev, data) => res.write('event: ' + ev + '\ndata: ' + JSON.stringify(data) + '\n\n');
    send('message_start', {
      type: 'message_start',
      message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inp, output_tokens: 1 } },
    });
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    const chunkSize = 24;
    for (let i = 0; i < text.length; i += chunkSize) {
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + chunkSize) } });
      await new Promise(s => setTimeout(s, 8));
    }
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: out } });
    send('message_stop', { type: 'message_stop' });
    return res.end();
  }

  return sendJson(res, 200, {
    id, type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: inp, output_tokens: out },
  }, hdr);
}

// ---------------- handler Gemini native ----------------
async function handleGeminiGenerate(req, res, body, stream) {
  let payload;
  try { payload = JSON.parse(body); }
  catch (e) { return sendJson(res, 400, { error: { code: 400, message: 'JSON tidak valid', status: 'INVALID_ARGUMENT' } }); }

  const model = req.url.includes('/models/') ? decodeURIComponent(req.url.split('/models/')[1].split(':')[0]) : config.defaultModel;
  const parts = [];
  for (const c of (payload.contents || [])) {
    const t = (c.parts || []).map(p => p.text || '').join('');
    if (t) parts.push((c.role === 'model' ? '[ASSISTANT]\n' : '[USER]\n') + t);
  }
  if (payload.systemInstruction) {
    const si = (payload.systemInstruction.parts || []).map(p => p.text || '').join('');
    if (si) parts.unshift('[SYSTEM]\n' + si);
  }
  const prompt = parts.join('\n\n');
  if (!prompt) return sendJson(res, 400, { error: { code: 400, message: 'contents kosong', status: 'INVALID_ARGUMENT' } });

  const r = await runWithRotation(prompt, { model, timeoutSec: 300, proto: 'gemini' });
  const hdr = { 'X-Agy-Account': r.account || '-', 'X-Agy-Egress': r.egress || '-' };
  if (!r.ok) return sendJson(res, r.status, { error: { code: r.status, message: r.error, status: 'UNAVAILABLE', tried: r.tried } }, hdr);

  const text = r.text;
  const usage = r.usage || {};
  const out = {
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }],
    usageMetadata: {
      promptTokenCount: usage.input_tokens || 0,
      candidatesTokenCount: usage.output_tokens || 0,
      totalTokenCount: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    },
    modelVersion: model,
  };

  if (stream) {
    res.writeHead(200, Object.assign({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no',
    }, hdr));
    const chunkSize = 24;
    for (let i = 0; i < text.length; i += chunkSize) {
      res.write('data: ' + JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: text.slice(i, i + chunkSize) }] }, index: 0 }],
        modelVersion: model,
      }) + '\n\n');
      await new Promise(s => setTimeout(s, 8));
    }
    res.write('data: ' + JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP', index: 0 }],
      usageMetadata: out.usageMetadata,
      modelVersion: model,
    }) + '\n\n');
    return res.end();
  }
  return sendJson(res, 200, out, hdr);
}

// ---------------- admin ----------------
function handleAdmin(req, res, urlPath, urlObj) {
  const ip = clientIp(req);
  const local = isLoopback(ip);
  if (!local) {
    if (!authorized(req, urlObj || new URL('http://x'))) {
      return sendJson(res, 401, { error: 'admin butuh API key (Authorization: Bearer …)' });
    }
  }

  if (urlPath === '/admin/ui') {
    const p = path.join(DIR, 'dashboard.html');
    if (!fs.existsSync(p)) return sendJson(res, 404, { error: 'dashboard.html tidak ada' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(p));
  }

  if (urlPath === '/admin/state' && req.method === 'GET') {
    return sendJson(res, 200, {
      port: PORT, version: '1.1.1', agy: agy.AGY,
      config: { rotation: config.rotation, defaultModel: config.defaultModel, cooldownMs: config.cooldownMs, maxAccountRetries: config.maxAccountRetries, apiKeySet: !!config.apiKey, listenHost: HOST, maxInflight: MAX_INFLIGHT },
      accounts: { summary: accounts.summary(), items: accounts.stats(), busy: accounts.busyCount() },
      egress: proxies.stats(),
      models: MODEL_CACHE,
      uptimeSec: Math.floor(process.uptime()),
      inflight, maxInflight: MAX_INFLIGHT, queued: waitQueue.length,
      recent: recentReqs.slice(0, 40),
      usage: usage.summarize(),
    });
  }
  if (urlPath === '/admin/accounts' && req.method === 'GET') {
    return sendJson(res, 200, { summary: accounts.summary(), items: accounts.stats() });
  }
  if (urlPath === '/admin/egress' && req.method === 'GET') {
    return sendJson(res, 200, proxies.stats());
  }
  if (urlPath === '/admin/quota' && req.method === 'GET') {
    return (async () => {
      const force = (new URL(req.url, 'http://x')).searchParams.get('force') === '1';
      const list = accounts.all();
      if (!force && quotaCache.data && quotaCache.data.items
          && quotaCache.data.items.length === list.length
          && (Date.now() - quotaCache.at) < QUOTA_TTL_MS) {
        return sendJson(res, 200, Object.assign({ cached: true, ageMs: Date.now() - quotaCache.at }, quotaCache.data));
      }
      const fetched = await quotaMod.fetchAll(list);
      const data = { items: fetched.items, total: fetched.items.length };
      quotaCache = { at: Date.now(), data };
      sendJson(res, 200, Object.assign({ cached: false, ageMs: 0, ok: true }, data));
    })();
  }
  if (urlPath === '/admin/recent' && req.method === 'GET') {
    return sendJson(res, 200, { items: recentReqs.slice(0, 50) });
  }
  if (urlPath === '/admin/config' && req.method === 'POST') {
    return readBody(req).then(b => {
      let o = {};
      try { o = JSON.parse(b || '{}'); } catch (e) { return sendJson(res, 400, { error: 'JSON tidak valid' }); }
      if (o.rotation === 'lru' || o.rotation === 'rotate') config.rotation = o.rotation;
      if (typeof o.defaultModel === 'string' && o.defaultModel) config.defaultModel = o.defaultModel;
      if (typeof o.cooldownMs === 'number' && o.cooldownMs >= 0) config.cooldownMs = o.cooldownMs;
      if (typeof o.maxAccountRetries === 'number' && o.maxAccountRetries >= 1) config.maxAccountRetries = o.maxAccountRetries;
      if (typeof o.listenHost === 'string' && o.listenHost) config.listenHost = o.listenHost;
      try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch (e) {}
      return sendJson(res, 200, { ok: true, config: { rotation: config.rotation, defaultModel: config.defaultModel, cooldownMs: config.cooldownMs, maxAccountRetries: config.maxAccountRetries } });
    });
  }
  if (urlPath === '/admin/playground' && req.method === 'POST') {
    return (async () => {
      let o = {};
      try { o = JSON.parse(await readBody(req) || '{}'); } catch (e) { return sendJson(res, 400, { error: 'JSON tidak valid' }); }
      const prompt = String(o.prompt || '').trim();
      if (!prompt) return sendJson(res, 400, { error: 'prompt wajib diisi' });
      const model = o.model || config.defaultModel;
      const r = await runWithRotation(prompt, { model, timeoutSec: 180, proto: 'ui' });
      return sendJson(res, r.ok ? 200 : (r.status || 502), r);
    })();
  }
  // ---- tambah / hapus akun ----
  if (urlPath === '/admin/accounts/add' && req.method === 'POST') {
    return readBody(req).then(b => {
      let o = {};
      try { o = JSON.parse(b || '{}'); } catch (e) { return sendJson(res, 400, { error: 'JSON tidak valid' }); }
      const r = accounts.addAccount(o);
      return sendJson(res, r.ok ? 200 : 400, r);
    });
  }
  if (urlPath === '/admin/accounts/login/start' && req.method === 'POST') {
    return readBody(req).then(b => {
      let o = {};
      try { o = JSON.parse(b || '{}'); } catch (e) { return sendJson(res, 400, { error: 'JSON tidak valid' }); }
      const label = String(o.label || '').trim();
      if (!label) return sendJson(res, 400, { error: 'label wajib diisi' });
      let acc = accounts.find(label);
      if (!acc) {
        const created = accounts.addAccount({ label, geminiDir: o.geminiDir, credTarget: o.credTarget });
        if (!created.ok) return sendJson(res, 400, created);
        acc = created.account;
      }
      const r = auth.startLogin({ label, home: acc.geminiDir });
      return sendJson(res, r.ok ? 200 : 400, r);
    });
  }
  if (urlPath === '/admin/accounts/login/complete' && req.method === 'POST') {
    return (async () => {
      let o = {};
      try { o = JSON.parse(await readBody(req) || '{}'); } catch (e) { return sendJson(res, 400, { error: 'JSON tidak valid' }); }
      const label = String(o.label || '').trim();
      if (!label) return sendJson(res, 400, { error: 'label wajib diisi' });
      const acc = accounts.find(label);
      const r = await auth.completeLogin({ label, code: o.code || o.url || o.redirect, home: acc && acc.geminiDir });
      if (r.ok && r.email) accounts.setEmail(label, r.email);
      if (r.ok && acc) accounts.setDisabled(label, false);
      return sendJson(res, r.ok ? 200 : 400, r);
    })();
  }
  if (urlPath === '/admin/accounts/remove' && req.method === 'POST') {
    return readBody(req).then(b => {
      let o = {};
      try { o = JSON.parse(b || '{}'); } catch (e) { return sendJson(res, 400, { error: 'JSON tidak valid' }); }
      const r = accounts.removeAccount(o.label);
      return sendJson(res, r.ok ? 200 : 404, r);
    });
  }

  if (urlPath === '/admin/accounts/reset' && req.method === 'POST') {
    const n = accounts.resetCooldowns();
    return sendJson(res, 200, { ok: true, reset: n });
  }
  if (urlPath === '/admin/accounts/reload' && req.method === 'POST') {
    accounts.load(); proxies.load();
    return sendJson(res, 200, { ok: true, accounts: accounts.all().length, proxies: proxies.stats().total });
  }
  if (urlPath === '/admin/accounts/probe' && req.method === 'POST') {
    return (async () => {
      const r = await accounts.probe({ concurrency: 3 });
      sendJson(res, 200, { ok: true, results: r });
    })();
  }
  if (urlPath === '/admin/egress/load' && req.method === 'POST') {
    proxies.load();
    return sendJson(res, 200, { ok: true, total: proxies.stats().total });
  }
  if (urlPath === '/admin/egress/reset' && req.method === 'POST') {
    return sendJson(res, 200, { ok: true, reset: proxies.reset() });
  }
  if (urlPath === '/admin/egress/check' && req.method === 'POST') {
    return (async () => {
      const r = await proxies.checkAll();
      sendJson(res, 200, { ok: true, ...r, stats: proxies.stats() });
    })();
  }

  // ---- tambah / hapus proxy ----
  if (urlPath === '/admin/egress/add' && req.method === 'POST') {
    return readBody(req).then(b => {
      let o;
      try { o = JSON.parse(b || '{}'); } catch (e) { return sendJson(res, 400, { error: 'JSON tidak valid' }); }
      // terima {line:"host:port:user:pass"} atau {host,port,user,pass}
      const input = o.line ? o.line : o;
      const r = proxies.addProxy(input);
      return sendJson(res, r.ok ? 200 : 400, r);
    });
  }
  if (urlPath === '/admin/egress/add-bulk' && req.method === 'POST') {
    return readBody(req).then(b => {
      let o = {};
      try { o = JSON.parse(b || '{}'); } catch (e) { return sendJson(res, 400, { error: 'JSON tidak valid' }); }
      const text = o.text || o.lines || o.list || '';
      const r = proxies.addMany(text);
      return sendJson(res, r.ok ? 200 : 400, r);
    });
  }
  if (urlPath === '/admin/egress/clear' && req.method === 'POST') {
    return sendJson(res, 200, proxies.clearAll());
  }
  if (urlPath === '/admin/egress/remove' && req.method === 'POST') {
    return readBody(req).then(b => {
      let o = {};
      try { o = JSON.parse(b || '{}'); } catch (e) { return sendJson(res, 400, { error: 'JSON tidak valid' }); }
      const target = (o.id !== undefined && o.id !== null && o.id !== '') ? o.id : o.host;
      if (target === undefined) return sendJson(res, 400, { error: 'id atau host wajib diisi' });
      const r = proxies.removeProxy(target);
      return sendJson(res, r.ok ? 200 : 404, r);
    });
  }
  if (urlPath === '/admin/egress/config' && req.method === 'POST') {
    return readBody(req).then(b => {
      let cfg = {};
      try { cfg = JSON.parse(b || '{}'); } catch (e) { return sendJson(res, 400, { error: 'JSON tidak valid' }); }
      proxies.setConfig(cfg);
      config.egress = proxies.getConfig();
      try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch (e) {}
      return sendJson(res, 200, { ok: true, egress: proxies.getConfig() });
    });
  }
  // disable/enable akun: /admin/accounts/{label}/disable
  let m = urlPath.match(/^\/admin\/accounts\/([^\/]+)\/(disable|enable)$/);
  if (m && req.method === 'POST') {
    const label = decodeURIComponent(m[1]);
    const okk = accounts.setDisabled(label, m[2] === 'disable');
    return sendJson(res, okk ? 200 : 404, okk ? { ok: true, label, disabled: m[2] === 'disable' } : { error: 'akun tidak ditemukan' });
  }
  return sendJson(res, 404, { error: 'admin endpoint tidak dikenal', path: urlPath });
}

// ---------------- router ----------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = u.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization,Content-Type,x-api-key,anthropic-version',
    });
    return res.end();
  }

  try {
    if (p === '/healthz') {
      return sendJson(res, 200, {
        ok: true, port: PORT, version: '1.1.1',
        accounts: accounts.summary(),
        egress: proxies.stats().alive + '/' + proxies.stats().total,
        inflight, queued: waitQueue.length, busy: accounts.busyCount(),
      });
    }

    if (p.startsWith('/admin')) return handleAdmin(req, res, p, u);

    // endpoint API butuh kunci
    if (!authorized(req, u)) {
      return sendJson(res, 401, { error: { message: 'api key tidak valid (Authorization: Bearer <kunci> atau x-api-key)' } });
    }

    if (p === '/v1/models' && req.method === 'GET') {
      return sendJson(res, 200, {
        object: 'list',
        data: MODEL_CACHE.map(m => ({ id: m.id, object: 'model', created: nowSec(), owned_by: 'antigravity' })),
      });
    }

    if (p === '/v1/chat/completions' && req.method === 'POST') {
      const body = await readBody(req);
      return await handleOpenAIChat(req, res, body);
    }

    if ((p === '/v1/messages' || p === '/v1/messages/count_tokens') && req.method === 'POST') {
      const body = await readBody(req);
      return await handleAnthropicMessages(req, res, body);
    }

    if (p === '/v1beta/models' && req.method === 'GET') {
      return sendJson(res, 200, {
        models: MODEL_CACHE.map(m => ({ name: 'models/' + m.id, displayName: m.label, supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] })),
      });
    }

    if (/\/v1beta\/models\/[^/]+:(streamGenerateContent|generateContent)$/.test(p) && req.method === 'POST') {
      const body = await readBody(req);
      return await handleGeminiGenerate(req, res, body, p.includes('streamGenerateContent'));
    }

    return sendJson(res, 404, { error: { message: 'endpoint tidak dikenal: ' + p } });
  } catch (e) {
    console.error('[server] error:', e);
    return sendJson(res, 500, { error: { message: String(e && e.message || e) } });
  }
});

// ---------------- boot ----------------
accounts.load();
if (!accounts.all().length) {
  // Akun default: pakai kredensial yang sedang login di Windows Credential Manager.
  accounts.all().push({
    label: 'primary',
    credTarget: 'gemini:antigravity',
    geminiDir: process.cwd(),
    disabled: false, cooldown_until: 0,
    requests: 0, errors: 0, tokens_in: 0, tokens_out: 0, last_used: 0,
    last_error: null, ok_count: 0, last_ms: 0,
  });
  accounts.save();
  console.log('[boot] accounts.json kosong -> dibuat akun default "primary"');
}

agy.fetchModels().then(list => { if (list && list.length) { MODEL_CACHE = list; console.log('[boot] model dimuat dari CLI:', list.length); } }).catch(() => {});

server.listen(PORT, HOST, () => {
  console.log('==================================================');
  console.log('  Antigravity proxy aktif  http://' + HOST + ':' + PORT);
  console.log('  API key   : ' + (config.apiKey || '(tanpa kunci)'));
  console.log('  Akun      : ' + accounts.summary().usable + '/' + accounts.summary().total + ' siap');
  console.log('  Egress    : ' + proxies.stats().alive + '/' + proxies.stats().total + ' proxy (mode ' + proxies.getConfig().mode + ', enabled=' + proxies.getConfig().enabled + ')');
  console.log('  Dashboard : http://' + (BIND_PUBLIC ? '<host>' : '127.0.0.1') + ':' + PORT + '/admin/ui');
  console.log('  Cred lock : ' + (SERIAL_CRED ? 'SERIAL (wincred aman)' : 'off (HOME isolasi / Linux)'));
  if (BIND_PUBLIC) console.log('  BIND      : 0.0.0.0 (VPS) — /admin remote butuh API key');
  console.log('==================================================');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error('PORT ' + PORT + ' sudah dipakai. Matikan proses lain atau set AGY_PROXY_PORT.');
  else console.error('[server]', e);
  process.exit(1);
});
