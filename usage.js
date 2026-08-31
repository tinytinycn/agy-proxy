'use strict';
// Persist request log (JSONL) and roll up 1d / 7d / 30d + per-model stats.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'usage.jsonl');
const DAY = 24 * 60 * 60 * 1000;
const KEEP_MS = 40 * DAY; // drop rows older than 40d on prune
let cache = { at: 0, data: null };

function append(entry) {
  const row = {
    t: entry.t || Date.now(),
    ok: !!entry.ok,
    account: entry.account || '',
    model: entry.model || '',
    egress: entry.egress || '',
    ms: entry.ms || 0,
    tokens_in: entry.tokens_in || 0,
    tokens_out: entry.tokens_out || 0,
    proto: entry.proto || '',
  };
  try { fs.appendFileSync(FILE, JSON.stringify(row) + '\n'); }
  catch (e) { console.error('[usage] append gagal:', e.message); }
  cache = { at: 0, data: null };
  return row;
}

function loadRows() {
  if (!fs.existsSync(FILE)) return [];
  const out = [];
  let raw;
  try { raw = fs.readFileSync(FILE, 'utf8'); }
  catch (e) { return []; }
  for (const line of raw.split(/\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (e) { /* skip */ }
  }
  return out;
}

function pruneIfNeeded(rows) {
  const cut = Date.now() - KEEP_MS;
  const kept = rows.filter(r => (r.t || 0) >= cut);
  if (kept.length === rows.length) return rows;
  try { fs.writeFileSync(FILE, kept.map(r => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : '')); }
  catch (e) { /* ignore */ }
  return kept;
}

function emptyBucket() {
  return { requests: 0, ok: 0, errors: 0, tokens_in: 0, tokens_out: 0, tokens: 0 };
}

function addTo(b, r) {
  b.requests++;
  if (r.ok) b.ok++; else b.errors++;
  b.tokens_in += r.tokens_in || 0;
  b.tokens_out += r.tokens_out || 0;
  b.tokens = b.tokens_in + b.tokens_out;
}

function summarize(force) {
  if (!force && cache.data && (Date.now() - cache.at) < 5000) return cache.data;
  let rows = pruneIfNeeded(loadRows());
  const now = Date.now();
  const windows = {
    d1: emptyBucket(),
    d7: emptyBucket(),
    d30: emptyBucket(),
    all: emptyBucket(),
  };
  const models = {};
  for (const r of rows) {
    const t = r.t || 0;
    addTo(windows.all, r);
    if (now - t <= DAY) addTo(windows.d1, r);
    if (now - t <= 7 * DAY) addTo(windows.d7, r);
    if (now - t <= 30 * DAY) addTo(windows.d30, r);
    const id = r.model || '(none)';
    if (!models[id]) models[id] = emptyBucket();
    addTo(models[id], r);
    models[id].last = t;
  }
  const modelList = Object.keys(models).map(id => Object.assign({ id }, models[id]))
    .sort((a, b) => b.requests - a.requests);
  const data = { windows, models: modelList, totalRows: rows.length };
  cache = { at: Date.now(), data };
  return data;
}

module.exports = { append, summarize, FILE };
