/**
 * SessionHistoryServer functional tests — 3. model subscriptions
 *
 * The "history" model every session ships with: subscribing, coalesced
 * bulk updates, the tentative→closed duration-event lifecycle, replay of
 * past events to late subscribers, and the server-side event API.
 *
 * Script processors (which run in a sandbox and need no external services)
 * are used as the event source — anything a browser would send over a
 * WebRTC data channel can be produced this way.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

import assert from 'node:assert/strict';
import { createSession, wsConnect, randomEntity, modelEvents, record, sleep } from './helpers.mjs';

/** A script processor whose init() fires `count` instant "test3.chat" events. */
function chatEmitter(name, count, text = 'hello world') {
  return {
    cmd: 'addProcessor', name, type: 'ScriptProcessor',
    config: {
      language: 'js', emitExceptionEvents: true,
      script: `
        let s = null;
        function init() {
          s = stund.startEventStream("test3.chat");
          for (let i = 0; i < ${count}; i++) s.createInstantEvent({ text: "${text}", n: i }, Date.now());
        }
        function onEventAdded(ev) {}
        function onEventUpdated(ev) {}`,
      inputs: {},
      outputs: { 'test3.chat': { schemaId: 'stund://test3Chat.json', internal: true } },
      schemas: {
        'stund://test3Chat.json': {
          type: 'object', properties: { text: { type: 'string' }, n: { type: 'integer' } },
          required: ['text', 'n'], additionalProperties: false,
        },
      },
    },
  };
}

describe('model subscriptions', () => {
  it('subscribes to the history model and returns a subscription id', async () => {
    const sessionId = await createSession('model-probe');
    const socket = await wsConnect(sessionId, randomEntity());
    const reply = await socket.request({ cmd: 'connectModel', model: 'history' });
    assert.equal(reply.status, true);
    assert.equal(typeof reply.subscription, 'number');
    socket.close();
  });

  it('numbers subscriptions incrementally per connection', async () => {
    const sessionId = await createSession('model-probe');
    const socket = await wsConnect(sessionId, randomEntity());
    const first = await socket.request({ cmd: 'connectModel', model: 'history' });
    const second = await socket.request({ cmd: 'connectModel', model: 'history' });
    assert.equal(second.subscription, first.subscription + 1);
    socket.close();
  });

  it('keeps a surviving subscription id stable across a disconnectModel', async () => {
    // Two differently-named models: disconnectModel addresses subscriptions
    // by model name, so the survivor has to be a different model to stay live.
    const spec = { processors: [], models: [
      { name: 'test3-a', config: { inputs: { '^test3\\.chat$': {} } } },
      { name: 'test3-b', config: { inputs: { '^test3\\.chat$': {} } } },
    ] };
    const sessionId = await createSession('stable-ids-probe', { spec });
    const socket = await wsConnect(sessionId, randomEntity());
    const first = await socket.request({ cmd: 'connectModel', model: 'test3-a' });
    const second = await socket.request({ cmd: 'connectModel', model: 'test3-b' });
    assert.equal(first.status, true);
    assert.equal(second.status, true);
    assert.equal(second.subscription, first.subscription + 1);

    const changes = [];
    const unhook = socket.onEvery((m) => { if (m.cmd === 'modelChange') changes.push(m); });
    assert.equal((await socket.request({ cmd: 'disconnectModel', model: 'test3-a' })).status, true);
    assert.equal((await socket.request(chatEmitter('stable0', 1, 'stable ids'))).status, true);
    await sleep(2500); // let the coalescing window deliver the survivor's bulk
    unhook();

    // The survivor must answer under the id it was handed out at connect
    // time — not one renumbered underneath it — and the disconnected
    // subscription must not deliver anything more.
    assert.ok(changes.some((m) => m.subscription === second.subscription),
      `the surviving subscription must deliver under id ${second.subscription}, saw ${JSON.stringify(changes.map((m) => m.subscription))}`);
    assert.ok(!changes.some((m) => m.subscription === first.subscription),
      'the disconnected subscription must not deliver anything more');

    // A fresh subscription must not reuse the id of a live one
    const third = await socket.request({ cmd: 'connectModel', model: 'test3-a' });
    assert.ok(third.subscription > second.subscription,
      `a fresh subscription must not reuse the id of a live one (${third.subscription} vs ${second.subscription})`);
    socket.close();
  });

  it('delivers processor events as coalesced bulk updates', async () => {
    const sessionId = await createSession('bulk-probe');
    const socket = await wsConnect(sessionId, randomEntity());
    const events = modelEvents(socket, { types: '^test3\\.chat$' });
    assert.equal((await socket.request({ cmd: 'connectModel', model: 'history' })).status, true);

    const started = Date.now();
    assert.equal((await socket.request(chatEmitter('chatter0', 1))).status, true);
    const first = await events.waitFor((e) => e.data?.text === 'hello world', 10000, 'chat event');
    record('processor event → modelChange latency', Date.now() - started);
    assert.equal(first.type, 'test3.chat');
    socket.close();
  });

  it('coalesces a burst of 10 events into a couple of messages, not 10', async () => {
    const sessionId = await createSession('coalesce-probe');
    const socket = await wsConnect(sessionId, randomEntity());
    assert.equal((await socket.request({ cmd: 'connectModel', model: 'history' })).status, true);

    const events = modelEvents(socket, { types: '^test3\\.chat$' });
    let bulkCount = 0;
    const unhook = socket.onEvery((m) => { if (m.cmd === 'modelChange') bulkCount++; });
    assert.equal((await socket.request(chatEmitter('burst0', 10))).status, true);
    await sleep(2500);
    unhook();

    assert.equal(events.seen.length, 10, 'all 10 events must arrive');
    assert.ok(bulkCount <= 4, `expected ≤4 modelChange messages for 10 events, got ${bulkCount}`);
    record('modelChange messages per 10-event burst', bulkCount, 'messages');
    socket.close();
  });

  it('replays all past events to a subscriber that connects late', async () => {
    const sessionId = await createSession('replay-probe');
    const producer = await wsConnect(sessionId, randomEntity());
    assert.equal((await producer.request(chatEmitter('history0', 5))).status, true);
    await sleep(2000); // let the events settle into the model
    producer.close();

    // A brand-new connection subscribes after everything happened:
    const latecomer = await wsConnect(sessionId, randomEntity());
    const lateEvents = modelEvents(latecomer, { types: '^test3\\.chat$' });
    assert.equal((await latecomer.request({ cmd: 'connectModel', model: 'history' })).status, true);
    await lateEvents.waitFor((e) => e.data?.n === 4, 10000, 'replayed history');
    assert.deepEqual(
      lateEvents.seen.map((e) => e.data.n).sort(),
      [0, 1, 2, 3, 4],
      'the late subscriber must see exactly the five recorded events',
    );
    latecomer.close();
  });

  it('excludes server-internal meta fields from model events', async () => {
    const sessionId = await createSession('meta-probe');
    const socket = await wsConnect(sessionId, randomEntity());
    const events = modelEvents(socket, { types: '^test3\\.chat$' });
    assert.equal((await socket.request({ cmd: 'connectModel', model: 'history' })).status, true);
    assert.equal((await socket.request(chatEmitter('meta0', 1))).status, true);
    const event = await events.waitFor(() => true, 10000, 'chat event');
    for (const metaField of ['created', 'sourceEvents', 'processor']) {
      assert.ok(!(metaField in event), `model events must not carry the @Meta field "${metaField}"`);
    }
    socket.close();
  });
});

describe('duration events through the model (tentative → updated → closed)', () => {
  const stateProcessor = (name, script) => ({
    cmd: 'addProcessor', name, type: 'ScriptProcessor',
    config: {
      language: 'js', emitExceptionEvents: true, script,
      inputs: {},
      outputs: { 'test3.state': { schemaId: 'stund://test3State.json', internal: true } },
      schemas: {
        'stund://test3State.json': {
          type: 'object', properties: { phase: { type: 'string' } },
          required: ['phase'], additionalProperties: false,
        },
      },
    },
  });

  it('carries add→update→stop through a single event id', async () => {
    const sessionId = await createSession('duration-probe');
    const socket = await wsConnect(sessionId, randomEntity());
    const events = modelEvents(socket, { types: '^test3\\.state$' });
    assert.equal((await socket.request({ cmd: 'connectModel', model: 'history' })).status, true);

    assert.equal((await socket.request(stateProcessor('state0', `
      let s = null;
      function init() {
        s = stund.startEventStream("test3.state");
        let ev = s.createDurationEvent({ phase: "begin" }, Date.now());
        ev.update({ phase: "middle" }, Date.now() + 500);
        ev.update({ phase: "end" }, Date.now() + 1000);
        ev.stop();
      }
      function onEventAdded(ev) {}
      function onEventUpdated(ev) {}`))).status, true);

    const event = await events.waitFor((e) => e.tentative === false, 10000, 'closed duration event');
    assert.equal(event.type, 'test3.state');
    assert.equal(event.data.phase, 'end', 'updates must merge into the event data');
    assert.ok(event.end > event.start, 'a closed duration event must have end > start');
    assert.equal(events.seen.filter((e) => e.id === event.id).length, 1, 'all updates must land on one id');
    socket.close();
  });

  it('refuses to update a duration event after it has been stopped', async () => {
    const sessionId = await createSession('stopped-probe');
    const socket = await wsConnect(sessionId, randomEntity());
    const errors = modelEvents(socket, { types: '^debug\\.processor\\.state0\\.error$' });
    assert.equal((await socket.request({ cmd: 'connectModel', model: 'history' })).status, true);

    // The update() after stop() throws inside the sandbox; the processor
    // turns it into a declared exception event.
    assert.equal((await socket.request(stateProcessor('state0', `
      let s = null;
      function init() {
        s = stund.startEventStream("test3.state");
        let ev = s.createDurationEvent({ phase: "x" }, Date.now());
        ev.stop();
        ev.update({ phase: "y" }, Date.now() + 100);
      }
      function onEventAdded(ev) {}
      function onEventUpdated(ev) {}`))).status, true);

    const error = await errors.waitFor(() => true, 10000, 'exception event');
    assert.match(error.data.text, /no longer be updated/);
    socket.close();
  });
});

describe('model input field filters (ModelInputSpecification.fields)', () => {
  /** A session whose only model gathers test3.chat events per the given input specs. */
  const filteredSession = (inputs) => createSession('filter-probe', { spec: {
    processors: [],
    models: [{ name: 'm', config: { inputs } }],
  } });

  /** A script processor whose init() fires one instant "test3.nested" event
   * with a nested data object, for path/wildcard coverage. */
  const nestedEmitter = (name) => ({
    cmd: 'addProcessor', name, type: 'ScriptProcessor',
    config: {
      language: 'js', emitExceptionEvents: true,
      script: `
        let s = null;
        function init() {
          s = stund.startEventStream("test3.nested");
          s.createInstantEvent({ keep: { a: 1, b: 2 }, drop: 0 }, Date.now());
        }
        function onEventAdded(ev) {}
        function onEventUpdated(ev) {}`,
      inputs: {},
      outputs: { 'test3.nested': { schemaId: 'stund://test3Nested.json', internal: true } },
      schemas: {
        'stund://test3Nested.json': {
          type: 'object',
          properties: {
            keep: {
              type: 'object',
              properties: { a: { type: 'integer' }, b: { type: 'integer' } },
              required: ['a', 'b'], additionalProperties: false,
            },
            drop: { type: 'integer' },
          },
          required: ['keep', 'drop'], additionalProperties: false,
        },
      },
    },
  });

  it('keeps only the listed data paths - the TimedEvent envelope rides along', async () => {
    const socket = await wsConnect(await filteredSession({ 'test3\\.chat': { fields: ['$.text'] } }), randomEntity());
    const events = modelEvents(socket);
    try {
      assert.equal((await socket.request({ cmd: 'connectModel', model: 'm' })).status, true);
      assert.equal((await socket.request(chatEmitter('filter0', 1))).status, true);
      const event = await events.waitFor((e) => e.type === 'test3.chat', 10000, 'filtered chat event');
      assert.deepEqual(event.data, { text: 'hello world' }, 'only the listed data path survives');
      assert.equal(event.type, 'test3.chat');
      assert.equal(typeof event.start, 'number');
      assert.ok(event.id, 'the envelope always carries the id');
    } finally { socket.close(); }
  });

  it('unions the data paths of every matching input pattern', async () => {
    const socket = await wsConnect(await filteredSession({
      'test3\\.(.*)': { fields: ['$.keep.a'] },
      'test3\\.nested': { fields: ['$.keep.b'] },
    }), randomEntity());
    const events = modelEvents(socket);
    try {
      assert.equal((await socket.request({ cmd: 'connectModel', model: 'm' })).status, true);
      assert.equal((await socket.request(nestedEmitter('union0'))).status, true);
      const event = await events.waitFor((e) => e.type === 'test3.nested', 10000, 'union-filtered nested event');
      assert.deepEqual(event.data, { keep: { a: 1, b: 2 } },
        'both patterns contribute their paths under one container - and a broken no-op filter would leak drop: 0 here');
    } finally { socket.close(); }
  });

  it('drops data entirely on an empty fields list (envelope-only feed)', async () => {
    const socket = await wsConnect(await filteredSession({ 'test3\\.chat': { fields: [] } }), randomEntity());
    const events = modelEvents(socket);
    try {
      assert.equal((await socket.request({ cmd: 'connectModel', model: 'm' })).status, true);
      assert.equal((await socket.request(chatEmitter('vad0', 1))).status, true);
      const event = await events.waitFor((e) => e.type === 'test3.chat', 10000, 'envelope-only chat event');
      assert.ok(!('data' in event), 'an empty fields list leaves out the data member');
      assert.equal(event.type, 'test3.chat');
      assert.equal(typeof event.start, 'number', 'start/stop timing is what this feed is for');
    } finally { socket.close(); }
  });

  it('harvests nested paths and wildcard segments, dropping the rest', async () => {
    const socket = await wsConnect(await filteredSession({ 'test3\\.nested': { fields: ['$.keep.*'] } }), randomEntity());
    const events = modelEvents(socket);
    try {
      assert.equal((await socket.request({ cmd: 'connectModel', model: 'm' })).status, true);
      assert.equal((await socket.request(nestedEmitter('wild0'))).status, true);
      const event = await events.waitFor((e) => e.type === 'test3.nested', 10000, 'wildcard-filtered event');
      assert.deepEqual(event.data, { keep: { a: 1, b: 2 } },
        'the wildcard harvests every child of keep; drop does not survive');
    } finally { socket.close(); }
  });

  it('fans a wildcard out mid-path, skipping non-object siblings', async () => {
    const socket = await wsConnect(await filteredSession({ 'test3\\.nested': { fields: ['$.*.a'] } }), randomEntity());
    const events = modelEvents(socket);
    try {
      assert.equal((await socket.request({ cmd: 'connectModel', model: 'm' })).status, true);
      assert.equal((await socket.request(nestedEmitter('midwild0'))).status, true);
      const event = await events.waitFor((e) => e.type === 'test3.nested', 10000, 'mid-wildcard event');
      assert.deepEqual(event.data, { keep: { a: 1 } },
        'the wildcard walks every object child of data; the scalar sibling is skipped, unlisted keys are not kept');
    } finally { socket.close(); }
  });

  it('leaves data out on a deep miss too - no empty scaffold containers', async () => {
    const socket = await wsConnect(await filteredSession({ 'test3\\.nested': { fields: ['$.keep.z'] } }), randomEntity());
    const events = modelEvents(socket);
    try {
      assert.equal((await socket.request({ cmd: 'connectModel', model: 'm' })).status, true);
      assert.equal((await socket.request(nestedEmitter('deep0'))).status, true);
      const event = await events.waitFor((e) => e.type === 'test3.nested', 10000, 'deep-miss event');
      assert.ok(!('data' in event), 'a path whose leaf is missing leaves no scaffold behind - data stays out');
    } finally { socket.close(); }
  });

  it('leaves data out when the listed paths address nothing in an event', async () => {
    const socket = await wsConnect(await filteredSession({ 'test3\\.chat': { fields: ['$.nope'] } }), randomEntity());
    const events = modelEvents(socket);
    try {
      assert.equal((await socket.request({ cmd: 'connectModel', model: 'm' })).status, true);
      assert.equal((await socket.request(chatEmitter('absent0', 1))).status, true);
      const event = await events.waitFor((e) => e.type === 'test3.chat', 10000, 'empty-harvest chat event');
      assert.ok(!('data' in event), 'an empty harvest leaves out the data member');
      assert.equal(event.type, 'test3.chat');
    } finally { socket.close(); }
  });

  it('keeps the whole event when any matching pattern is unrestricted', async () => {
    const socket = await wsConnect(await filteredSession({
      'test3\\.chat': { fields: ['$.text'] },
      '.*': {},
    }), randomEntity());
    const events = modelEvents(socket);
    try {
      assert.equal((await socket.request({ cmd: 'connectModel', model: 'm' })).status, true);
      assert.equal((await socket.request(chatEmitter('unrestricted0', 1))).status, true);
      const event = await events.waitFor((e) => e.type === 'test3.chat', 10000, 'whole chat event');
      assert.equal(event.type, 'test3.chat');
      assert.equal(typeof event.start, 'number');
      assert.deepEqual(event.data, { text: 'hello world', n: 0 }, 'the whole data object survives');
    } finally { socket.close(); }
  });
});
