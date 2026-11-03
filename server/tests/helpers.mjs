/**
 * SessionHistoryServer functional tests — shared helpers
 *
 * Tools for talking to a running SessionHistoryServer: HTTP requests, a raw
 * websocket client speaking the {op, cmd} protocol, server spawners for tests
 * that need their own instance (a second server on the same recordings, or
 * one expected to exit at startup on a bad sessions base dir), a
 * headless-browser helper (puppeteer + system Chromium), and a
 * tiny measurement collector that prints min/median/max at the end of the run.
 *
 * The server demands an entityKey on everything under /session: the helpers
 * read the master password (SHS_MASTER_PASSWORD or the repo root's
 * config.json), mint per-entity keys through POST /login, and transparently
 * key every /session request — spawned servers get their own generated
 * password in the config.json written next to them.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

export const BASE_URL = (process.env.SHS_URL || 'http://localhost:3001').replace(/\/+$/, '');
export const WS_BASE = BASE_URL.replace(/^http/, 'ws');
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Auth — the server demands an entityKey on everything under /session.
// The master password is read from SHS_MASTER_PASSWORD or the repo root's
// config.json; per-entity keys are minted through POST /login and cached
// per server, so every helper can transparently key its requests.
// ---------------------------------------------------------------------------

/** The master password of the server under test (env beats config.json), or null. */
export function getMasterPassword() {
  if (process.env.SHS_MASTER_PASSWORD) return process.env.SHS_MASTER_PASSWORD;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config.json'), 'utf8'));
    const password = config?.auth?.masterPassword;
    if (typeof password === 'string' && password.length > 0) return password;
  } catch { /* no config.json at the repo root */ }
  return null;
}

/**
 * Skip guard for tests that cannot run without a master password: call as
 * `requireMasterPassword(this)` at the top of the test — returns the
 * password or skips with an explanation of how to provide one.
 */
export function requireMasterPassword(test) {
  const password = getMasterPassword();
  if (!password) {
    test.skip('no master password — set auth.masterPassword in the repo root config.json (see tests/README.md) or export SHS_MASTER_PASSWORD');
  }
  return password;
}

/** entityKeys minted so far: `${serverBase}|${entity}` -> key (module cache). */
const entityKeys = new Map();
/** The most recently minted key per server (for requests that need *a* key). */
const lastKeyByServer = new Map();

/** Normalize any server base URL (http or ws, trailing slashes) for cache keys. */
function serverOf(baseUrl) {
  return (baseUrl || BASE_URL).replace(/^ws/, 'http').replace(/\/+$/, '');
}

/**
 * Log in as `entity` against the server (the main one by default, a spawned
 * one via baseUrl) and cache the entityKey. The password comes from the
 * options or the standard sources (getMasterPassword).
 * @returns {Promise<string>} The entityKey.
 */
export async function login(entity = 'tester', { password, baseUrl } = {}) {
  const server = serverOf(baseUrl);
  const masterPassword = password || getMasterPassword();
  if (!masterPassword) {
    throw new Error('no master password available — set auth.masterPassword in the repo root config.json (see tests/README.md) or export SHS_MASTER_PASSWORD');
  }
  const cacheKey = `${server}|${entity}`;
  if (entityKeys.has(cacheKey)) return entityKeys.get(cacheKey);
  const response = await fetch(`${server}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entity, masterPassword }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`login as "${entity}" failed (${response.status}): ${text.slice(0, 200)}`);
  const { entityKey } = JSON.parse(text);
  entityKeys.set(cacheKey, entityKey);
  lastKeyByServer.set(server, entityKey);
  return entityKey;
}

/** The cached entityKey for `entity` on a server, or null (does not log in). */
export function entityKeyFor(entity, { baseUrl } = {}) {
  return entityKeys.get(`${serverOf(baseUrl)}|${entity}`) || null;
}

/** Append an entityKey to a path as its query parameter. */
function withKey(pathname, key) {
  if (!key) return pathname;
  return pathname + (pathname.includes('?') ? '&' : '?') + 'entityKey=' + encodeURIComponent(key);
}

/** Whether a path is covered by the auth filter (it demands an entityKey). */
function needsKey(pathname) {
  return pathname === '/session' || pathname.startsWith('/session/');
}

// ---------------------------------------------------------------------------
// Measurements — "actually measuring things" per the brief. Record latencies
// anywhere; the summary prints once when the process exits.
// ---------------------------------------------------------------------------

const samples = new Map();

/** Record a measurement (latency by default; pass unit for counts/bytes). */
export function record(name, ms, unit = 'ms') {
  if (!samples.has(name)) samples.set(name, []);
  samples.get(name).push({ value: typeof ms === 'bigint' ? Number(ms) : ms, unit });
}

function statsOf(arr) {
  const sorted = [...arr.map((s) => s.value)].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
    max: sorted[sorted.length - 1],
  };
}

process.on('exit', () => {
  if (samples.size === 0) return;
  const rows = [...samples.entries()].map(([name, arr]) => {
    const s = statsOf(arr);
    const unit = arr[0].unit;
    return [
      name,
      `n=${s.n}`,
      `min=${s.min.toFixed(0)}${unit}`,
      `median=${s.median.toFixed(0)}${unit}`,
      `p95=${s.p95.toFixed(0)}${unit}`,
      `max=${s.max.toFixed(0)}${unit}`,
    ].join('  ');
  });
  console.log('\n\u2500\u2500\u2500 measurements \u2500\u2500\u2500');
  console.log(rows.join('\n'));
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * POST JSON. Under /session the request is keyed automatically when an
 * `entity` option names the entity to act as (its entityKey is minted/cached)
 * unless an explicit `entityKey` is passed — the create body no longer
 * carries an entity claim, so the key has to come from one of those two
 * options (or the request goes out unkeyed, for the 401 paths).
 */
export async function postJSON(pathname, body, { baseUrl, entityKey, entity } = {}) {
  let url = (baseUrl || BASE_URL) + pathname;
  if (needsKey(pathname) && !entityKey) {
    if (entity) url = withKey(url, entityKeyFor(entity, { baseUrl }) || await login(entity, { baseUrl }));
  } else if (entityKey) {
    url = withKey(url, entityKey);
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, ok: response.ok, text, json };
}

/**
 * GET a path. Under /session the request is keyed automatically (any cached
 * key, or a fresh login as "http-reader") unless an explicit `entityKey` is
 * passed; `entityKey: null` forces an unkeyed request (for the 401 tests).
 */
export async function getRaw(pathname, { abortAfterMs, baseUrl, entityKey } = {}) {
  const controller = new AbortController();
  const timer = abortAfterMs ? setTimeout(() => controller.abort(), abortAfterMs) : null;
  try {
    let url = (baseUrl || BASE_URL) + pathname;
    if (needsKey(pathname) && entityKey === undefined) {
      const server = serverOf(baseUrl);
      url = withKey(url, lastKeyByServer.get(server) || await login('http-reader', { baseUrl }));
    } else if (entityKey) {
      url = withKey(url, entityKey);
    }
    const response = await fetch(url, { signal: controller.signal });
    return response;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let cachedApplicationSpec = null;

/**
 * The application spec — the reference application's setup that the test
 * suite historically assumes (the application0 EventStreamProcessor with the
 * application.* vocabulary, the voice pipeline, the history model). Fetched
 * from the server under test, falling back to the repo's copy. Pass your own
 * `spec` to createSession to build bare or custom sessions instead.
 */
export async function applicationSpec({ baseUrl } = {}) {
  if (!cachedApplicationSpec) {
    cachedApplicationSpec = (async () => {
      try {
        const response = await fetch(`${serverOf(baseUrl)}/application-spec.json`);
        if (response.ok) return await response.json();
      } catch { /* fall through to the repo copy */ }
      return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'src/main/webapp/application-spec.json'), 'utf8'));
    })();
  }
  return cachedApplicationSpec;
}

/**
 * Create a fresh session owned by `entity` (the entityKey's entity — the
 * server paints the owner from the key); returns the session id. The session
 * is built from `spec` (defaulting to the application spec the suite's
 * assertions assume).
 */
export async function createSession(entity = 'tester', { baseUrl, password, spec } = {}) {
  const entityKey = entityKeyFor(entity, { baseUrl }) || await login(entity, { password, baseUrl });
  const body = { spec: spec ?? await applicationSpec({ baseUrl }) };
  const { ok, status, json, text } = await postJSON('/session', body, { baseUrl, entityKey });
  if (!ok) throw new Error(`POST /session failed (${status}): ${text.slice(0, 200)}`);
  return json.sessionId;
}

export function randomEntity(prefix = 'entity') {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Raw websocket client — speaks the server's {op, cmd} protocol
// ---------------------------------------------------------------------------

/**
 * Connect a websocket to /session/{sessionId}/{entityId}. The handshake is
 * keyed automatically: an entityKey for `entityId` is minted/cached (the
 * `password` option feeds servers spawned with their own config) unless an
 * explicit `entityKey` is passed (or `null` for the unkeyed 401 tests).
 * If the server refuses (e.g. unknown session), rejects with
 * { code, reason } from the close frame.
 */
export async function wsConnect(sessionId, entityId, { timeoutMs = 10000, baseUrl, entityKey, password } = {}) {
  let key = entityKey;
  if (key === undefined) {
    key = entityKeyFor(entityId, { baseUrl }) || await login(entityId, { password, baseUrl });
  }
  const socket = new TestSocket(sessionId, entityId, baseUrl, key);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.websocket.terminate();
      reject(new Error(`websocket connect timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.websocket.once('open', () => { clearTimeout(timer); resolve(); });
    socket.websocket.once('close', (code, reason) => {
      clearTimeout(timer);
      reject({ code, reason: reason?.toString() || '' });
    });
  });
  // The server closes *after* the HTTP upgrade for rejected sessions (e.g.
  // an unknown session id), so wait for either a first message (accepted) or
  // a close frame (refused) before handing the socket to the test.
  return await Promise.race([
    socket.awaitMsg(() => true, timeoutMs, 'first message').then(() => socket),
    new Promise((_, reject) => socket.websocket.once('close', (code, reason) => reject({ code, reason: reason?.toString() || '' }))),
  ]);
}

export class TestSocket {
  constructor(sessionId, entityId, baseUrl, entityKey) {
    this.sessionId = sessionId;
    this.entityId = entityId;
    this.entityKey = entityKey ?? null;
    this.messages = [];              // every parsed message, capped
    this.waiters = [];               // {pred, resolve, reject, timer, desc}
    this.everyHooks = [];            // (msg) => void
    this.opCounter = 0;
    this.pending = new Map();        // op -> {resolve, timer}
    this.closedInfo = null;

    // The websocket handshake cannot send headers — the entityKey rides as
    // its query parameter (the same transport session.js uses).
    this.websocket = new WebSocket(`${baseUrl || WS_BASE}/session/${sessionId}/${entityId}`
      + (this.entityKey ? `?entityKey=${encodeURIComponent(this.entityKey)}` : ''));
    this.websocket.on('message', (data) => this._handle(String(data)));
    this.websocket.on('close', (code, reason) => {
      this.closedInfo = { code, reason: reason?.toString() || '' };
      for (const w of [...this.waiters, ...(this._pendingWaiters())]) {
        clearTimeout(w.timer);
        (w.reject || (() => {}))(new Error(`websocket closed while waiting for ${w.desc} (${code}: ${this.closedInfo.reason})`));
      }
      this.waiters = [];
      for (const { reject } of this.pending.values()) reject(new Error(`websocket closed with op pending (${code})`));
      this.pending.clear();
    });
    this.websocket.on('error', () => { /* surfaced via close */ });
  }

  _pendingWaiters() { return []; }

  async _handle(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (this.messages.length < 500) this.messages.push(msg);
    for (const hook of [...this.everyHooks]) {
      try { hook(msg); } catch (e) { /* test hook errors must not kill the socket */ }
    }
    if (msg.cmd === 'return' && msg.op !== undefined && this.pending.has(msg.op)) {
      const entry = this.pending.get(msg.op);
      this.pending.delete(msg.op);
      clearTimeout(entry.timer);
      entry.resolve(msg);
    }
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const waiter = this.waiters[i];
      if (waiter.pred(msg)) {
        this.waiters.splice(i, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      }
    }
  }

  /** Fire-and-forget send; assigns and returns the op counter. */
  send(obj) {
    obj.op = ++this.opCounter;
    this.websocket.send(JSON.stringify(obj));
    return obj.op;
  }

  /** Send a command and await its {cmd:"return", op} reply (status-agnostic). */
  request(obj, timeoutMs = 15000) {
    const op = this.send(obj);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(op);
        reject(new Error(`no reply to op ${op} (${obj.cmd}) within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(op, { resolve, timer });
    });
  }

  /** Await the next message matching pred (scans the recent log first). */
  awaitMsg(pred, timeoutMs = 15000, desc = 'message') {
    for (const msg of this.messages) {
      if (pred(msg)) return Promise.resolve(msg);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.resolve === resolve);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${desc}`));
      }, timeoutMs);
      this.waiters.push({ pred, resolve, reject, timer, desc });
    });
  }

  /** Subscribe to every incoming message (for collectors). */
  onEvery(hook) {
    this.everyHooks.push(hook);
    return () => { this.everyHooks = this.everyHooks.filter((h) => h !== hook); };
  }

  get isOpen() { return this.websocket.readyState === WebSocket.OPEN; }

  close() {
    this.websocket.close();
  }
}

/**
 * Observe events flowing through a model subscription on `socket`.
 * The socket must have (or will) connectModel("history"). Collects every
 * event seen in modelChange "add"/"update" arrays, optionally filtered by
 * a regexp (or array of regexps) on event.type.
 */
export function modelEvents(socket, { types, field = 'add' } = {}) {
  const regexps = types ? (Array.isArray(types) ? types : [types]).map((t) => new RegExp(t)) : null;
  const seen = [];
  const unhook = socket.onEvery((msg) => {
    if (msg.cmd !== 'modelChange' || !Array.isArray(msg[field])) return;
    for (const event of msg[field]) {
      if (!regexps || regexps.some((re) => re.test(event.type))) seen.push(event);
    }
  });
  return {
    seen,
    unhook,
    /** Poll `seen` until an event matches pred. */
    async waitFor(pred, timeoutMs = 15000, desc = 'model event') {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = seen.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`timed out waiting for ${desc}; seen so far: ${seen.map((e) => e.type + ':' + e.id).slice(-8).join(', ')}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Spawning extra server instances (a second server on the same recordings, a
// server expected to exit at startup, ...). Skipped with this.skip() when
// java/TEN VAD are unavailable (the expect-exit spawner needs only the jar).
// ---------------------------------------------------------------------------

function findJar() {
  const explicit = process.env.SHS_JAR;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const target = path.join(REPO_ROOT, 'target');
  if (!fs.existsSync(target)) return null;
  const jar = fs.readdirSync(target)
    .filter((f) => /^SessionHistoryServer-.*\.jar$/.test(f) && !f.startsWith('original-'))
    .map((f) => path.join(target, f))
    .sort()[0];
  return jar && fs.existsSync(jar) ? jar : null;
}

function findTenVad() {
  const candidates = (process.env.SHS_TEN_VAD ? [process.env.SHS_TEN_VAD] : []).concat(['/tmp/tenvad-arm64', '/usr/local/lib']);
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'libten_vad.so')) && fs.existsSync(path.join(dir, 'onnx_model'))) return dir;
    } catch { /* ignore */ }
  }
  return null;
}

/** Probe that a java executable is actually spawnable (spawners skip without it). */
function findJava() {
  return new Promise((resolve) => {
    const probe = spawn('java', ['-version'], { stdio: 'ignore' });
    probe.on('error', () => resolve(false));
    probe.on('exit', () => resolve(true));
    probe.on('close', () => resolve(true));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const port = srv.address().port; srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

/**
 * Spawn a second SessionHistoryServer on its own port, with its own
 * config.json (a generated master password, an optional short
 * tokenLifetimeDays for the expiry tests) in its working directory.
 * Options: { basePath } — value for -Dsession.basePath (must exist and be
 * writable: the server validates its sessions base directory at startup
 * and exits when it is missing — see spawnServerExpectExit for that path);
 * { tokenLifetimeDays } — auth.tokenLifetimeDays for the spawned config.
 * Resolves with { url, port, basePath, masterPassword, cwd, stop() } once
 * the server answers HTTP (any status — before login it 401s, which is up).
 */
export async function spawnServer({ basePath, tokenLifetimeDays } = {}) {
  const jar = findJar();
  const tenVad = findTenVad();
  if (!jar || !tenVad) {
    const why = !jar ? 'server jar not built (run `mvn package`)' : 'TEN VAD library not found (set SHS_TEN_VAD)';
    return { unavailable: why };
  }
  if (!(await findJava())) return { unavailable: 'java not found on PATH' };
  const port = await freePort();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'shs-spawn-'));
  fs.symlinkSync(path.join(tenVad, 'onnx_model'), path.join(cwd, 'onnx_model'));
  const masterPassword = `shs-test-${crypto.randomBytes(16).toString('hex')}`;
  const auth = { masterPassword };
  if (tokenLifetimeDays !== undefined) auth.tokenLifetimeDays = tokenLifetimeDays;
  fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({ auth }, null, 2) + '\n');
  const args = [
    `-Djna.library.path=${tenVad}`,
    `-Djetty.port=${port}`,
  ];
  if (basePath) args.push(`-Dsession.basePath=${basePath}`);
  else fs.mkdirSync(path.join(cwd, 'sessions')); // the server validates the base dir at startup
  args.push('-jar', jar);
  const child = spawn('java', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', () => {});   // spawn failures surface via the 90s timeout below
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const url = `http://127.0.0.1:${port}`;

  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`spawned server exited (${child.exitCode}):\n${log.slice(-2000)}`);
    try {
      // any HTTP answer means the server is up — unauthenticated it 401s,
      // which is exactly what "the auth layer is in place" looks like.
      const resp = await fetch(`${url}/session`, { method: 'GET' }).catch(() => null);
      if (resp) return {
        url,
        port,
        basePath,
        masterPassword,
        cwd,
        log: () => log,
        stop: () => new Promise((resolve) => {
          if (child.exitCode !== null) return resolve();
          child.on('exit', () => resolve());
          child.kill();
          setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
        }),
      };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill('SIGKILL');
  throw new Error(`spawned server did not come up in 90s:\n${log.slice(-2000)}`);
}

/**
 * Spawn a SessionHistoryServer that is expected to exit at startup —
 * for example with a sessions base directory that does not exist or is
 * not writable — and resolve once it has. Only needs the jar (not the
 * TEN VAD library or a working GStreamer): the sessions-base-directory
 * check runs before any native self-test.
 * Options: { basePath, timeoutMs } — basePath is passed as
 * -Dsession.basePath; timeoutMs bounds the wait for the exit (default
 * 30s, after which the child is killed and the promise rejects with
 * the log).
 * Resolves with { exitCode, log } — or { unavailable } when no jar is built
 * or java is not on PATH.
 */
export async function spawnServerExpectExit({ basePath, timeoutMs = 30000 } = {}) {
  const jar = findJar();
  if (!jar) return { unavailable: 'server jar not built (run `mvn package`)' };
  if (!(await findJava())) return { unavailable: 'java not found on PATH' };
  const port = await freePort();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'shs-spawn-'));
  const args = [`-Djetty.port=${port}`];
  if (basePath) args.push(`-Dsession.basePath=${basePath}`);
  args.push('-jar', jar);
  const child = spawn('java', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', () => {});   // spawn failures surface as the timeout rejection below
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`spawned server did not exit within ${timeoutMs}ms:\n${log.slice(-2000)}`));
    }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  return { exitCode, log: () => log };
}

// ---------------------------------------------------------------------------
// Headless browser (puppeteer + a system Chromium/Chrome)
// ---------------------------------------------------------------------------

function detectBrowser() {
  if (process.env.SHS_BROWSER) return process.env.SHS_BROWSER;
  const candidates = [
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable', '/snap/bin/chromium', '/opt/google/chrome/chrome',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

let browserPromise = null;

export async function getBrowser() {
  if (!browserPromise) {
    const { default: puppeteer } = await import('puppeteer-core');
    const executablePath = detectBrowser();
    if (!executablePath) {
      throw new Error('no Chromium/Chrome found — set SHS_BROWSER or install chromium (see tests/README.md)');
    }
    browserPromise = puppeteer.launch({
      executablePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--use-fake-ui-for-media-stream',   // auto-accept getUserMedia prompts
        '--use-fake-device-for-media-stream', // fake camera (green) + mic (tone) without hardware
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio',
      ],
    });
  }
  return browserPromise;
}

/**
 * Open a page on the server's origin — the demo page at /demo2.html, which
 * carries the bundled client library (a plain /session.js fetch is only a
 * same-origin fallback when the demo is absent, and it does NOT define
 * window.SessionHistory; callers needing the library must loadClientLibrary).
 * pageLogin relies on the demo page.
 */
export async function openPage() {
  const browser = await getBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  let response = await page.goto(BASE_URL + '/demo2.html', { waitUntil: 'domcontentloaded' });
  if (!response || response.status() >= 400) {
    await page.goto(BASE_URL + '/session.js', { waitUntil: 'domcontentloaded' });
  }
  return page;
}

/** Load the bundled client library (session.js) into a page; idempotent. */
export async function loadClientLibrary(page) {
  await page.evaluate(() => {
    if (window.SessionHistory) return;
    const script = document.createElement('script');
    script.src = new URL('session.js', window.location.href).href;
    document.head.appendChild(script);
    return new Promise((resolve, reject) => {
      script.onload = resolve;
      script.onerror = reject;
    });
  });
}

/**
 * Log in as `entity` inside the page, so a following page.evaluate can use
 * the bundled client library (its create/join/websocket/export URLs are
 * keyed by the remembered entityKey). The password comes from the options
 * or the standard sources (getMasterPassword).
 */
export async function pageLogin(page, entity, { password } = {}) {
  const masterPassword = password || getMasterPassword();
  if (!masterPassword) {
    throw new Error('no master password available — set auth.masterPassword in the repo root config.json (see tests/README.md) or export SHS_MASTER_PASSWORD');
  }
  const reply = await page.evaluate(async (entity, masterPassword) => {
    return await window.SessionHistory.login(entity, masterPassword);
  }, entity, masterPassword);
  if (!reply?.entityKey) throw new Error('pageLogin got no entityKey from the library');
  return reply;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Standard config used by the script-processor tests/demo. */
export function scriptProcessorConfig({ name, script, inputs = {}, outputs, schemas }) {
  return { cmd: 'addProcessor', name, type: 'ScriptProcessor', config: { language: 'js', script, inputs, outputs, schemas, emitExceptionEvents: true } };
}
