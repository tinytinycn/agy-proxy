'use strict';
// Multi-akun: rotasi round-robin, cooldown saat limit, statistik, health probe.
// Satu "akun" = satu identitas login Antigravity yang bisa dipakai bergantian.
//
// Cara kerja multi-akun di Antigravity:
//   Kredensial OAuth tersimpan di Windows Credential Manager (target "gemini:antigravity") —
//   SATU entri per user Windows. Untuk multi-akun, setiap akun punya direktori
//   GEMINI_DIR sendiri (env GEMINI_CLI_HOME / --gemini-dir), sehingga agy.exe
//   menyimpan & membaca kredensial terpisah per akun.
//   Field `credTarget` di accounts.json memetakan akun -> entri Credential Manager.

const fs = require('fs');
const path = require('path');
const agy = require('./agy_cli.js');
const auth = require('./auth.js');

const DIR = __dirname;
const FILE = path.join(DIR, 'accounts.json');

let accounts = [];
let cursor = 0;
const busy = new Set();

function load() {
  if (!fs.existsSync(FILE)) { accounts = []; return accounts; }
  try {
    accounts = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    console.error('[accounts] gagal parse accounts.json:', e.message);
    accounts = [];
  }
  for (const a of accounts) {
    a.requests = a.requests || 0;
    a.errors = a.errors || 0;
    a.tokens_in = a.tokens_in || 0;
    a.tokens_out = a.tokens_out || 0;
    a.cooldown_until = a.cooldown_until || 0;
    a.disabled = !!a.disabled;
    a.last_used = a.last_used || 0;
    a.last_error = a.last_error || null;
    a.ok_count = a.ok_count || 0;
    a.last_ms = a.last_ms || 0;
    a.email = a.email || null;
  }
  return accounts;
}

function save() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(accounts, null, 2));
    return true;
  } catch (e) {
    console.error('[accounts] gagal simpan:', e.message);
    return false;
  }
}

let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; save(); }, 400);
}

function all() { return accounts; }

function now() { return Date.now(); }

// Apakah akun bisa dipakai sekarang.
function usable(a) {
  if (!a || a.disabled) return false;
  if (a.cooldown_until && a.cooldown_until > now()) return false;
  return true;
}

function usableList() { return accounts.filter(usable); }

function isBusy(a) { return !!(a && busy.has(a.label)); }

// Ambil akun berikutnya yang tidak disabled/cooldown/sedang dipakai. Atomic di event-loop Node.
function acquireNext(mode) {
  if (mode === 'rotate') {
    if (!accounts.length) return null;
    for (let n = 0; n < accounts.length; n++) {
      const a = accounts[(cursor + n) % accounts.length];
      if (usable(a) && !busy.has(a.label)) {
        busy.add(a.label);
        cursor = (cursor + n + 1) % accounts.length;
        return a;
      }
    }
    return null;
  }
  const list = usableList().filter(a => !busy.has(a.label));
  if (!list.length) return null;
  list.sort((x, y) => (x.last_used || 0) - (y.last_used || 0));
  busy.add(list[0].label);
  return list[0];
}

function release(a) {
  if (a && a.label) busy.delete(a.label);
}

function busyCount() { return busy.size; }

// Round-robin LRU: akun paling lama tidak dipakai yang masih hidup.
function pick() {
  return acquireNext('lru');
}

// Untuk mode 'rotate' murni (abaikan last_used, lanjut pointer).
function pickRotate() {
  return acquireNext('rotate');
}

function markUsed(a) { if (a) a.last_used = now(); }

function markOk(a, usage, extra) {
  if (!a) return;
  a.requests = (a.requests || 0) + 1;
  a.ok_count = (a.ok_count || 0) + 1;
  a.last_error = null;
  if (usage) {
    a.tokens_in += usage.input_tokens || 0;
    a.tokens_out += usage.output_tokens || 0;
  }
  if (extra && typeof extra.durationMs === 'number') a.last_ms = extra.durationMs;
  markUsed(a);
  saveSoon();
}

function markError(a, err, cooldownMs) {
  if (!a) return;
  a.requests = (a.requests || 0) + 1;
  a.errors = (a.errors || 0) + 1;
  a.last_error = String(err).slice(0, 300);
  if (cooldownMs) a.cooldown_until = now() + cooldownMs;
  markUsed(a);
  saveSoon();
}

// Deteksi pesan error yang berarti "akun ini habis" -> cooldown panjang.
function isQuotaError(msg) {
  const s = String(msg || '').toLowerCase();
  return s.includes('quota') || s.includes('rate limit') || s.includes('429') ||
         s.includes('resource_exhausted') || s.includes('resource exhausted') ||
         s.includes('too many requests') || s.includes('terlalu banyak');
}

function isAuthError(msg) {
  const s = String(msg || '').toLowerCase();
  return s.includes('not logged in') || s.includes('unauthenticated') ||
         s.includes('401') || s.includes('credential') || s.includes('login');
}

function stats() {
  return accounts.map(a => ({
    label: a.label,
    credTarget: a.credTarget,
    geminiDir: a.geminiDir,
    disabled: a.disabled,
    cooling: !!(a.cooldown_until && a.cooldown_until > now()),
    cooldownSec: a.cooldown_until > now() ? Math.ceil((a.cooldown_until - now()) / 1000) : 0,
    busy: busy.has(a.label),
    requests: a.requests,
    ok: a.ok_count,
    errors: a.errors,
    tokens_in: a.tokens_in,
    tokens_out: a.tokens_out,
    last_used: a.last_used ? new Date(a.last_used).toISOString() : null,
    last_error: a.last_error,
    last_ms: a.last_ms || 0,
    email: a.email || null,
  }));
}

function summary() {
  return {
    total: accounts.length,
    usable: usableList().length,
    disabled: accounts.filter(a => a.disabled).length,
    cooling: accounts.filter(a => a.cooldown_until > now()).length,
    requests: accounts.reduce((s, a) => s + (a.requests || 0), 0),
    errors: accounts.reduce((s, a) => s + (a.errors || 0), 0),
    tokens_in: accounts.reduce((s, a) => s + (a.tokens_in || 0), 0),
    tokens_out: accounts.reduce((s, a) => s + (a.tokens_out || 0), 0),
  };
}

// Buat direktori home untuk akun (isolasi state agy per akun).
function ensureHome(dir) {
  try {
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (e) {
    return false;
  }
}

// Tambah akun baru.
// opts: { label, geminiDir, credTarget }
// geminiDir = home terisolasi; agy akan menyimpan state & kredensial di <dir>/.gemini
function addAccount(opts) {
  const label = String((opts && opts.label) || '').trim();
  if (!label) return { ok: false, error: 'label wajib diisi' };
  if (accounts.some(a => a.label === label)) return { ok: false, error: 'label sudah dipakai: ' + label };

  const geminiDir = String((opts && opts.geminiDir) || '').trim() ||
    path.join(DIR, 'homes', label.replace(/[^a-z0-9._-]/gi, '_'));
  const credTarget = String((opts && opts.credTarget) || 'gemini:antigravity').trim();

  if (!ensureHome(geminiDir)) return { ok: false, error: 'gagal membuat direktori: ' + geminiDir };

  const acc = {
    label,
    credTarget,
    geminiDir,
    disabled: false,
    cooldown_until: 0,
    requests: 0,
    errors: 0,
    tokens_in: 0,
    tokens_out: 0,
    last_used: 0,
    last_error: null,
    ok_count: 0,
    last_ms: 0,
    email: null,
  };
  accounts.push(acc);
  save();
  return { ok: true, account: acc, total: accounts.length };
}

function find(label) {
  return accounts.find(a => a.label === label) || null;
}

function setEmail(label, email) {
  const a = find(label);
  if (!a) return false;
  a.email = email || null;
  save();
  return true;
}

// Hapus akun berdasarkan label.
function removeAccount(label) {
  const i = accounts.findIndex(a => a.label === label);
  if (i < 0) return { ok: false, error: 'akun tidak ditemukan: ' + label };
  const [gone] = accounts.splice(i, 1);
  save();
  return { ok: true, removed: gone.label, total: accounts.length };
}

function setDisabled(label, flag) {
  const a = accounts.find(x => x.label === label);
  if (!a) return false;
  a.disabled = !!flag;
  if (!flag) a.cooldown_until = 0;
  save();
  return true;
}

function resetCooldowns() {
  for (const a of accounts) a.cooldown_until = 0;
  save();
  return accounts.length;
}

// Health probe: jalankan prompt mini di tiap akun (bisa paralel).
async function probe(opts = {}) {
  const concurrency = opts.concurrency || 3;
  const prompt = opts.prompt || 'balas persis satu kata: OK';
  const model = opts.model || 'gemini-3.7-flash-low';
  const results = [];
  let i = 0;
  async function worker() {
    while (i < accounts.length) {
      const idx = i++;
      const a = accounts[idx];
      const t0 = Date.now();
      try {
        const run = () => agy.runOnce(prompt, {
          model,
          timeoutSec: opts.timeoutSec || 90,
          cwd: a.geminiDir || process.cwd(),
          home: a.geminiDir || undefined,
        });
        const r = (process.platform === 'win32')
          ? await auth.withCredLock(async () => { await auth.activateAccountToken(a); return run(); })
          : await run();
        const okk = r.ok && /ok/i.test(r.text.trim());
        results.push({ label: a.label, ok: okk, ms: Date.now() - t0, text: (r.text || '').trim().slice(0, 60), raw: r.ok ? null : r.raw });
        if (okk) markOk(a, r.usage); else markError(a, r.raw && r.raw.err || 'probe gagal');
      } catch (e) {
        results.push({ label: a.label, ok: false, ms: Date.now() - t0, text: '', raw: { err: e.message } });
        markError(a, e.message);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, accounts.length) }, worker));
  save();
  return results;
}

module.exports = {
  load, save, all, pick, pickRotate, usable, usableList,
  markOk, markError, markUsed, isQuotaError, isAuthError,
  stats, summary, setDisabled, resetCooldowns, probe, now, FILE,
  addAccount, removeAccount, ensureHome, find, setEmail,
  acquireNext, release, busyCount, isBusy,
};
