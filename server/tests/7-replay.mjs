/**
 * SessionHistoryServer functional tests — 7. replay & persistence
 *
 * The same "history" subscription that tails live events also replays
 * everything that was recorded before the subscriber connected. These
 * tests pin down the replay contents and ordering, the getEvent meta
 * handling, and the session-restore stub (a second server pointed at the
 * same recordings cannot serve them).
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createSession, wsConnect, modelEvents, spawnServer, randomEntity, record, sleep,
} from './helpers.mjs';

/** Script processor that emits `count` events with controlled absolute starts. */
function historySource(name, count, firstStart, stepMs) {
  return {
    cmd: 'addProcessor', name, type: 'ScriptProcessor',
    config: {
      language: 'js', emitExceptionEvents: true,
      script: `
        let s = null;
        function init() {
          s = stund.startEventStream("test7.history");
          for (let i = 0; i < ${count}; i++) {
            s.createInstantEvent({ n: i }, ${firstStart} + i * ${stepMs});
          }
        }
        function onEventAdded(ev) {}
        function onEventUpdated(ev) {}`,
      inputs: {},
      outputs: { 'test7.history': { schemaId: 'stund://test7History.json', internal: true } },
      schemas: {
        'stund://test7History.json': {
          type: 'object', properties: { n: { type: 'integer' } },
          required: ['n'], additionalProperties: false,
        },
      },
    },
  };
}

describe('replaying recorded history', () => {
  it('delivers exactly the recorded events to a late subscriber', async () => {
    const sessionId = await createSession('replay7');
    const base = Date.now() - 120000; // controlled starts, two minutes back
    const producer = await wsConnect(sessionId, randomEntity());
    assert.equal((await producer.request(historySource('src0', 5, base, 1000))).status, true);
    await sleep(1500); // let the events settle into the model
    producer.close();

    const latecomer = await wsConnect(sessionId, randomEntity());
    const events = modelEvents(latecomer, { types: '^test7\\.history$' });
    assert.equal((await latecomer.request({ cmd: 'connectModel', model: 'history' })).status, true);
    await events.waitFor((e) => e.data?.n === 4, 15000, 'replayed history');

    assert.deepEqual(events.seen.map((e) => e.data.n).sort(), [0, 1, 2, 3, 4],
      'the late subscriber must see exactly the five recorded events');
    for (const event of events.seen) {
      assert.equal(event.start, base + event.data.n * 1000,
        'replayed events must keep their original timestamps');
    }
    latecomer.close();
  });

  it('[known-bug: the replay pre-fill iterates a HashMap keyed by event id — delivery order is hash order, not time order] replays history in start order', async () => {
    // Desired: a client receiving the replay can build a timeline directly.
    // Today EventModel.subscribe() walks filteredEvents (HashMap by id), so
    // the add array order is arbitrary; every client must re-sort.
    const sessionId = await createSession('reorder7');
    const base = Date.now() - 3600000;
    const producer = await wsConnect(sessionId, randomEntity());
    assert.equal((await producer.request(historySource('src0', 70, base, 1000))).status, true);
    await sleep(2000);
    producer.close();

    const latecomer = await wsConnect(sessionId, randomEntity());
    const firstBulk = [];
    latecomer.onEvery((msg) => {
      if (msg.cmd === 'modelChange' && Array.isArray(msg.add) && msg.add.length > 1) firstBulk.push(...msg.add);
    });
    const started = Date.now();
    assert.equal((await latecomer.request({ cmd: 'connectModel', model: 'history' })).status, true);
    await sleep(1500); // the pre-fill bulk arrives after the 100ms coalesce window
    record('70-event replay → first modelChange', Date.now() - started);
    latecomer.close();

    const starts = firstBulk.filter((e) => e.type === 'test7.history').map((e) => e.start);
    assert.equal(starts.length, 70, `expected the full 70-event history, got ${starts.length}`);
    const sorted = [...starts].sort((a, b) => a - b);
    assert.deepEqual(starts, sorted,
      'the replayed add array must be ordered by start (clients should not have to re-sort history)');
  });

  it('[known-bug: getEvent ignores EventQuery.options — the FIXME in WebsocketEndpoint] hides server meta unless the client asks for it', async () => {
    // Desired: the default reply carries the event payload; @Meta fields
    // (created, sourceEvents, processor) only appear with
    // options.includeMeta — as the EventQuery DTO already promises.
    const sessionId = await createSession('meta7');
    const socket = await wsConnect(sessionId, randomEntity());
    assert.equal((await socket.request(historySource('src0', 1, Date.now(), 0))).status, true);
    const events = modelEvents(socket, { types: '^test7\\.history$' });
    assert.equal((await socket.request({ cmd: 'connectModel', model: 'history' })).status, true);
    const event = await events.waitFor(() => true, 15000, 'the recorded event');

    const plain = await socket.request({ cmd: 'getEvent', id: event.id });
    assert.equal(plain.status, true);
    assert.equal(plain.event.data.n, 0, 'getEvent must return the event data');
    for (const metaField of ['created', 'sourceEvents', 'processor']) {
      assert.ok(!(metaField in plain.event),
        `the default getEvent reply must not carry the @Meta field "${metaField}"`);
    }

    const withMeta = await socket.request({ cmd: 'getEvent', id: event.id, options: { includeMeta: true } });
    assert.equal(withMeta.status, true);
    assert.ok('created' in withMeta.event, 'includeMeta must expose the server-side creation timestamp');
    socket.close();
  });

  it('keeps tailing live events on the same subscription after the replay', async () => {
    const sessionId = await createSession('tail7');
    const producer = await wsConnect(sessionId, randomEntity());
    assert.equal((await producer.request(historySource('src0', 3, Date.now() - 60000, 1000))).status, true);
    await sleep(1500);
    producer.close();

    const latecomer = await wsConnect(sessionId, randomEntity());
    const events = modelEvents(latecomer, { types: '^test7\\.history$' });
    assert.equal((await latecomer.request({ cmd: 'connectModel', model: 'history' })).status, true);
    await events.waitFor((e) => e.data?.n === 2, 15000, 'the replay');
    assert.equal(events.seen.length, 3, 'pre-fill only');

    // new events after the replay must arrive on the SAME subscription
    assert.equal((await latecomer.request(historySource('src1', 1, Date.now(), 0))).status, true);
    await events.waitFor((e) => e.data?.n === 0 && !events.seen.slice(0, 3).includes(e), 15000, 'the live tail');
    assert.ok(events.seen.length >= 4, 'the subscription must carry both replay and live tail');
    latecomer.close();
  });
});

describe('session persistence across servers', () => {
  it('[known-bug: SessionStorage\'s constructor loads a hardcoded blank schema — nothing is ever read back from disk] a second server on the same recordings serves the recorded history', async function () {
    this.timeout(240000);
    // The recordings are plain files (event track JSON, Matroska, schema.udta)
    // — everything needed to reopen a session exists on disk. Desired: a
    // server pointed at the same basePath can hand out the history. Today
    // the constructor prints "STUB: Loading hardcoded session schema" and
    // the session comes back amnesiac: default processors, empty model.
    const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'shs-replay-'));
    const serverA = await spawnServer({ basePath });
    if (serverA.unavailable) return this.skip(`server spawn unavailable: ${serverA.unavailable}`);

    let serverB = null;
    const sockets = [];
    try {
      // create a session on server A and record some history into it
      // (spawned servers bring their own master password in their config.json)
      const sessionId = await createSession('replay-owner', { baseUrl: serverA.url, password: serverA.masterPassword });
      const producer = await wsConnect(sessionId, 'replay-owner',
        { baseUrl: serverA.url.replace('http', 'ws'), password: serverA.masterPassword });
      sockets.push(producer);
      assert.equal((await producer.request(historySource('src0', 5, Date.now() - 60000, 1000))).status, true);
      await sleep(1500);

      // a second server on the SAME recordings
      serverB = await spawnServer({ basePath });
      assert.ok(!serverB.unavailable, 'server B must come up');
      const latecomer = await wsConnect(sessionId, 'replay-reader',
        { baseUrl: serverB.url.replace('http', 'ws'), password: serverB.masterPassword });
      sockets.push(latecomer);
      const events = modelEvents(latecomer, { types: '^test7\\.history$' });
      assert.equal((await latecomer.request({ cmd: 'connectModel', model: 'history' })).status, true);
      await events.waitFor((e) => e.data?.n === 4, 20000, 'the recorded history from server B');
    } finally {
      for (const socket of sockets) socket.close();
      await serverA.stop?.();
      await serverB?.stop?.();
    }
  });
});
