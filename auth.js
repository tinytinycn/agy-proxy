'use strict';
// Login Antigravity: buka URL Google (PKCE), tempel URL redirect / code, simpan token.
// Client id + secret diambil dari agy.exe v1.1.22 (public di binary).
// Token format wincred sama dengan yang dipakai agy: JSON
//   { token: {access_token, token_type, refresh_token, expiry}, auth_method: "consumer" }

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const DIR = __dirname;
const CRED_PS1 = path.join(DIR, 'cred.ps1');
const CRED_TARGET = 'gemini:antigravity';
const CRED_USER = 'antigravity';
const agyCli = require('./agy_cli.js');
const CLI_LOGIN_MS = 55000;

function loadClients() {
  const p = path.join(DIR, 'oauth-clients.json');
  if (fs.existsSync(p)) {
    try {
      const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(arr) && arr.length) return arr;
    } catch (e) { console.error('[auth] oauth-clients.json parse gagal:', e.message); }
  }
  const envId = process.env.AGY_OAUTH_CLIENT_ID;
  const envSec = process.env.AGY_OAUTH_CLIENT_SECRET;
  if (envId && envSec) return [{ id: envId, secret: envSec }];
  return [];
}
const CLIENTS = loadClients();
const REDIRECT = 'https://antigravity.google/oauth-callback';
const AUTH_EP = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_EP = 'https://oauth2.googleapis.com/token';
// Jangan minta auth/aicode: client ID publik agy tidak mendaftarkan scope itu.
// Google menolak dengan restricted_client / "Akses diblokir: Error Otorisasi".
const SCOPE = [
  'openid', 'email', 'profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/experimentsandconfigs',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ');

const pending = new Map(); // label -> {..., expires}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function postForm(urlStr, fields) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const body = new URLSearchParams(fields).toString();
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Accept': 'application/json',
      },
    }, (res) => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(d); } catch (e) { j = { raw: d.slice(0, 400) }; }
        resolve({ status: res.statusCode, json: j });
      });
    });
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(new Error('timeout')); });
    req.end(body);
  });
}

function getJson(urlStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'Accept': 'application/json' },
    }, (res) => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(d) }); }
        catch (e) { resolve({ status: res.statusCode, json: null, raw: d.slice(0, 200) }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

function tokenPath(home) {
  // CLI v1.1.22 Linux: ~/.gemini/antigravity-cli/antigravity-oauth-token
  return path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
}

function saveTokenFile(home, blobObj) {
  const p = tokenPath(home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(blobObj, null, 2), 'utf8');
  return p;
}

function loadTokenFile(home) {
  const p = tokenPath(home);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return null; }
}

function runPs(args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CRED_PS1, ...args,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { try { child.kill(); } catch (e) {} }, timeoutMs || 20000);
    child.stdout.on('data', d => { out += d.toString('utf8'); });
    child.stderr.on('data', d => { err += d.toString('utf8'); });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out, err });
    });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: '', err: e.message }); });
  });
}

async function writeWinCred(blobObj, target) {
  const tmp = path.join(DIR, '.cred-write-' + crypto.randomBytes(6).toString('hex') + '.json');
  fs.writeFileSync(tmp, JSON.stringify(blobObj), 'utf8');
  try {
    const r = await runPs(['-Action', 'write', '-Target', target || CRED_TARGET, '-User', CRED_USER, '-JsonPath', tmp], 20000);
    if (r.code !== 0 || !/^OK\b/m.test(r.out)) {
      return { ok: false, error: (r.out || r.err || 'CredWrite gagal').trim().slice(0, 300) };
    }
    return { ok: true };
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
}

async function readWinCred(target) {
  const r = await runPs(['-Action', 'read', '-Target', target || CRED_TARGET], 15000);
  if (r.code !== 0) return { ok: false, error: (r.out || r.err || 'CredRead gagal').trim().slice(0, 200) };
  try { return { ok: true, blob: JSON.parse(r.out) }; }
  catch (e) { return { ok: false, error: 'blob bukan JSON' }; }
}

function buildAuthUrl(client, { challenge, state }) {
  const q = new URLSearchParams({
    client_id: client.id,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  return AUTH_EP + '?' + q.toString();
}

function killPending(label) {
  const rec = pending.get(label);
  if (rec && rec.child) {
    try { rec.child.kill('SIGKILL'); } catch (e) { /* ignore */ }
  }
  pending.delete(label);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Login akun baru lewat CLI agy (PKCE + secret internal). Dashboard TIDAK
// menukar code sendiri — secret di oauth-clients.json tidak berpasangan.
function startLogin(opts) {
  return new Promise((resolve) => {
    const label = String((opts && opts.label) || '').trim();
    if (!label) return resolve({ ok: false, error: 'label wajib diisi' });
    const home = opts.home;
    if (!home) return resolve({ ok: false, error: 'home akun kosong' });
    killPending(label);
    try { fs.mkdirSync(home, { recursive: true }); } catch (e) { /* ignore */ }

    const cmd = agyCli.AGY + ' -p=ping --disable-slash-commands --print-timeout 8s';
    const child = spawn('script', ['-qefc', cmd, '/dev/null'], {
      cwd: home,
      env: agyCli.childEnv({ home }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const rec = {
      label, home, child, url: null, buf: '',
      created: Date.now(),
      expires: Date.now() + CLI_LOGIN_MS,
      closed: false,
    };
    pending.set(label, rec);

    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
      pending.delete(label);
      resolve({ ok: false, error });
    };

    const onData = (d) => {
      rec.buf += d.toString('utf8');
      const m = rec.buf.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s\r]+/);
      if (m && !settled) {
        settled = true;
        rec.url = m[0];
        rec.expires = Date.now() + CLI_LOGIN_MS;
        resolve({
          ok: true,
          label,
          url: rec.url,
          redirect: REDIRECT,
          expiresInSec: Math.floor(CLI_LOGIN_MS / 1000),
          hint: 'Buka link SEGERA, login Google, tempel URL redirect atau code, lalu Simpan. CLI agy timeout ~55 detik.',
        });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => fail('spawn agy: ' + e.message));
    child.on('close', () => {
      rec.closed = true;
      if (!settled) fail('agy login tertutup sebelum URL muncul. Coba buat link lagi.');
    });
    setTimeout(() => {
      if (!settled) fail('timeout menunggu URL login dari agy');
    }, 15000);
  });
}

function extractCode(pasted) {
  const s = String(pasted || '').trim();
  if (!s) return { error: 'kode / URL kosong' };
  // full URL
  try {
    if (/^https?:\/\//i.test(s) || s.includes('code=')) {
      const u = new URL(s.includes('://') ? s : 'https://antigravity.google/oauth-callback?' + s.replace(/^\?/, ''));
      const err = u.searchParams.get('error');
      if (err) return { error: 'oauth error: ' + err + ' ' + (u.searchParams.get('error_description') || '') };
      const code = u.searchParams.get('code');
      const state = u.searchParams.get('state');
      if (code) return { code, state };
    }
  } catch (e) { /* fall through */ }
  // bare code
  const m = s.match(/^[A-Za-z0-9._\-\/+=]+$/);
  if (m) return { code: s, state: null };
  return { error: 'tidak ketemu code= di input. Tempel URL lengkap hasil redirect.' };
}

function expiryIso(expiresInSec) {
  const d = new Date(Date.now() + (Number(expiresInSec) || 3600) * 1000);
  // format dekat blob asli: 2026-08-31T13:31:06.0401993+07:00
  const pad = (n, z) => String(n).padStart(z, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(off) / 60), 2);
  const om = pad(Math.abs(off) % 60, 2);
  const ms = String(d.getMilliseconds()).padStart(3, '0') + '0000';
  return d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2) +
    'T' + pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2) +
    '.' + ms + sign + oh + ':' + om;
}

function blobFromToken(tok) {
  return {
    token: {
      access_token: tok.access_token,
      token_type: tok.token_type || 'Bearer',
      refresh_token: tok.refresh_token || '',
      expiry: expiryIso(tok.expires_in),
    },
    auth_method: 'consumer',
  };
}

function emailFromIdToken(idToken) {
  if (!idToken) return null;
  try {
    const payload = idToken.split('.')[1];
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const o = JSON.parse(json);
    return o.email || o.sub || null;
  } catch (e) { return null; }
}

async function exchange(code, rec) {
  const attempts = [];
  // urutan: client sesi + secret, client sesi tanpa secret (PKCE public), client lain
  const list = [rec.client, ...CLIENTS.filter(c => c.id !== rec.client.id)];
  for (const client of list) {
    for (const useSecret of [true, false]) {
      const fields = {
        client_id: client.id,
        code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT,
        code_verifier: rec.verifier,
      };
      if (useSecret) fields.client_secret = client.secret;
      let r;
      try { r = await postForm(TOKEN_EP, fields); }
      catch (e) { attempts.push(client.id.slice(0, 12) + ' ' + (useSecret ? 'sec' : 'pkce') + ': ' + e.message); continue; }
      if (r.status === 200 && r.json && r.json.access_token) {
        return { ok: true, token: r.json, client };
      }
      const err = (r.json && (r.json.error_description || r.json.error)) || ('HTTP ' + r.status);
      attempts.push(client.id.slice(0, 12) + ' ' + (useSecret ? 'sec' : 'pkce') + ': ' + String(err).slice(0, 80));
    }
  }
  return { ok: false, error: 'gagal tukar code: ' + attempts.slice(0, 4).join(' | ') };
}

async function completeLogin(opts) {
  const label = String((opts && opts.label) || '').trim();
  const rec = pending.get(label);
  if (!rec || !rec.child) return { ok: false, error: 'sesi login tidak ada / kadaluarsa. Klik buat link lagi.' };
  if (rec.closed) {
    pending.delete(label);
    return { ok: false, error: 'proses agy sudah tertutup. Buat link baru, login, simpan dalam 50 detik.' };
  }
  if (Date.now() > rec.expires) {
    killPending(label);
    return { ok: false, error: 'sesi login kadaluarsa (~55 detik, batas CLI agy). Buat link baru.' };
  }
  const parsed = extractCode(opts.code);
  if (parsed.error) return { ok: false, error: parsed.error };

  const home = opts.home || rec.home;
  const child = rec.child;
  try { child.stdin.write(parsed.code + '\n'); } catch (e) {
    killPending(label);
    return { ok: false, error: 'gagal kirim code ke agy: ' + e.message };
  }
  try { child.stdin.end(); } catch (e) { /* ignore */ }

  const deadline = Math.max(3000, rec.expires - Date.now() + 8000);
  const t0 = Date.now();
  while (Date.now() - t0 < deadline) {
    if (fs.existsSync(tokenPath(home))) {
      let blob = null;
      try { blob = JSON.parse(fs.readFileSync(tokenPath(home), 'utf8')); } catch (e) { blob = null; }
      if (blob && blob.token && blob.token.access_token) {
        pending.delete(label);
        const email = blob.email || emailFromIdToken(blob.token && blob.token.id_token) || null;
        return {
          ok: true,
          label,
          email,
          hasRefresh: !!(blob.token && blob.token.refresh_token),
          credWritten: false,
          file: tokenPath(home),
        };
      }
    }
    if (rec.closed) break;
    await sleep(250);
  }
  const leftover = (rec.buf || '').slice(-400);
  killPending(label);
  if (/authentication failed|OAuth2 flow failed|invalid_grant|interrupted/i.test(leftover)) {
    return { ok: false, error: 'agy menolak code: ' + leftover.replace(/\s+/g, ' ').slice(0, 220) };
  }
  return { ok: false, error: 'agy tidak menulis token. Buat link baru, login, simpan lebih cepat. ' + leftover.replace(/\s+/g, ' ').slice(0, 160) };
}

function pendingInfo(label) {
  const rec = pending.get(label);
  if (!rec) return null;
  return { label, expiresInSec: Math.max(0, Math.ceil((rec.expires - Date.now()) / 1000)), url: rec.url || null };
}

let credLock = Promise.resolve();
function withCredLock(fn) {
  const run = credLock.then(fn, fn);
  credLock = run.then(() => {}, () => {});
  return run;
}

async function activateAccountToken(acct) {
  if (!acct || !acct.geminiDir) return { ok: true, skipped: true };
  const blob = loadTokenFile(acct.geminiDir);
  if (!blob || !blob.token || !blob.token.access_token) return { ok: true, skipped: true };
  return writeWinCred(blob, acct.credTarget || CRED_TARGET);
}

module.exports = {
  startLogin, completeLogin, pendingInfo, extractCode,
  writeWinCred, readWinCred, saveTokenFile, loadTokenFile, tokenPath,
  activateAccountToken, withCredLock, CRED_TARGET, REDIRECT, SCOPE,
};
