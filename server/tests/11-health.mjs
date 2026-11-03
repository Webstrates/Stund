/**
 * SessionHistoryServer functional tests — 11. the health endpoint
 *
 * GET /health serves the server's self-observations as booleans that the
 * rest of the server maintains while doing its usual work — so the
 * contract here is: a small fixed JSON shape, green values against a
 * healthy test server, and no measurable cost to polling it.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

import assert from 'node:assert/strict';
import { BASE_URL, getRaw, record } from './helpers.mjs';

const FIELDS = [
  'status', 'uptimeSeconds',
  'selfTestPassed', 'gstreamerInitialized', 'tenVadLoaded', 'warmupCompleted',
  'authConfigured', 'tokensDirWritable',
  'sessionDirWritable', 'sessionDirHas1GBFree', 'sessionDirUsableBytes',
  'lastSessionWriteOk', 'lastSessionWriteAgeSeconds',
];

async function getHealth() {
  const response = await getRaw('/health');
  return { response, status: response.status, json: await response.json() };
}

describe('the health endpoint (/health)', () => {

  it('serves a small JSON report with the expected fields', async () => {
    const { response, status, json } = await getHealth();
    assert.ok(response.ok || status === 503, 'the endpoint must answer (200 or the degraded 503)');
    assert.match(response.headers.get('content-type') || '', /json/);
    for (const field of FIELDS) {
      assert.ok(field in json, `the report must carry "${field}"`);
    }
    assert.ok(['ok', 'degraded'].includes(json.status), `"status" must be ok|degraded, got ${json.status}`);
    assert.equal(typeof json.sessionDirUsableBytes, 'number');
    assert.ok(json.uptimeSeconds >= 0);
  });

  it('reports a green server', async () => {
    // the functional tests run against a healthy, freshly started server
    const { json } = await getHealth();
    for (const field of ['selfTestPassed', 'gstreamerInitialized', 'tenVadLoaded', 'warmupCompleted',
      'authConfigured', 'tokensDirWritable', 'sessionDirWritable', 'sessionDirHas1GBFree',
      'lastSessionWriteOk']) {
      assert.equal(json[field], true, `${field} must be true against the test server`);
    }
    assert.equal(json.status, 'ok');
    assert.ok(json.sessionDirUsableBytes >= 1024 * 1024 * 1024,
      `the sessions dir must report at least 1 GiB usable, got ${json.sessionDirUsableBytes}`);
  });

  it('needs no entityKey (it exposes machine state, not session data)', async () => {
    const { status } = await getHealth();
    assert.ok(status === 200 || status === 503, `no auth must be demanded, got ${status}`);
  });

  it('costs nothing to spam — a burst of polls stays fast and green', async () => {
    // the endpoint reads back cached booleans; hammering it must neither
    // degrade the answers nor grow their latency in any measurable way
    const burst = 100;
    const started = performance.now();
    const replies = await Promise.all(
      Array.from({ length: burst }, () => getHealth().catch((e) => ({ error: e }))));
    const elapsed = performance.now() - started;
    for (const reply of replies) {
      assert.ok(!reply.error, `a poll failed: ${reply.error}`);
      assert.ok(reply.status === 200 || reply.status === 503);
    }
    assert.equal(replies.filter((r) => r.json?.status === 'ok').length, burst,
      'every burst answer must stay green');
    record(`a ${burst}-request health burst`, elapsed, 'ms');
    const single = await getHealth();
    assert.ok(single.json.uptimeSeconds > 0, 'the server is unharmed afterwards');
  });
});
