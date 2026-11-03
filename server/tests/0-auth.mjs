/**
 * SessionHistoryServer functional tests — 0. the auth layer
 *
 * The entityKey contract: POST /login mints a key for any claimed entity id
 * (presenting the master password from the server's config.json), and every
 * request under /session must present one — HTTP and websocket upgrades
 * alike, on any of the four transports (Authorization Bearer, X-Entity-Key,
 * ?entityKey=, the entityKey cookie). A missing, unknown, expired or
 * foreign-entity key is rejected (401/403) before anything else runs —
 * before session existence is even considered.
 *
 * The tests against the main server need its master password (see the
 * helpers' getMasterPassword: SHS_MASTER_PASSWORD or the repo root's
 * config.json); the expiry test spawns its own short-lived server.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import {
  BASE_URL, WS_BASE, createSession, login, randomEntity, requireMasterPassword,
  sleep, spawnServer,
} from './helpers.mjs';

/**
 * Attempt a websocket upgrade and report how the server answered: the HTTP
 * status of a refused handshake ({http: 401|403|...}) or that it succeeded
 * ({open: true}) / closed afterwards ({code, reason}).
 */
function wsAttempt(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const done = (result) => { try { ws.terminate(); } catch { /* already gone */ } resolve(result); };
    ws.on('unexpected-response', (req, res) => done({ http: res.statusCode }));
    ws.on('open', () => done({ open: true }));
    ws.on('close', (code, reason) => done({ code, reason: reason.toString() }));
    ws.on('error', () => { setTimeout(() => done({ error: true }), 50); });
    setTimeout(() => done({ timeout: true }), 10000);
  });
}

describe('the auth layer (entityKeys on everything under /session)', () => {
  it('POST /login mints an entityKey for any claimed entity id (201)', async function () {
    const masterPassword = requireMasterPassword(this);
    const entity = randomEntity('auth');
    const response = await fetch(`${BASE_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity, masterPassword }),
    });
    assert.equal(response.status, 201);
    const info = await response.json();
    assert.match(info.entityKey, /^[A-Za-z0-9_-]{40,64}$/, 'the entityKey is a Base64url secret');
    assert.equal(info.entity, entity, 'the reply names the entity the key grants');
    assert.equal(info.source, 'pass', 'this login source is the master password');
    assert.ok(info.created > 0 && info.created <= Date.now(), 'a sane creation timestamp');
    assert.ok(info.expires > Date.now(), 'the key must not be born expired');
    assert.ok(info.expires - info.created >= 6 * 24 * 3600 * 1000,
      `tokens last about a week by default (got ${(info.expires - info.created) / 3600000}h)`);
  });

  it('rejects a wrong master password (401)', async function () {
    requireMasterPassword(this);
    const response = await fetch(`${BASE_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity: randomEntity('auth'), masterPassword: 'definitely-not-the-master-password' }),
    });
    assert.equal(response.status, 401);
    assert.match(await response.text(), /Invalid credentials/);
  });

  it('answers GET /login with 405 and a POST hint (browser/OpenID login is planned, not built yet)', async () => {
    const response = await fetch(`${BASE_URL}/login`);
    assert.equal(response.status, 405);
    assert.match(response.headers.get('Allow') || '', /POST/);
    assert.match(await response.text(), /POST/);
  });

  it('rejects unauthenticated /session requests with 401 (and says how to authenticate)', async function () {
    requireMasterPassword(this);
    for (const [pathname, method] of [
      ['/session', 'POST'],
      ['/session/00000000-0000-0000-0000-000000000000/media/whatever.mkv', 'GET'],
      ['/session/00000000-0000-0000-0000-000000000000/export?type=raw', 'GET'],
    ]) {
      const response = await fetch(BASE_URL + pathname, { method });
      assert.equal(response.status, 401, `${method} ${pathname} must demand an entityKey`);
      assert.match(response.headers.get('WWW-Authenticate') || '', /^Bearer/,
        `${pathname} must advertise Bearer authentication`);
      const body = await response.text();
      assert.match(body, /entityKey|\/login/, 'the rejection must say how to obtain a key');
    }
  });

  it('auth precedes session existence: an unknown session without a key is 401, not 404', async function () {
    requireMasterPassword(this);
    const response = await fetch(`${BASE_URL}/session/00000000-0000-0000-0000-000000000000/media/whatever.mkv`);
    assert.equal(response.status, 401,
      'the key check must run before the session lookup — the answer must not leak the session\'s existence');
  });

  it('accepts the entityKey on all four transports (Bearer, X-Entity-Key, query param, cookie)', async function () {
    const entity = randomEntity('transport');
    const key = await login(entity); // also caches the key for the helpers
    const probe = async (transport, url, headers) => {
      const response = await fetch(url, { method: 'GET', headers });
      // GET /session reaching the servlet (past the filter) answers 405
      assert.equal(response.status, 405,
        `a valid entityKey via ${transport} must reach the servlet, not be bounced by the auth filter`);
    };
    await probe('the Authorization Bearer header', `${BASE_URL}/session`, { Authorization: `Bearer ${key}` });
    await probe('the X-Entity-Key header', `${BASE_URL}/session`, { 'X-Entity-Key': key });
    await probe('the entityKey query parameter', `${BASE_URL}/session?entityKey=${encodeURIComponent(key)}`, {});
    await probe('the entityKey cookie', `${BASE_URL}/session`, { Cookie: `entityKey=${key}` });
  });

  it('rejects an unknown entityKey (401)', async function () {
    requireMasterPassword(this);
    const garbage = 'x'.repeat(43); // shaped like a key, backed by no token file
    const response = await fetch(`${BASE_URL}/session?entityKey=${garbage}`, { method: 'GET' });
    assert.equal(response.status, 401);
    assert.match(await response.text(), /Unknown entityKey/);
  });

  it('rejects a key granting a different entity than the request claims (403)', async function () {
    requireMasterPassword(this);
    const alice = randomEntity('alice');
    const mallory = randomEntity('mallory');
    const malloryKey = await login(mallory);
    // the create call claims its entity in the JSON body
    const response = await fetch(`${BASE_URL}/session?entityKey=${encodeURIComponent(malloryKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity: alice }),
    });
    assert.equal(response.status, 403);
    assert.match(await response.text(), new RegExp(`belongs to entity '${mallory}'`));
  });

  it('rejects websocket joins by their handshake: no key 401, foreign key 403, unknown key 401 — a matching key connects', async function () {
    requireMasterPassword(this);
    const sessionId = await createSession(randomEntity('auth-ws'));
    const alice = randomEntity('ws-alice');
    const aliceKey = await login(alice);
    const malloryKey = await login(randomEntity('ws-mallory'));
    const join = (key) =>
      `${WS_BASE}/session/${sessionId}/${encodeURIComponent(alice)}${key !== undefined ? `?entityKey=${encodeURIComponent(key)}` : ''}`;

    assert.equal((await wsAttempt(join())).http, 401, 'an unkeyed upgrade must be refused with 401');
    assert.equal((await wsAttempt(join(malloryKey))).http, 403, 'a key for another entity must be refused with 403');
    assert.equal((await wsAttempt(join('x'.repeat(43)))).http, 401, 'an unknown key must be refused with 401');
    assert.equal((await wsAttempt(join(aliceKey))).open, true, 'a key matching the claimed entity connects');
  });

  it('derives the export identity from the entityKey (a non-owner key gets 403, the owner hits the not-started check)', async function () {
    requireMasterPassword(this);
    const owner = randomEntity('export-owner');
    const ownerKey = await login(owner);
    const otherKey = await login(randomEntity('export-other'));
    const sessionId = await createSession(owner); // never started

    const ownerResponse = await fetch(`${BASE_URL}/session/${sessionId}/export?type=raw&entityKey=${encodeURIComponent(ownerKey)}`);
    assert.equal(ownerResponse.status, 409,
      'the owner passes the identity check and reaches the "session not started" refusal');

    const otherResponse = await fetch(`${BASE_URL}/session/${sessionId}/export?type=raw&entityKey=${encodeURIComponent(otherKey)}`);
    assert.equal(otherResponse.status, 403, 'an entityKey for a non-owner entity must not export');
    assert.match(await otherResponse.text(), /Must be owner/);
  });

  it('expired entityKeys are rejected (401) and their token file swept', async function () {
    this.timeout(120000);
    // a spawned server with a token lifetime of ~0.9s (0.00001 days)
    const server = await spawnServer({ tokenLifetimeDays: 0.00001 });
    if (server.unavailable) return this.skip(server.unavailable);
    try {
      const key = await login('expiry-probe', { baseUrl: server.url, password: server.masterPassword });

      // tokens are files under tokens/ holding exactly {entity, created, expires, source}
      const tokenFile = path.join(server.cwd, 'tokens', `${key}.json`);
      assert.ok(fs.existsSync(tokenFile), `the entityKey must live as a token file (${tokenFile})`);
      const token = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
      assert.deepEqual(Object.keys(token).sort(), ['created', 'entity', 'expires', 'source'],
        'the token file must hold exactly the documented shape');
      assert.equal(token.entity, 'expiry-probe');
      assert.equal(token.source, 'pass');
      assert.ok(Number.isFinite(token.created) && token.created > 0);
      assert.ok(token.expires > token.created);

      // A bare spec keeps this auth test independent of the application
      // asset; the owner is painted by the server from the key's entity.
      const create = (k) => fetch(`${server.url}/session?entityKey=${encodeURIComponent(k)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: { processors: [], models: [] } }),
      });
      assert.equal((await create(key)).status, 201, 'the key works within its lifetime');
      await sleep(1500); // past the ~0.9s lifetime
      const expired = await create(key);
      assert.equal(expired.status, 401, 'an expired key must be rejected');
      assert.match(await expired.text(), /expired/);
      assert.ok(!fs.existsSync(tokenFile), 'the rejected expired token file must be swept');
    } finally {
      await server.stop();
    }
  });
});
