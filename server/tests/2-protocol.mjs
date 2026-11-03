/**
 * SessionHistoryServer functional tests — 2. websocket protocol
 *
 * Connection handling (unknown sessions, schema broadcast, status pings),
 * the command/reply protocol including error replies, robustness against
 * garbage input, and the owner-gated session lifecycle.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

import assert from 'node:assert/strict';
import { createSession, wsConnect, randomEntity, record } from './helpers.mjs';

describe('connecting', () => {
  it('rejects connections to unknown sessions with a close reason', async () => {
    await assert.rejects(
      () => wsConnect('00000000-0000-0000-0000-000000000000', randomEntity()),
      (info) => info.code === 1011 && /No such session/.test(info.reason),
      'expected close code 1011 with a "No such session" reason',
    );
  });

  it('accepts a connection and immediately broadcasts the session schema', async () => {
    const sessionId = await createSession('schema-probe');
    const socket = await wsConnect(sessionId, randomEntity());
    const schemaMsg = await socket.awaitMsg((m) => m.cmd === 'schemaChange', 10000, 'schemaChange');
    assert.equal(schemaMsg.schema.owner, 'schema-probe');
    assert.ok(schemaMsg.schema.processors, 'schema has a processors map');
    assert.ok(Object.keys(schemaMsg.schema.processors).length > 0, 'schema lists the default processors');
    socket.close();
  });

  it('sends a status ping roughly every 5 seconds', async () => {
    const sessionId = await createSession('ping-probe');
    const socket = await wsConnect(sessionId, randomEntity());
    const started = process.hrtime.bigint();
    await socket.awaitMsg((m) => m.cmd === 'status', 8000, 'status ping');
    record('status ping interval', Number(process.hrtime.bigint() - started) / 1e6 - 100 /* ws connect overhead */);
    assert.ok(socket.isOpen);
    socket.close();
  });
});

describe('commands and error replies', () => {
  let sessionId;
  let socket;
  before(async () => {
    sessionId = await createSession('protocol-probe');
    socket = await wsConnect(sessionId, 'protocol-probe');
  });
  after(() => socket?.close());

  it('lists the supported processors with generated config schemas', async () => {
    const reply = await socket.request({ cmd: 'getSupportedProcessors' });
    assert.equal(reply.status, true);
    const types = Object.keys(reply.processors);
    for (const expected of ['ScriptProcessor', 'EventStreamProcessor', 'VoiceActivationProcessor']) {
      assert.ok(types.includes(expected), `expected ${expected} in [${types}]`);
    }
    assert.ok(reply.processors.ScriptProcessor.configSchema, 'each processor carries a configSchema');
  });

  it('replies with {status:false} for an unknown event id', async () => {
    const reply = await socket.request({ cmd: 'getEvent', id: 'nope' });
    assert.equal(reply.status, false);
    assert.match(reply.message, /No such event/);
  });

  it('replies with {status:false} for an unknown model', async () => {
    const reply = await socket.request({ cmd: 'connectModel', model: 'no-such-model' });
    assert.equal(reply.status, false);
    assert.match(reply.message, /No such model/);
  });

  it('replies with {status:false} for an unknown processor type', async () => {
    const reply = await socket.request({ cmd: 'addProcessor', name: 'bogus0', type: 'NoSuchProcessor', config: {} });
    assert.equal(reply.status, false);
    assert.match(reply.message, /NoSuchProcessor/);
  });

  it('ignores unknown commands without killing the connection', async () => {
    await assert.rejects(() => socket.request({ cmd: 'frobnicate' }, 2000), /no reply/, 'unknown commands should not be answered');
    assert.ok(socket.isOpen, 'connection must survive an unknown command');
    const stillWorks = await socket.request({ cmd: 'getSupportedProcessors' });
    assert.equal(stillWorks.status, true, 'connection must still answer real commands');
  });

  it('answers ping like every other command', async () => {
    const op = socket.send({ cmd: 'ping' });
    const reply = await socket.awaitMsg((m) => m.op === op, 3000, `ping reply (op ${op})`);
    assert.equal(reply.status, true);
    assert.equal(reply.cmd, 'return', 'the ping reply must carry cmd:"return" like every other reply, or no client can match it');
  });

  it('[known-bug: error handler NPEs and drops the connection] survives malformed JSON', async () => {
    socket.websocket.send('this is not json{');
    await new Promise((r) => setTimeout(r, 1000));
    assert.ok(socket.isOpen, 'connection must survive garbage input');
    const stillWorks = await socket.request({ cmd: 'getSupportedProcessors' });
    assert.equal(stillWorks.status, true);
  });

  it('[known-bug: same NPE] survives a command without an op counter', async () => {
    socket.websocket.send(JSON.stringify({ cmd: 'getSupportedProcessors' }));
    await new Promise((r) => setTimeout(r, 1000));
    assert.ok(socket.isOpen, 'connection must survive a missing op field');
  });
});

describe('session lifecycle (owner-gated start/stop)', () => {
  let sessionId;
  let owner;
  let intruder;
  before(async () => {
    sessionId = await createSession('the-boss');
    owner = await wsConnect(sessionId, 'the-boss');
    intruder = await wsConnect(sessionId, 'somebody-else');
  });
  after(() => { owner?.close(); intruder?.close(); });

  it('refuses to let a non-owner start the session', async () => {
    const reply = await intruder.request({ cmd: 'start' });
    assert.equal(reply.status, false);
    assert.match(reply.message, /owner/);
  });

  it('lets the owner start the session', async () => {
    const reply = await owner.request({ cmd: 'start' });
    assert.equal(reply.status, true, 'a successful start must be acknowledged (session.js start() otherwise only resolves with its 5s give-up reply)');
    const schemaMsg = await owner.awaitMsg((m) => m.cmd === 'schemaChange' && m.schema.start != null, 10000, 'schema with start');
    assert.ok(Number.isFinite(schemaMsg.schema.start), 'start timestamp must be stamped into the schema');
  });

  // Self-contained: start the session here (fire-and-forget, then the
  // schema broadcast proves it took) so this test does not depend on the
  // [known-bug] start test above having run — the CI gate excludes the
  // known-bug tests, and without this the session would never have
  // started. When the [known-bug] test does run, the start is a no-op
  // ("already started") and the broadcast is found in the message log.
  it('refuses to start a session that has already started', async () => {
    owner.send({ cmd: 'start' });
    await owner.awaitMsg((m) => m.cmd === 'schemaChange' && m.schema.start != null, 10000, 'schema with start');
    const again = await owner.request({ cmd: 'start' });
    assert.equal(again.status, false);
    assert.match(again.message, /already started/);
  });

  it('refuses to let a non-owner stop the session', async () => {
    const reply = await intruder.request({ cmd: 'stop' });
    assert.equal(reply.status, false);
    assert.match(reply.message, /owner/);
  });

  it('lets the owner stop the session and stamps the schema', async () => {
    const reply = await owner.request({ cmd: 'stop' });
    assert.equal(reply.status, true, 'a successful stop must be acknowledged (session.js stop() otherwise only resolves with its 5s give-up reply)');
    const schemaMsg = await owner.awaitMsg((m) => m.cmd === 'schemaChange' && m.schema.end != null, 10000, 'schema with end');
    assert.ok(schemaMsg.schema.start <= schemaMsg.schema.end, 'start timestamp must precede end timestamp');
  });

  // Self-contained for the same reason as the "already started" test
  // above: the [known-bug] stop test owns the first stop, but the CI
  // gate excludes it — stop here and watch the schema broadcast before
  // asserting the refusal.
  it('refuses to stop a session that has already ended', async () => {
    owner.send({ cmd: 'stop' });
    await owner.awaitMsg((m) => m.cmd === 'schemaChange' && m.schema.end != null, 10000, 'schema with end');
    const again = await owner.request({ cmd: 'stop' });
    assert.equal(again.status, false);
    assert.match(again.message, /already ended/);
  });
});
