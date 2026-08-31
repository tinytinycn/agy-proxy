'use strict';
// Ambil /quota + /credits per akun (serial: wincred satu target).
const agy = require('./agy_cli.js');
const auth = require('./auth.js');

function stripAnsi(s) {
  return String(s || '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\r/g, '');
}

function parseQuota(raw) {
  const t = stripAnsi(raw);
  const out = {
    gemini5h: null, geminiWeek: null,
    other5h: null, otherWeek: null,
    raw: t.slice(0, 4000),
  };
  for (const line of t.split(/\n/)) {
    const l = line.trim();
    if (!l) continue;
    const m = l.match(/(Weekly|Five Hour) Limit Remaining\t(\d+(?:\.\d+)?)%/i);
    if (!m) continue;
    const val = Number(m[2]);
    const isWeek = /^week/i.test(m[1]);
    const isGemini = /gemini/i.test(l);
    if (isGemini) {
      if (isWeek) out.geminiWeek = val; else out.gemini5h = val;
    } else {
      if (isWeek) out.otherWeek = val; else out.other5h = val;
    }
  }
  return out;
}

function parseCredits(raw) {
  const t = stripAnsi(raw);
  let remaining = null;
  const m = t.match(/remaining[^0-9\n-]{0,24}(-?\d+(?:\.\d+)?)/i)
    || t.match(/credits?[^0-9\n-]{0,24}(-?\d+(?:\.\d+)?)/i)
    || t.match(/(-?\d+(?:\.\d+)?)\s*credits?/i);
  if (m) remaining = Number(m[1]);
  return { remaining, raw: t.slice(0, 2000) };
}

async function fetchOne(acct) {
  const t0 = Date.now();
  const home = acct.geminiDir;
  return auth.withCredLock(async () => {
    await auth.activateAccountToken(acct);
    const q = await agy.runSlash('/quota', { timeoutSec: 50, home, cwd: home });
    const c = await agy.runSlash('/credits', { timeoutSec: 50, home, cwd: home });
    const qp = parseQuota(q.text);
    const cp = parseCredits(c.text);
    const empty = !stripAnsi(q.text).trim() && !stripAnsi(c.text).trim();
    return {
      label: acct.label,
      email: acct.email || null,
      ok: !empty,
      ms: Date.now() - t0,
      credits: cp.remaining,
      gemini5h: qp.gemini5h,
      geminiWeek: qp.geminiWeek,
      other5h: qp.other5h,
      otherWeek: qp.otherWeek,
      quotaRaw: qp.raw,
      creditsRaw: cp.raw,
      error: empty ? ((q.stderr || c.stderr || 'kosong').slice(0, 200)) : null,
    };
  });
}

async function fetchAll(accountList) {
  const items = [];
  for (const acct of accountList) {
    try {
      items.push(await fetchOne(acct));
    } catch (e) {
      items.push({
        label: acct.label, email: acct.email || null, ok: false, ms: 0,
        credits: null, gemini5h: null, geminiWeek: null, other5h: null, otherWeek: null,
        quotaRaw: '', creditsRaw: '', error: String(e.message || e).slice(0, 200),
      });
    }
  }
  return { items };
}

module.exports = { fetchAll, fetchOne, parseQuota, parseCredits, stripAnsi };
