'use strict';
// Egress HTTP proxy pool: round-robin / sticky / random per akun.
// Format file proxies.txt: host:port:user:pass  (satu per baris)
// Mendukung http:// dan https:// (CONNECT). Baris '#' = komentar.

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const FILE = path.join(DIR, 'proxies.txt');

let pool = [];          // [{ id, url, host, port, user, pass, ok, fails, lastErr, latencyMs, egressIp, lastChecked }]
let cursor = 0;         // round-robin pointer global
let config = { mode: 'rotate', enabled: true, failThreshold: 3 };

function load() {
  if (!fs.existsSync(FILE)) { pool = []; return pool; }
  const lines = fs.readFileSync(FILE, 'utf8').split(/\r?\n/);
  const out = [];
  let i = 0;
  for (let raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(':');
    if (parts.length < 2) continue;
    const host = parts[0];
    const port = parseInt(parts[1], 10);
    const user = parts.length > 2 ? parts[2] : '';
    const pass = parts.length > 3 ? parts.slice(3).join(':') : '';
    if (!host || !port) continue;
    const auth = user ? encodeURIComponent(user) + ':' + encodeURIComponent(pass) + '@' : '';
    out.push({
      id: i++,
      url: 'http://' + auth + host + ':' + port,
      host: host + ':' + port,
      user,
      pass,
      ok: true,
      fails: 0,
      lastErr: null,
      latencyMs: null,
      egressIp: null,
      lastChecked: 0,
    });
  }
  pool = out;
  return pool;
}

function setConfig(cfg) {
  if (!cfg) return config;
  if (typeof cfg.enabled === 'boolean') config.enabled = cfg.enabled;
  if (cfg.mode) config.mode = String(cfg.mode);
  if (cfg.failThreshold) config.failThreshold = parseInt(cfg.failThreshold, 10);
  return config;
}

function getConfig() { return config; }

function alive() { return pool.filter(p => p.ok); }

// Round-robin: ambil berikutnya yang hidup, lewati yang mati.
function next() {
  const list = alive();
  if (!list.length) return null;
  cursor = (cursor + 1) % pool.length;
  for (let n = 0; n < pool.length; n++) {
    const p = pool[(cursor + n) % pool.length];
    if (p.ok) { cursor = (cursor + n) % pool.length; return p; }
  }
  return null;
}

// Sticky: proxy tetap per identitas akun (hash stabil).
function sticky(key) {
  const list = alive();
  if (!list.length) return null;
  let h = 0;
  const s = String(key || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return list[h % list.length];
}

function random() {
  const list = alive();
  if (!list.length) return null;
  return list[Math.floor(Math.random() * list.length)];
}

// Ambil proxy untuk satu request.
// accountKey dipakai untuk mode sticky; kalau null pakai round-robin.
function pick(accountKey) {
  if (!config.enabled) return null;
  if (!pool.length) load();
  if (!pool.length) return null;
  switch (config.mode) {
    case 'sticky': return sticky(accountKey);
    case 'random': return random();
    case 'rotate':
    default: return next();
  }
}

function reportOk(p, latencyMs) {
  if (!p) return;
  p.fails = 0;
  p.lastErr = null;
  p.ok = true;
  if (typeof latencyMs === 'number') p.latencyMs = latencyMs;
}

function reportFail(p, err) {
  if (!p) return;
  p.fails = (p.fails || 0) + 1;
  p.lastErr = String(err && err.message || err);
  if (p.fails >= config.failThreshold) p.ok = false;
}

function reset() {
  for (const p of pool) { p.ok = true; p.fails = 0; p.lastErr = null; }
  return pool.length;
}

function stats() {
  return {
    total: pool.length,
    alive: alive().length,
    enabled: config.enabled,
    mode: config.mode,
    cursor,
    items: pool.map(p => ({
      id: p.id, host: p.host, ok: p.ok, fails: p.fails,
      lastErr: p.lastErr, latencyMs: p.latencyMs, egressIp: p.egressIp,
    })),
  };
}

// Probe semua proxy: siapa yang jalan dan IP egress-nya apa.
async function checkAll(timeoutMs = 12000) {
  let ProxyAgent, pfetch;
  try {
    ({ ProxyAgent, fetch: pfetch } = require('undici'));
  } catch (e) {
    return { ms: 0, alive: alive().length, total: pool.length, error: 'modul undici tidak terpasang: ' + e.message };
  }
  const t0all = Date.now();
  await Promise.all(pool.map(async (p) => {
    const t0 = Date.now();
    try {
      const agent = new ProxyAgent({ uri: p.url, bodyTimeout: 0, headersTimeout: timeoutMs });
      const r = await pfetch('https://api.ipify.org?format=json', { dispatcher: agent, signal: AbortSignal.timeout(timeoutMs) });
      const j = await r.json();
      p.egressIp = j.ip || null;
      p.latencyMs = Date.now() - t0;
      reportOk(p, p.latencyMs);
    } catch (e) {
      p.egressIp = null;
      p.latencyMs = null;
      reportFail(p, e);
    }
    p.lastChecked = Date.now();
  }));
  return { ms: Date.now() - t0all, alive: alive().length, total: pool.length };
}

// Simpan pool saat ini kembali ke proxies.txt (komentar diawali '#' tetap dipertahankan).
function persist() {
  const header = [
    '# Daftar proxy egress - satu per baris: host:port:user:pass',
    '# Baris diawali \'#\' diabaikan. Kosongkan user:pass bila proxy tanpa auth.',
    '# Mode: rotate (round robin) | sticky (per akun) | random',
    '',
  ].join('\n');
  const body = pool.map(p => {
    let line = p.host;                       // host:port
    if (p.user) line += ':' + p.user + ':' + (p.pass || '');
    return line;
  }).join('\n');
  const content = header + body + (body ? '\n' : '');
  try {
    fs.writeFileSync(FILE, content, 'utf8');
    return { ok: true, total: pool.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Tambah proxy ke pool (runtime + file).
// input: "host:port" | "host:port:user:pass"  atau objek {host,port,user,pass}
function addProxy(input) {
  let host, port, user = '', pass = '';

  if (typeof input === 'object' && input !== null) {
    host = String(input.host || '').trim();
    port = parseInt(input.port, 10);
    user = String(input.user || '').trim();
    pass = String(input.pass || '');
  } else {
    const raw = String(input || '').trim();
    // buang skema bila ada
    const clean = raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    // format host:port:user:pass — user/pass boleh mengandung ':' jadi ambil 4 bagian pertama
    const m = clean.match(/^([^:]+):(\d{1,5})(?::([^:]*))?(?::(.+))?$/);
    if (!m) return { ok: false, error: 'format tidak valid. Gunakan host:port atau host:port:user:pass -> ' + raw };
    host = m[1]; port = parseInt(m[2], 10);
    user = (m[3] || '').trim();
    pass = (m[4] || '');
  }

  if (!host) return { ok: false, error: 'host wajib diisi' };
  if (!port || port < 1 || port > 65535) return { ok: false, error: 'port tidak valid: ' + port };

  const key = host + ':' + port;
  if (pool.some(p => p.host === key)) return { ok: false, error: 'proxy sudah ada: ' + key };

  const auth = user ? encodeURIComponent(user) + ':' + encodeURIComponent(pass) + '@' : '';
  const item = {
    id: pool.length ? Math.max(...pool.map(p => p.id)) + 1 : 0,
    url: 'http://' + auth + host + ':' + port,
    host: key,
    user,
    pass,
    ok: true,
    fails: 0,
    lastErr: null,
    latencyMs: null,
    egressIp: null,
    lastChecked: 0,
  };
  pool.push(item);
  const saved = persist();
  return { ok: true, proxy: { id: item.id, host: item.host }, total: pool.length, persisted: saved.ok };
}

// Hapus proxy berdasarkan id atau "host:port".
function removeProxy(idOrHost) {
  const key = String(idOrHost);
  const idx = pool.findIndex(p => String(p.id) === key || p.host === key);
  if (idx < 0) return { ok: false, error: 'proxy tidak ditemukan: ' + key };
  const [gone] = pool.splice(idx, 1);
  // rapikan id supaya urut kembali
  pool.forEach((p, i) => { p.id = i; });
  if (cursor >= pool.length) cursor = 0;
  const saved = persist();
  return { ok: true, removed: gone.host, total: pool.length, persisted: saved.ok };
}

function splitProxyLines(text) {
  return String(text || '').split(/[\r\n,;]+/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
}

// Tambah banyak baris sekaligus. persist sekali di akhir.
function addMany(text) {
  const lines = splitProxyLines(text);
  if (!lines.length) return { ok: false, error: 'tidak ada baris proxy', added: 0, skipped: 0, errors: [] };
  const added = [];
  const skipped = [];
  const errors = [];
  for (const line of lines) {
    const r = addProxy(line);
    if (r.ok) added.push(r.proxy && r.proxy.host);
    else if (String(r.error || '').startsWith('proxy sudah ada')) skipped.push(line);
    else errors.push({ line, error: r.error });
  }
  return {
    ok: added.length > 0 || (skipped.length > 0 && errors.length === 0),
    added: added.length, skipped: skipped.length, errors,
    hosts: added, total: pool.length, persisted: true,
  };
}

function clearAll() {
  const n = pool.length;
  pool = [];
  cursor = 0;
  const saved = persist();
  return { ok: true, removed: n, total: 0, persisted: saved.ok };
}

module.exports = {
  load, setConfig, getConfig, pick, next, sticky, random, reportOk, reportFail,
  reset, stats, checkAll, alive, FILE, addProxy, removeProxy, persist,
  addMany, clearAll, splitProxyLines,
};
