/**
 * SessionHistoryServer functional tests — 1. sessions over HTTP
 *
 * Session creation, the bundled client library, HTTP error responses
 * (no stack traces should ever reach a client), path traversal, the dead
 * "ressources" category, and startup validation of the sessions base
 * directory (missing or unusable base — a clear error, not a later 500).
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { postJSON, getRaw, createSession, login, applicationSpec, spawnServerExpectExit } from './helpers.mjs';

describe('session management over HTTP', () => {
  it('creates a session and returns a JSON session id (201)', async () => {
    const { status, json } = await postJSON('/session', { spec: await applicationSpec() }, { entity: 'http-owner' });
    assert.equal(status, 201);
    assert.match(json.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('rejects a session without an owner entity with a client error', async () => {
    // A valid key for a helper entity: the auth filter must let this past
    // (its entity claim is fine — the body just has none) so the request
    // still exercises the servlet's missing-owner bug, not the 401s.
    const entityKey = await login('no-entity-probe');
    const { status, text } = await postJSON('/session', {}, { entityKey });
    assert.ok(status >= 400 && status < 500, `expected a 4xx, got ${status}`);
    assert.ok(!text.includes('at dk.cavi'), 'Java stack trace leaked to the client:\n' + text.slice(0, 400));
  });

  it('serves the bundled client library at /session.js', async () => {
    const response = await getRaw('/session.js');
    assert.ok(response.ok);
    const body = await response.text();
    assert.match(body, /class SessionHistory/);
  });

  it('answers a plain GET /session with 405 (session creation is a POST)', async () => {
    const response = await getRaw('/session');
    assert.equal(response.status, 405);
  });
});

describe('error responses must not leak server internals', () => {
  it('[known-bug: unknown sessions answer 500 + a stack trace instead of a clean 404] returns a clean 404 for an unknown session', async () => {
    const response = await getRaw('/session/00000000-0000-0000-0000-000000000000/media/whatever.mkv');
    assert.ok(response.status >= 400 && response.status < 500, `expected a 4xx, got ${response.status}`);
    const body = await response.text();
    assert.ok(!body.includes('at dk.cavi'), 'stack trace leaked to the client:\n' + body.slice(0, 400));
  });

  it('[known-bug: unknown resources answer 500 + a stack trace instead of a clean 404] returns a clean 404 for an unknown resource in an existing session', async () => {
    const sessionId = await createSession('error-probe');
    const response = await getRaw(`/session/${sessionId}/media/no-such-track.mkv`);
    assert.ok(response.status >= 400 && response.status < 500, `expected a 4xx, got ${response.status}`);
    const body = await response.text();
    assert.ok(!body.includes('at dk.cavi'), 'stack trace leaked to the client:\n' + body.slice(0, 400));
  });

  it('never serves files outside the session directory (path traversal)', async () => {
    const sessionId = await createSession('traversal-probe');
    for (const resource of ['..%2F..%2F..%2Fetc%2Fpasswd', '%2e%2e%2f%2e%2e%2fserver.log']) {
      const response = await getRaw(`/session/${sessionId}/media/${resource}`);
      assert.ok(!response.ok, `traversal attempt ${resource} unexpectedly succeeded`);
      const body = await response.text();
      assert.ok(!body.includes('root:'), `served file content from outside the session dir for ${resource}`);
    }
  });

  it('404s the dead "ressources" URL category (the README documents "media")', async () => {
    const sessionId = await createSession('category-probe');
    const response = await getRaw(`/session/${sessionId}/ressources/whatever`);
    assert.equal(response.status, 404);
    const body = await response.text();
    assert.match(body, /Unknown category/);
  });

  it('accepts the "media" URL category', async () => {
    const sessionId = await createSession('category-probe');
    const response = await getRaw(`/session/${sessionId}/media/whatever`);
    const body = await response.text();
    // The category must be served, not rejected: an unknown *file* is the
    // separate known bug above (the 500 + stack trace bug) — what must not
    // happen here is the "Unknown category" 404 the misspelled URL gets.
    assert.doesNotMatch(body, /Unknown category/,
      'the "media" category is served, not rejected');
  });
});

describe('startup validation of the sessions base directory', () => {
  // Replaces the old bootstrap test: the server now
  // validates its sessions base directory at startup (nothing in it ever
  // creates the top-level directory), and a fresh checkout gets the
  // directory from git via the tracked sessions/.keep file. These spawn
  // their own servers and need only a built jar — the check runs before
  // any native self-test, so no TEN VAD or GStreamer is required.

  it('refuses to start when the base directory does not exist (checkout without sessions/)', async function () {
    const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shs-fresh-')), 'sessions');
    const server = await spawnServerExpectExit({ basePath: missing });
    if (server.unavailable) return this.skip(server.unavailable);
    assert.ok(server.exitCode !== 0, `expected a non-zero exit, got ${server.exitCode}`);
    assert.match(server.log(), /The sessions base directory .* does not exist/,
      'the startup failure must say what is missing');
    assert.match(server.log(), /-Dsession\.basePath/, 'the startup failure must say how to fix it');
  });

  it('refuses to start when the base path exists but is not a directory', async function () {
    const aFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shs-file-')), 'sessions');
    fs.writeFileSync(aFile, 'not a directory');
    const server = await spawnServerExpectExit({ basePath: aFile });
    if (server.unavailable) return this.skip(server.unavailable);
    assert.ok(server.exitCode !== 0, `expected a non-zero exit, got ${server.exitCode}`);
    assert.match(server.log(), /The sessions base directory .* does not exist \(or is not a directory\)/);
  });

  it('refuses to start when the base directory exists but is not writable', async function () {
    if (process.getuid && process.getuid() === 0) {
      return this.skip('running as root — chmod cannot make a directory unwritable');
    }
    const readOnly = fs.mkdtempSync(path.join(os.tmpdir(), 'shs-readonly-'));
    fs.chmodSync(readOnly, 0o555);
    try {
      const server = await spawnServerExpectExit({ basePath: readOnly });
      if (server.unavailable) return this.skip(server.unavailable);
      assert.ok(server.exitCode !== 0, `expected a non-zero exit, got ${server.exitCode}`);
      assert.match(server.log(), /The sessions base directory .* is not writable/);
    } finally {
      fs.chmodSync(readOnly, 0o755);
    }
  });
});
