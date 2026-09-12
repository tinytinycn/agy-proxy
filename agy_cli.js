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
const readline = require('readline');
const path = require('path');
const fs = require('fs');

const AGY = process.env.AGY_BIN || (process.platform === 'win32' ? 'C:\\Users\\RYZEN\\AppData\\Local\\agy\\bin\\agy.exe' : 'agy');

function getPermissionMode(opts) {
  if (opts && opts.permissionMode) return opts.permissionMode;
  if (process.env.AGY_PERMISSION_MODE) return process.env.AGY_PERMISSION_MODE;
  try {
    const cfgPath = path.join(__dirname, 'config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (cfg.permissionMode) return cfg.permissionMode;
    }
  } catch (e) {}
  return 'skip';
}

// Daftar model yang tersedia (dari `agy models`)
const MODELS = [
  { id: 'gemini-3.8-flash-high',   label: 'Gemini 3.8 Flash (High)',     family: 'gemini' },
  { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)',   family: 'gemini' },
  { id: 'gemini-3.8-flash-low',    label: 'Gemini 3.8 Flash (Low)',      family: 'gemini' },
  { id: 'gemini-3.8-flash',        label: 'Gemini 3.8 Flash (Auto High)', family: 'gemini' },
  { id: 'gemini-3.7-flash-high',   label: 'Gemini 3.7 Flash (High)',     family: 'gemini' },
  { id: 'gemini-3.7-flash-medium', label: 'Gemini 3.7 Flash (Medium)',   family: 'gemini' },
  { id: 'gemini-3.7-flash-low',    label: 'Gemini 3.7 Flash (Low)',      family: 'gemini' },
  { id: 'gemini-3.7-flash',        label: 'Gemini 3.7 Flash (Auto High)', family: 'gemini' },
  { id: 'gemini-3.6-flash-high',   label: 'Gemini 3.6 Flash (High)',     family: 'gemini' },
  { id: 'gemini-3.6-flash-medium', label: 'Gemini 3.6 Flash (Medium)',   family: 'gemini' },
  { id: 'gemini-3.6-flash-low',    label: 'Gemini 3.6 Flash (Low)',      family: 'gemini' },
  { id: 'gemini-3.5-flash-high',   label: 'Gemini 3.5 Flash (High)',     family: 'gemini' },
  { id: 'gemini-3.5-flash-medium', label: 'Gemini 3.5 Flash (Medium)',   family: 'gemini' },
  { id: 'gemini-3.5-flash-low',    label: 'Gemini 3.5 Flash (Low)',      family: 'gemini' },
  { id: 'gemini-3.1-pro-high',     label: 'Gemini 3.1 Pro (High)',       family: 'gemini' },
  { id: 'gemini-3.1-pro-low',      label: 'Gemini 3.1 Pro (Low)',        family: 'gemini' },
  { id: 'gemini-3.1-pro',          label: 'Gemini 3.1 Pro (Auto High)',   family: 'gemini' },
  { id: 'claude-sonnet-4-6',       label: 'Claude Sonnet 4.6 (Thinking)', family: 'claude' },
  { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)',  family: 'claude' },
  { id: 'gpt-oss-120b-medium',     label: 'GPT-OSS 120B (Medium)',       family: 'gpt' },
];

function listModels() { return MODELS.slice(); }
function isValidModel(id) {
  if (!id) return false;
  return MODELS.some(m => m.id === id) || /^(gemini|claude|gpt)-/i.test(id);
}
function familyOf(id) { const m = MODELS.find(x => x.id === id); return m ? m.family : 'gemini'; }

// Bangun argumen CLI untuk satu giliran.
// opts: { model, cwd, effort, continue_: bool, timeoutSec }
function buildArgs(opts) {
  const a = [];
  let model = opts.model ? String(opts.model).trim() : '';
  let effort = opts.effort ? String(opts.effort).trim().toLowerCase() : '';

  if (model) {
    const mMatch = model.match(/^(.*?)-(high|medium|low)$/i);
    if (mMatch) {
      if (!effort) {
        model = mMatch[0];
      } else {
        model = mMatch[1];
      }
    } else if (!effort) {
      // 未带 -high/-medium/-low 后缀且未显式传入 effort 时，针对必须指定 effort 的模型自动补全 high
      if (/^gemini-3\./i.test(model) || /^gemini-2\./i.test(model) || model.includes('flash') || model.includes('pro')) {
        effort = 'high';
      }
    }
    a.push('--model', model);
  }
  if (effort) {
    a.push('--effort', effort);
  }

  // 权限控制：skip (默认全自动跳过确认) | accept-edits (允许改代码) | plan (只读规划模式)
  const permMode = getPermissionMode(opts);
  if (permMode === 'skip') {
    a.push('--dangerously-skip-permissions');
  } else if (permMode === 'accept-edits') {
    a.push('--mode', 'accept-edits');
  } else if (permMode === 'plan') {
    a.push('--mode', 'plan');
  }

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
  const proxy = opts.proxyUrl || env.HTTP_PROXY || env.HTTPS_PROXY || env.ALL_PROXY || env.http_proxy || env.https_proxy || env.all_proxy;
  if (proxy) {
    env.HTTP_PROXY = proxy;
    env.HTTPS_PROXY = proxy;
    env.http_proxy = proxy;
    env.https_proxy = proxy;
    env.ALL_PROXY = proxy;
    env.all_proxy = proxy;
    env.NO_PROXY = '127.0.0.1,localhost,::1';
    env.no_proxy = env.NO_PROXY;
  }
  return env;
}

// Filter tag <think>/<thought> dari stream teks biasa agar bisa dipisah ke thought event
class StreamTagFilter {
  constructor(emit) {
    this.emit = emit; // (type: 'thought'|'text', delta: string) => void
    this.mode = 'text'; // 'text' | 'thought'
    this.buffer = '';
  }

  push(type, chunk) {
    if (!chunk) return;
    if (type === 'thought') {
      this.flush();
      this.emit('thought', chunk);
      return;
    }
    this.buffer += chunk;
    this.process();
  }

  process() {
    const thinkOpen = '<think>';
    const thinkClose = '</think>';
    const thoughtOpen = '<thought>';
    const thoughtClose = '</thought>';

    while (this.buffer.length > 0) {
      if (this.mode === 'text') {
        const idx1 = this.buffer.indexOf(thinkOpen);
        const idx2 = this.buffer.indexOf(thoughtOpen);
        let tag = '';
        let minIdx = -1;

        if (idx1 !== -1 && (idx2 === -1 || idx1 < idx2)) {
          minIdx = idx1;
          tag = thinkOpen;
        } else if (idx2 !== -1) {
          minIdx = idx2;
          tag = thoughtOpen;
        }

        if (minIdx !== -1) {
          if (minIdx > 0) {
            this.emit('text', this.buffer.slice(0, minIdx));
          }
          this.buffer = this.buffer.slice(minIdx + tag.length);
          this.mode = 'thought';
        } else {
          let possiblePrefix = false;
          for (let len = Math.min(this.buffer.length, 9); len > 0; len--) {
            const tail = this.buffer.slice(-len);
            if (thinkOpen.startsWith(tail) || thoughtOpen.startsWith(tail)) {
              possiblePrefix = true;
              if (this.buffer.length > len) {
                this.emit('text', this.buffer.slice(0, this.buffer.length - len));
                this.buffer = tail;
              }
              break;
            }
          }
          if (!possiblePrefix) {
            this.emit('text', this.buffer);
            this.buffer = '';
          }
          break;
        }
      } else {
        const idx1 = this.buffer.indexOf(thinkClose);
        const idx2 = this.buffer.indexOf(thoughtClose);
        let tag = '';
        let minIdx = -1;

        if (idx1 !== -1 && (idx2 === -1 || idx1 < idx2)) {
          minIdx = idx1;
          tag = thinkClose;
        } else if (idx2 !== -1) {
          minIdx = idx2;
          tag = thoughtClose;
        }

        if (minIdx !== -1) {
          if (minIdx > 0) {
            this.emit('thought', this.buffer.slice(0, minIdx));
          }
          this.buffer = this.buffer.slice(minIdx + tag.length);
          this.mode = 'text';
          if (this.buffer.startsWith('\n')) {
            this.buffer = this.buffer.slice(1);
          }
        } else {
          let possiblePrefix = false;
          for (let len = Math.min(this.buffer.length, 10); len > 0; len--) {
            const tail = this.buffer.slice(-len);
            if (thinkClose.startsWith(tail) || thoughtClose.startsWith(tail)) {
              possiblePrefix = true;
              if (this.buffer.length > len) {
                this.emit('thought', this.buffer.slice(0, this.buffer.length - len));
                this.buffer = tail;
              }
              break;
            }
          }
          if (!possiblePrefix) {
            this.emit('thought', this.buffer);
            this.buffer = '';
          }
          break;
        }
      }
    }
  }

  flush() {
    if (this.buffer.length > 0) {
      this.emit(this.mode, this.buffer);
      this.buffer = '';
    }
  }
}

// Jalankan prompt dalam mode real streaming.
// onEvent: callback({ type: 'thought'|'text'|'usage'|'init'|'done', delta?: string, usage?: object, ... })
// Mengembalikan: { promise, abort: () => void }
function runStream(prompt, opts = {}, onEvent) {
  let killed = false;
  let child = null;
  const t0 = Date.now();
  const args = buildArgs({ continue_: false, ...opts });

  const promise = new Promise((resolve) => {
    try {
      child = spawn(AGY, args, {
        cwd: opts.cwd || opts.home || process.cwd(),
        env: childEnv(opts),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      const out = {
        ok: false, text: '', thoughtText: '', model: opts.model,
        conversationId: null, usage: null, durationMs: Date.now() - t0,
        raw: { err: 'spawn error: ' + err.message },
      };
      if (onEvent) onEvent({ type: 'done', ...out });
      return resolve(out);
    }

    let stderr = '';
    let conversationId = null;
    let result = null;
    let textBuf = '';
    let thoughtBuf = '';
    let latestUsage = null;
    let done = false;

    const filter = new StreamTagFilter((type, delta) => {
      if (!delta) return;
      if (type === 'thought') {
        thoughtBuf += delta;
      } else {
        textBuf += delta;
      }
      if (onEvent) {
        onEvent({ type, delta });
      }
    });

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try { child.kill('SIGKILL'); } catch (e) {}
        filter.flush();
        finish(false, 'timeout', null);
      }
    }, (opts.timeoutSec || 300) * 1000 + 20000);

    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    child.on('error', (e) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        filter.flush();
        finish(false, 'spawn error: ' + e.message, null);
      }
    });

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      const s = line.trim();
      if (!s || s[0] !== '{') return;
      let o;
      try { o = JSON.parse(s); } catch (e) { return; }

      if (o.conversation_id && !conversationId) conversationId = o.conversation_id;
      if (o.event === 'init') {
        if (o.conversation_id) conversationId = o.conversation_id;
        if (onEvent) onEvent({ type: 'init', conversationId });
      }

      if (o.event === 'step_update' && o.step_update) {
        const su = o.step_update;
        if (su.conversation_id && !conversationId) conversationId = su.conversation_id;
        if (su.usage) {
          latestUsage = su.usage;
          if (onEvent) onEvent({ type: 'usage', usage: su.usage });
        }

        const stepType = su.step_type || '';
        if (stepType === 'thought' || stepType === 'thinking') {
          const delta = su.text_delta || su.thought_delta || su.thought || su.thinking || '';
          if (delta) filter.push('thought', delta);
        } else if (stepType === 'agent_response' || stepType === 'response') {
          if (su.thought_delta) filter.push('thought', su.thought_delta);
          if (su.text_delta) filter.push('text', su.text_delta);
        } else if (stepType === 'tool' || stepType === 'tool_use' || stepType === 'tool_call') {
          const tName = su.tool_name || (su.tool_info && su.tool_info.name) || 'tool';
          if (su.state === 'ACTIVE') {
            let paramSummary = '';
            if (su.tool_info && su.tool_info.parameters) {
              try {
                paramSummary = Object.entries(su.tool_info.parameters)
                  .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
                  .join(', ');
              } catch (e) {}
            }
            filter.push('thought', `\n\n> ⚙️ [调用工具] **${tName}**${paramSummary ? ` \`(${paramSummary})\`` : ''} ...\n`);
          } else if (su.state === 'DONE') {
            const dur = su.duration_seconds ? ` (${su.duration_seconds.toFixed(2)}s)` : '';
            let outPreview = '';
            if (su.tool_info && su.tool_info.output) {
              const rawOut = String(su.tool_info.output).trim();
              if (rawOut) {
                outPreview = '\n```\n' + (rawOut.length > 240 ? rawOut.slice(0, 240) + '...' : rawOut) + '\n```\n';
              }
            }
            filter.push('thought', `> ↳ 完成${dur}${outPreview}\n`);
          }
        } else if (su.text_delta) {
          filter.push('text', su.text_delta);
        }
      }

      if (o.event === 'delta' && typeof o.delta === 'string') {
        filter.push('text', o.delta);
      }

      if (o.event === 'message' && o.message && typeof o.message.content === 'string' && o.message.role === 'assistant') {
        filter.push('text', o.message.content);
      }

      if (o.event === 'result') {
        result = o.result || null;
        if (result && result.usage) latestUsage = result.usage;
        if (result && result.conversation_id && !conversationId) conversationId = result.conversation_id;
      }
    });

    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      filter.flush();
      finish(code === 0, code !== 0 ? 'exit ' + code : null, code);
    });

    function finish(okFlag, err, code) {
      if (!okFlag && !result) {
        const out = {
          ok: false, text: textBuf, thoughtText: thoughtBuf, model: opts.model,
          conversationId, usage: latestUsage, durationMs: Date.now() - t0,
          raw: { err: err || ('exit ' + code), stderr: stderr.slice(-2000) },
        };
        if (onEvent) onEvent({ type: 'done', ...out });
        return resolve(out);
      }

      const r = result || {};
      if (r.status && r.status !== 'SUCCESS') {
        const out = {
          ok: false, text: r.response || textBuf, thoughtText: thoughtBuf, model: opts.model,
          conversationId: conversationId || r.conversation_id || null,
          usage: r.usage || latestUsage || null, durationMs: Date.now() - t0,
          raw: { err: r.error || r.status, stderr: stderr.slice(-1000) },
        };
        if (onEvent) onEvent({ type: 'done', ...out });
        return resolve(out);
      }

      let finalText = textBuf;
      let finalThought = thoughtBuf;
      if (!finalText && !finalThought && r.response) {
        const fallbackFilter = new StreamTagFilter((type, delta) => {
          if (type === 'thought') finalThought += delta;
          else finalText += delta;
        });
        fallbackFilter.push('text', r.response);
        fallbackFilter.flush();
      }

      const finalUsage = r.usage || latestUsage || null;
      const out = {
        ok: true,
        text: finalText,
        thoughtText: finalThought,
        model: opts.model,
        conversationId: conversationId || r.conversation_id || null,
        usage: finalUsage,
        durationMs: Date.now() - t0,
        raw: { stderr: stderr.slice(-500) },
      };
      if (onEvent) onEvent({ type: 'done', ...out });
      return resolve(out);
    }

    try {
      child.stdin.write(JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n');
      child.stdin.end();
    } catch (e) {
      if (!done) {
        done = true;
        clearTimeout(timer);
        finish(false, 'stdin write: ' + e.message, null);
      }
    }
  });

  function abort() {
    if (killed || !child) return;
    killed = true;
    try {
      if (process.platform === 'win32') {
        child.kill('SIGKILL');
      } else {
        child.kill('SIGTERM');
      }
    } catch (e) {}
  }

  return { promise, abort };
}

function runOnce(prompt, opts = {}) {
  const { promise } = runStream(prompt, opts);
  return promise;
}

// Parse NDJSON stdout -> { conversationId, result, fallbackText, thoughtText }
function parseStdout(raw) {
  let conversationId = null;
  let result = null;
  let fallbackText = '';
  let thoughtText = '';
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let o;
    try { o = JSON.parse(s); } catch (e) { continue; }
    if (o.conversation_id && !conversationId) conversationId = o.conversation_id;
    if (o.event === 'init' && o.conversation_id) conversationId = o.conversation_id;
    if (o.event === 'result') result = o.result || null;
    if (o.event === 'step_update' && o.step_update) {
      const su = o.step_update;
      const st = su.step_type || '';
      if (st === 'thought' || st === 'thinking') {
        thoughtText += (su.text_delta || su.thought_delta || su.thought || su.thinking || '');
      } else if (st === 'agent_response' || st === 'response') {
        if (su.thought_delta) thoughtText += su.thought_delta;
        if (su.text_delta) fallbackText += su.text_delta;
      } else if (st === 'tool' || st === 'tool_use' || st === 'tool_call') {
        const tName = su.tool_name || (su.tool_info && su.tool_info.name) || 'tool';
        if (su.state === 'ACTIVE') {
          thoughtText += `\n\n> ⚙️ [调用工具] **${tName}** ...\n`;
        } else if (su.state === 'DONE') {
          thoughtText += `> ↳ 完成\n`;
        }
      } else if (su.text_delta) {
        fallbackText += su.text_delta;
      }
    }
    if (o.event === 'message' && o.message && typeof o.message.content === 'string' && o.message.role === 'assistant') {
      fallbackText += o.message.content;
    }
    if (o.event === 'delta' && typeof o.delta === 'string') fallbackText += o.delta;
  }
  return { conversationId, result, fallbackText, thoughtText };
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

module.exports = { AGY, MODELS, listModels, isValidModel, familyOf, runOnce, runStream, StreamTagFilter, runSlash, fetchModels, parseStdout, childEnv };
