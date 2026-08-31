'use strict';
// Backend: menjalankan agy.exe dalam mode print / stream-json.
// Kontrak upstream (RE 2026-08-31, agy v1.1.22):
//   stdin  : {"event":"user","message":{"content":"<prompt>"}}
//   stdout : NDJSON; baris terakhir yang berguna: {"event":"result","result":{...}}
//   -p wajib pakai '=' : agy -p="teks"   (bukan -p "teks", karena flag berikutnya jadi prompt)
// Multi-giliran: agy --continue -p="..." (state tersimpan di ~/.gemini/antigravity-cli)
// NOTE: endpoint HTTP internal (daily-cloudcode-pa) menolak akses langsung dengan
//       403 SUBSCRIPTION_REQUIRED, jadi satu-satunya jalur yang terbukti 200 adalah CLI ini.

const { spawn } = require('child_process');
const path = require('path');

const AGY = process.env.AGY_BIN || 'C:\\Users\\RYZEN\\AppData\\Local\\agy\\bin\\agy.exe';

// Daftar model yang tersedia (dari `agy models`, v1.1.22)
const MODELS = [
  { id: 'gemini-3.7-flash-high',  label: 'Gemini 3.7 Flash (High)',   family: 'gemini' },
  { id: 'gemini-3.7-flash-medium', label: 'Gemini 3.7 Flash (Medium)', family: 'gemini' },
  { id: 'gemini-3.7-flash-low',   label: 'Gemini 3.7 Flash (Low)',    family: 'gemini' },
  { id: 'gemini-3.6-flash-high',  label: 'Gemini 3.6 Flash (High)',   family: 'gemini' },
  { id: 'gemini-3.6-flash-medium', label: 'Gemini 3.6 Flash (Medium)', family: 'gemini' },
  { id: 'gemini-3.6-flash-low',   label: 'Gemini 3.6 Flash (Low)',    family: 'gemini' },
  { id: 'gemini-3.5-flash-high',  label: 'Gemini 3.5 Flash (High)',   family: 'gemini' },
  { id: 'gemini-3.5-flash-medium', label: 'Gemini 3.5 Flash (Medium)', family: 'gemini' },
  { id: 'gemini-3.5-flash-low',   label: 'Gemini 3.5 Flash (Low)',    family: 'gemini' },
  { id: 'gemini-3.1-pro-high',    label: 'Gemini 3.1 Pro (High)',     family: 'gemini' },
  { id: 'gemini-3.1-pro-low',     label: 'Gemini 3.1 Pro (Low)',      family: 'gemini' },
  { id: 'claude-sonnet-4-6',      label: 'Claude Sonnet 4.6 (Thinking)', family: 'claude' },
  { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)', family: 'claude' },
  { id: 'gpt-oss-120b-medium',    label: 'GPT-OSS 120B (Medium)',     family: 'gpt' },
];

function listModels() { return MODELS.slice(); }
function isValidModel(id) { return MODELS.some(m => m.id === id); }
function familyOf(id) { const m = MODELS.find(x => x.id === id); return m ? m.family : 'gemini'; }

// Bangun argumen CLI untuk satu giliran.
// opts: { model, cwd, effort, continue_: bool, timeoutSec }
function buildArgs(opts) {
  const a = [];
  if (opts.model) { a.push('--model', String(opts.model)); }
  if (opts.effort) { a.push('--effort', String(opts.effort)); }
  a.push('--disable-slash-commands');           // prompt dipakai literal, bukan perintah internal
  a.push('--output-format', 'stream-json');
  a.push('--input-format', 'stream-json');
  a.push('--print-timeout', (opts.timeoutSec || 300) + 's');
  if (opts.continue_) a.push('--continue');
  return a;
}

// Jalankan satu prompt, kembalikan teks akhir (non-streaming).
// Mengembalikan: { ok, text, model, conversationId, usage, durationMs, raw }
// Isolasi home per akun + egress HTTP_PROXY untuk child agy.exe.
// USERPROFILE/HOME: agy menulis ~/.gemini/antigravity-cli (cwd saja TIDAK cukup).
function childEnv(opts) {
  const env = Object.assign({}, process.env, opts.env || {});
  if (opts.home) {
    env.USERPROFILE = opts.home;
    env.HOME = opts.home;
    try {
      const pathMod = require('path');
      const parsed = pathMod.parse(opts.home);
      if (parsed.root) {
        env.HOMEDRIVE = parsed.root.replace(/[\\/]+$/, '') || parsed.root;
        env.HOMEPATH = opts.home.slice(env.HOMEDRIVE.length) || '\\';
      }
    } catch (e) { /* ignore */ }
  }
  if (opts.proxyUrl) {
    env.HTTP_PROXY = opts.proxyUrl;
    env.HTTPS_PROXY = opts.proxyUrl;
    env.http_proxy = opts.proxyUrl;
    env.https_proxy = opts.proxyUrl;
    env.ALL_PROXY = opts.proxyUrl;
    env.all_proxy = opts.proxyUrl;
    env.NO_PROXY = '127.0.0.1,localhost,::1';
    env.no_proxy = env.NO_PROXY;
  }
  return env;
}

function runOnce(prompt, opts = {}) {
  return new Promise((resolve) => {
    const args = buildArgs({ continue_: false, ...opts });
    const t0 = Date.now();
    const child = spawn(AGY, args, {
      cwd: opts.cwd || opts.home || process.cwd(),
      env: childEnv(opts),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let done = false;

    const timer = setTimeout(() => {
      if (!done) { done = true; try { child.kill('SIGKILL'); } catch (e) {} finish(false, 'timeout', null); }
    }, (opts.timeoutSec || 300) * 1000 + 20000);

    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    child.on('error', (e) => {
      if (!done) { done = true; clearTimeout(timer); finish(false, 'spawn error: ' + e.message, null); }
    });

    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      finish(code === 0, code !== 0 ? 'exit ' + code : null, code);
    });

    function finish(okFlag, err, code) {
      const parsed = parseStdout(stdout);
      if (!okFlag && !parsed.result) {
        return resolve({
          ok: false, text: '', model: opts.model, conversationId: parsed.conversationId,
          usage: null, durationMs: Date.now() - t0,
          raw: { err: err || ('exit ' + code), stderr: stderr.slice(-2000), stdout: stdout.slice(-2000) },
        });
      }
      const r = parsed.result || {};
      if (r.status && r.status !== 'SUCCESS') {
        return resolve({
          ok: false, text: r.response || '', model: opts.model, conversationId: parsed.conversationId,
          usage: r.usage || null, durationMs: Date.now() - t0,
          raw: { err: r.error || r.status, stderr: stderr.slice(-1000) },
        });
      }
      resolve({
        ok: true,
        text: r.response || parsed.fallbackText || '',
        model: opts.model,
        conversationId: parsed.conversationId || r.conversation_id || null,
        usage: r.usage || null,
        durationMs: Date.now() - t0,
        raw: { stderr: stderr.slice(-500) },
      });
    }

    // tulis prompt ke stdin lalu tutup
    try {
      child.stdin.write(JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n');
      child.stdin.end();
    } catch (e) {
      if (!done) { done = true; clearTimeout(timer); finish(false, 'stdin write: ' + e.message, null); }
    }
  });
}

// Parse NDJSON stdout -> { conversationId, result, fallbackText }
function parseStdout(raw) {
  let conversationId = null;
  let result = null;
  let fallbackText = '';
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let o;
    try { o = JSON.parse(s); } catch (e) { continue; }
    if (o.conversation_id && !conversationId) conversationId = o.conversation_id;
    if (o.event === 'init' && o.conversation_id) conversationId = o.conversation_id;
    if (o.event === 'result') result = o.result || null;
    // beberapa build mengirim potongan teks sebelum result
    if (o.event === 'message' && o.message && typeof o.message.content === 'string' && o.message.role === 'assistant') {
      fallbackText += o.message.content;
    }
    if (o.event === 'delta' && typeof o.delta === 'string') fallbackText += o.delta;
  }
  return { conversationId, result, fallbackText };
}

// Ambil info quota/credit lewat slash command internal.
// agy mengekspansi perintah ini saat print mode biasa (tanpa --disable-slash-commands).
function runSlash(cmd, opts = {}) {
  return new Promise((resolve) => {
    const args = [];
    if (opts.model) args.push('--model', String(opts.model));
    args.push('-p=' + cmd);
    args.push('--print-timeout', (opts.timeoutSec || 90) + 's');
    const t0 = Date.now();
    const child = spawn(AGY, args, {
      cwd: opts.cwd || opts.home || process.cwd(),
      env: childEnv(opts),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, (opts.timeoutSec || 90) * 1000 + 10000);
    child.stdout.on('data', d => { out += d.toString('utf8'); });
    child.stderr.on('data', d => { err += d.toString('utf8'); });
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ ok: true, text: out.trim(), durationMs: Date.now() - t0, stderr: err.slice(-300) });
    });
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, text: '', durationMs: Date.now() - t0, stderr: String(e.message) }); });
  });
}

// Ambil daftar model langsung dari CLI (lebih akurat dari konstanta).
function fetchModels(opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(AGY, ['models'], {
      cwd: opts.cwd || opts.home || process.cwd(),
      env: childEnv(opts),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, 60000);
    child.stdout.on('data', d => { out += d.toString('utf8'); });
    child.on('close', () => {
      clearTimeout(timer);
      const rows = [];
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^([a-z0-9.\-]+)\t(.+)$/i);
        if (m) rows.push({ id: m[1], label: m[2].trim() });
      }
      resolve(rows.length ? rows : MODELS.map(x => ({ id: x.id, label: x.label })));
    });
    child.on('error', () => { clearTimeout(timer); resolve(MODELS.map(x => ({ id: x.id, label: x.label }))); });
  });
}

module.exports = { AGY, MODELS, listModels, isValidModel, familyOf, runOnce, runSlash, fetchModels, parseStdout, childEnv };
