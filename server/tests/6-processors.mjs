/**
 * SessionHistoryServer functional tests — 6. processors
 *
 * Processor lifecycle over the raw protocol: sandboxed script processors
 * deriving new events from existing ones (and from each other), output
 * schema validation, removal semantics, and the static-executor bug
 * that lets removing one script processor kill every other one.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

import assert from 'node:assert/strict';
import {
  createSession, wsConnect, modelEvents, openPage, pageLogin, randomEntity, sleep,
} from './helpers.mjs';

const schemaFor = (name, properties, required) => ({
  type: 'object', properties, required, additionalProperties: false,
});

/** addProcessor command for a sandboxed JavaScript processor. */
function scriptProcessor(name, { script, inputs = {}, outputs, emitLogEvents = false }) {
  const schemas = {};
  for (const [type, spec] of Object.entries(outputs)) {
    if (spec.schema) schemas[spec.schemaId] = spec.schema;
  }
  return {
    cmd: 'addProcessor', name, type: 'ScriptProcessor',
    config: {
      language: 'js', emitExceptionEvents: true, emitLogEvents, script, inputs,
      outputs: Object.fromEntries(Object.entries(outputs)
        .map(([type, spec]) => [type, { schemaId: spec.schemaId, internal: true }])),
      schemas,
    },
  };
}

describe('processors', () => {
  let sessionId;
  let socket;
  before(async () => {
    sessionId = await createSession('proc-owner');
    socket = await wsConnect(sessionId, randomEntity('observer'));
    assert.equal((await socket.request({ cmd: 'connectModel', model: 'history' })).status, true);
  });
  after(() => socket?.close());

  it('chains script processors: derived events feed further processors', async () => {
    const shout = modelEvents(socket, { types: '^test6\\.shout$' });
    const chat = modelEvents(socket, { types: '^test6\\.chat$' });

    // echo: test6.chat -> test6.shout (uppercased)
    assert.equal((await socket.request(scriptProcessor('echo0', {
      script: `
        let s = null;
        function init() { s = stund.startEventStream("test6.shout"); }
        function onEventAdded(ev) {
          if (ev.type === "test6.chat" && ev.data && ev.data.text) {
            s.createInstantEvent({ shout: ev.data.text.toUpperCase() }, ev.start);
          }
        }
        function onEventUpdated(ev) {}`,
      inputs: { 'test6\\.chat': {} },
      outputs: { 'test6.shout': { schemaId: 'stund://test6Shout.json', schema: schemaFor('test6Shout', { shout: { type: 'string' } }, ['shout']) } },
    }))).status, true);

    // source: emits a couple of test6.chat events from init()
    assert.equal((await socket.request(scriptProcessor('source0', {
      script: `
        let s = null;
        function init() {
          s = stund.startEventStream("test6.chat");
          for (let i = 0; i < 2; i++) s.createInstantEvent({ text: "hello chain " + i, n: i }, Date.now());
        }
        function onEventAdded(ev) {}
        function onEventUpdated(ev) {}`,
      outputs: { 'test6.chat': { schemaId: 'stund://test6Chat.json', schema: schemaFor('test6Chat', { text: { type: 'string' }, n: { type: 'integer' } }, ['text', 'n']) } },
    }))).status, true);

    const derived = await shout.waitFor(() => true, 15000, 'derived test6.shout event');
    assert.equal(derived.data.shout, 'HELLO CHAIN 0');
    assert.equal(chat.seen.length, 2, 'the source events themselves must also be recorded');
  });

  it('surfaces output schema-validation failures as processor error events, not silence', async () => {
    const errors = modelEvents(socket, { types: '^debug\\.processor\\.bad0\\.error$' });
    // the script emits {"wrong": ...} but its output schema demands an integer "n"
    assert.equal((await socket.request(scriptProcessor('bad0', {
      script: `
        let s = null;
        function init() {
          s = stund.startEventStream("test6.bad");
          s.createInstantEvent({ wrong: "not an n" }, Date.now());
        }
        function onEventAdded(ev) {}
        function onEventUpdated(ev) {}`,
      outputs: { 'test6.bad': { schemaId: 'stund://test6Bad.json', schema: schemaFor('test6Bad', { n: { type: 'integer' } }, ['n']) } },
    }))).status, true);

    const error = await errors.waitFor(() => true, 15000, 'a debug error event');
    assert.match(error.data.text, /Validation failed/, `unexpected error text: ${error.data.text}`);
  });

  it('removeProcessor stops the derivation and updates the schema', async () => {
    const shout = modelEvents(socket, { types: '^test6\\.shout$' });
    assert.equal((await socket.request({ cmd: 'removeProcessor', processor: 'echo0' })).status, true);
    const schemaMsg = await socket.awaitMsg(
      (m) => m.cmd === 'schemaChange' && !('echo0' in m.schema.processors), 10000, 'schemaChange without echo0');
    assert.ok(schemaMsg, 'the schema broadcast must drop the removed processor');

    // a fresh source still records its events, but nothing derives shouts anymore
    const chat = modelEvents(socket, { types: '^test6\\.chat$' });
    const shoutsBefore = shout.seen.length;
    assert.equal((await socket.request(scriptProcessor('source2', {
      script: `
        let s = null;
        function init() {
          s = stund.startEventStream("test6.chat");
          s.createInstantEvent({ text: "after removal", n: 99 }, Date.now());
        }
        function onEventAdded(ev) {}
        function onEventUpdated(ev) {}`,
      outputs: { 'test6.chat': { schemaId: 'stund://test6Chat.json', schema: schemaFor('test6Chat', { text: { type: 'string' }, n: { type: 'integer' } }, ['text', 'n']) } },
    }))).status, true);
    await chat.waitFor((e) => e.data?.n === 99, 15000, 'source2 event');
    await sleep(2500);
    assert.equal(shout.seen.length, shoutsBefore, 'a removed processor must not derive any further events');
  });

  it('replies with {status:false} when removing an unknown processor', async () => {
    const reply = await socket.request({ cmd: 'removeProcessor', processor: 'never-existed' });
    assert.equal(reply.status, false);
    assert.ok(reply.message, 'the error reply must carry a message');
  });
});

describe('the shared script executor (static ExecutorService in ScriptProcessor)', () => {
  // ScriptProcessor uses ONE static executor for every instance; destroy()
  // calls shutdownNow() on it. Removing any script processor therefore
  // stops event processing for every other script processor in the JVM.
  // The trigger events here come from a browser data channel (not from
  // another script processor) — adding a new script processor would
  // re-create the shared executor and mask the bug.
  it('removing one script processor leaves the others working', async function () {
    this.timeout(90000);
    const sessionId = await createSession('proc-owner');

    const page = await openPage();
    try {
      // the server demands an entityKey — log the page in before the join
      await pageLogin(page, 'proc-browser');
      await page.evaluate(async (id) => {
        const session = await window.SessionHistory.join(id);
        await session.connectIngest();
        window.__sh = { session, ping: await session.ingest.startEventStream('application.test6.ping') };
      }, sessionId);

      const socket = await wsConnect(sessionId, randomEntity('observer'));
      try {
        assert.equal((await socket.request({ cmd: 'connectModel', model: 'history' })).status, true);
        const pings = modelEvents(socket, { types: '^application\\.test6\\.ping$' });
        const bs = modelEvents(socket, { types: '^test6\\.b$' });

        const echoScript = (output) => `
          let s = null;
          function init() { s = stund.startEventStream("${output}"); }
          function onEventAdded(ev) {
            if (ev.type === "application.test6.ping" && ev.data) {
              s.createInstantEvent({ n: ev.data.n }, ev.start);
            }
          }
          function onEventUpdated(ev) {}`;
        const echoOutputs = (type) => ({
          [type]: { schemaId: `stund://test6${type}.json`, schema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false } },
        });

        assert.equal((await socket.request(scriptProcessor('echoB', {
          script: echoScript('test6.b'),
          inputs: { 'application\\.test6\\.ping': {} },
          outputs: echoOutputs('test6.b'),
        }))).status, true);

        // baseline: the chain works before anything is removed
        await page.evaluate(() => window.__sh.ping.createInstantEvent({ n: 1 }));
        await bs.waitFor((e) => e.data?.n === 1, 20000, 'echoB derived n=1 before the removal');

        // a second script processor, then remove it
        assert.equal((await socket.request(scriptProcessor('echoA', {
          script: echoScript('test6.a'),
          inputs: { 'application\\.test6\\.ping': {} },
          outputs: echoOutputs('test6.a'),
        }))).status, true);
        assert.equal((await socket.request({ cmd: 'removeProcessor', processor: 'echoA' })).status, true);

        // echoB must survive echoA's removal
        await page.evaluate(() => window.__sh.ping.createInstantEvent({ n: 2 }));
        await pings.waitFor((e) => e.data?.n === 2, 20000, 'the ping event itself (ingest still works)');
        await bs.waitFor((e) => e.data?.n === 2, 20000, 'echoB derived n=2 after echoA was removed');
      } finally {
        socket.close();
      }
    } finally {
      await page.evaluate(() => window.__sh?.session.websocket.close()).catch(() => {});
      await page.close().catch(() => {});
    }
  });
});

describe('processor log events (emitLogEvents)', () => {
  // Everything a sandbox logs — engine warnings through the context
  // logHandler as well as console.log through the context stdout — is
  // turned into "debug.processor.<name>.log" events via Processor.log().
  let sessionId;
  let socket;
  before(async () => {
    sessionId = await createSession('proc-log');
    socket = await wsConnect(sessionId, randomEntity('observer'));
    assert.equal((await socket.request({ cmd: 'connectModel', model: 'history' })).status, true);
  });
  after(() => socket?.close());

  /**
   * A processor that logs once from init() and then emits a heartbeat
   * event. The heartbeat proves init() ran, so any log that init()
   * produced has had every chance to reach the model by the time it
   * arrives (all of it funnels through the same onEventAdded dispatch).
   */
  const loggingProcessor = (name, emitLogEvents) => scriptProcessor(name, {
    emitLogEvents,
    script: `
      let s = null;
      function init() {
        console.log("${name} says hello into the sandbox console");
        s = stund.startEventStream("test6.heartbeat");
        s.createInstantEvent({ from: "${name}" }, Date.now());
      }
      function onEventAdded(ev) {}
      function onEventUpdated(ev) {}`,
    outputs: {
      'test6.heartbeat': {
        schemaId: 'stund://test6Heartbeat.json',
        schema: schemaFor('test6Heartbeat', { from: { type: 'string' } }, ['from']),
      },
    },
  });

  it('emits debug.processor.<name>.log events when emitLogEvents is true', async () => {
    const logs = modelEvents(socket, { types: '^debug\\.processor\\.loud0\\.log$' });
    assert.equal((await socket.request(loggingProcessor('loud0', true))).status, true);
    const heartbeats = modelEvents(socket, { types: '^test6\\.heartbeat$' });
    await heartbeats.waitFor((e) => e.data?.from === 'loud0', 15000, 'loud0 heartbeat');

    const line = await logs.waitFor((e) => e.data?.text?.includes('says hello'), 15000,
      'the console.log line as a log event');
    assert.equal(line.type, 'debug.processor.loud0.log');
  });

  it('[known-bug: emitLogEvents:false only gates the output-schema declaration in Processor.init() — Processor.log() publishes into the model unconditionally, so engine warnings and console.log lines become events anyway] keeps the session quiet when emitLogEvents is false', async () => {
    // Desired: with emitLogEvents:false, nothing the sandbox logs becomes
    // a session event. Today every line still lands in the model — the
    // flag is ignored on the emission side (Processor.java line 116).
    const logs = modelEvents(socket, { types: '^debug\\.processor\\.quiet0\\.log$' });
    assert.equal((await socket.request(loggingProcessor('quiet0', false))).status, true);
    const heartbeats = modelEvents(socket, { types: '^test6\\.heartbeat$' });
    await heartbeats.waitFor((e) => e.data?.from === 'quiet0', 15000, 'quiet0 heartbeat');
    await sleep(1000); // one coalescing delay past the heartbeat — any log
    // produced during init() has been dispatched with or before it

    assert.equal(logs.seen.length, 0,
      `emitLogEvents:false must suppress log events, but got: ${logs.seen.map((e) => e.data?.text).join(' | ')}`);
  });
});
