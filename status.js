'use strict';
// Tampilkan status proxy secara ringkas: node status.js
const BASE = process.env.AGY_PROXY_URL || 'http://127.0.0.1:1413';

function pad(s, n) { s = String(s == null ? '' : s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }

async function main() {
  let s;
  try {
    const r = await fetch(BASE + '/admin/state');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    s = await r.json();
  } catch (e) {
    console.error('Tidak bisa menghubungi ' + BASE + ' — ' + e.message);
    console.error('Jalankan dulu: node server.js');
    process.exit(1);
  }

  const A = s.accounts.summary, E = s.egress;
  console.log('Antigravity proxy  ' + BASE + '   uptime ' + s.uptimeSec + 's');
  console.log('='.repeat(76));
  console.log('Akun siap : ' + A.usable + '/' + A.total +
              '   request ' + A.requests + '   error ' + A.errors +
              '   cooldown ' + A.cooling + '   disabled ' + A.disabled);
  console.log('Token     : in ' + A.tokens_in + '  out ' + A.tokens_out);
  console.log('Egress    : ' + E.alive + '/' + E.total + ' proxy  mode=' + E.mode + '  enabled=' + E.enabled);
  console.log('Model     : ' + s.models.length);
  console.log('');
  console.log(pad('LABEL', 16) + pad('STATUS', 12) + pad('REQ', 7) + pad('OK', 6) +
              pad('ERR', 6) + pad('TOKEN IN', 11) + pad('OUT', 9) + 'TERAKHIR');
  console.log('-'.repeat(76));
  for (const a of s.accounts.items) {
    const st = a.disabled ? 'disabled' : a.cooling ? 'cooldown ' + a.cooldownSec + 's' : 'siap';
    console.log(pad(a.label, 16) + pad(st, 12) + pad(a.requests, 7) + pad(a.ok, 6) +
                pad(a.errors, 6) + pad(a.tokens_in, 11) + pad(a.tokens_out, 9) +
                (a.last_used ? a.last_used.slice(11, 19) : '-'));
    if (a.last_error) console.log('    ! ' + a.last_error);
  }
  if (E.items && E.items.length) {
    console.log('');
    console.log(pad('#', 5) + pad('HOST', 26) + pad('STATUS', 9) + pad('FAILS', 7) + pad('LATENSI', 10) + 'IP EGRESS');
    console.log('-'.repeat(76));
    for (const p of E.items) {
      console.log(pad(p.id, 5) + pad(p.host, 26) + pad(p.ok ? 'ok' : 'mati', 9) +
                  pad(p.fails, 7) + pad(p.latencyMs != null ? p.latencyMs + 'ms' : '-', 10) + (p.egressIp || '-'));
    }
  }
}

main();
