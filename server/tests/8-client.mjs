/**
 * SessionHistoryServer functional tests — 8. the bundled client library
 *
 * session.js is the API most consumers will actually touch. These tests
 * exercise it in a real browser against a real server: the working
 * surface (schema, processors, getEvent, ingest) and the bugs that make
 * it hang or throw today, each pinned as a [known-bug] test.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

import assert from 'node:assert/strict';
import { openPage, pageLogin, sleep } from './helpers.mjs';

const TEST_STREAM_OUTPUT = 'test8.derived';

const SRC8_PROCESSOR = {
  language: 'js', emitExceptionEvents: true, emitLogEvents: false,
  script: `
    let s = null;
    function init() { s = stund.startEventStream("${TEST_STREAM_OUTPUT}"); }
    function onEventAdded(ev) {}
    function onEventUpdated(ev) {}`,
  inputs: {},
  outputs: { [TEST_STREAM_OUTPUT]: { schemaId: 'stund://test8.json', internal: true } },
  schemas: {
    'stund://test8.json': {
      type: 'object', properties: { n: { type: 'integer' } },
      required: ['n'], additionalProperties: false,
    },
  },
};

describe('the bundled client library (session.js in a real browser)', function () {
  this.timeout(60000);

  let page;
  let sessionId;

  before(async () => {
    page = await openPage();
    // the server demands an entityKey — log the page in as the test entity
    // before the library creates the session
    await pageLogin(page, 'client-tester');
    const created = await page.evaluate(async () => {
      const spec = await fetch('application-spec.json').then((r) => r.json());
      const session = await window.SessionHistory.create(spec);
      await session.connectIngest(); // needed by the event-stream tests below
      window.__sh = { session };
      return { id: session.id, entity: session.entity };
    });
    sessionId = created.id;
    // the schema arrives as an async schemaChange push — wait for it once here
    await page.waitForFunction(() => window.__sh?.session?.schema?.processors, { timeout: 15000 });
  });

  after(async () => {
    await page.evaluate(() => { try { window.__sh?.session.websocket.close(); } catch { /* already gone */ } }).catch(() => {});
    await page.close().catch(() => {});
  });

  it('receives the session schema when it joins', async () => {
    const schema = await page.evaluate(() => window.__sh.session.schema);
    assert.equal(schema.owner, 'client-tester');
    assert.ok(schema.processors && Object.keys(schema.processors).length > 0,
      'the schema must list the default processors');
  });

  it('adds a processor and hands out its declared event schema', async () => {
    const reply = await page.evaluate((config) =>
      window.__sh.session.addProcessor('src8', 'ScriptProcessor', config), SRC8_PROCESSOR);
    assert.equal(reply.status, true, `addProcessor failed: ${JSON.stringify(reply)}`);

    const schema = await page.evaluate(() =>
      window.__sh.session.getEventDataSchema('src8', 'stund://test8.json'));
    assert.equal(schema.properties.n.type, 'integer');
  });

  it('fetches events by id through getEvent', async () => {
    const fetched = await page.evaluate(async () => {
      const model = await window.__sh.session.connectModel('history');
      // a second script processor emits one event we then fetch back
      return new Promise((resolve) => {
        model.addEventListener('eventAdded', async (event) => {
          if (event.type !== 'test8.fetchme') return;
          const reply = await window.__sh.session.getEvent(event.id);
          resolve({ id: event.id, data: reply.event.data.n, replyId: reply.event.id });
        });
        window.__sh.session.addProcessor('src8b', 'ScriptProcessor', {
          language: 'js', emitExceptionEvents: true, emitLogEvents: false,
          script: `
            let s = null;
            function init() {
              s = stund.startEventStream("test8.fetchme");
              s.createInstantEvent({ n: 42 }, Date.now());
            }
            function onEventAdded(ev) {}
            function onEventUpdated(ev) {}`,
          inputs: {},
          outputs: { 'test8.fetchme': { schemaId: 'stund://test8.json', internal: true } },
          schemas: {
            'stund://test8.json': {
              type: 'object', properties: { n: { type: 'integer' } },
              required: ['n'], additionalProperties: false,
            },
          },
        });
      });
    }, 0);
    assert.equal(fetched.data, 42);
    assert.equal(fetched.replyId, fetched.id, 'getEvent must reply with the same event id');
  });

  it('exposes a correctly-spelled timestamp helper on event streams', async () => {
    const outcome = await page.evaluate(async () => {
      const stream = await window.__sh.session.ingest.startEventStream('application.test8.chat');
      return { correct: typeof stream.getCurrentTimestamp, typo: typeof stream.getCurrentTimetamp };
    });
    assert.equal(outcome.correct, 'function',
      'the public spelling getCurrentTimestamp must exist');
  });

  it('rejects non-object event data', async () => {
    const outcome = await page.evaluate(async () => {
      const stream = await window.__sh.session.ingest.startEventStream('application.test8.chat');
      try { stream.createInstantEvent('plain string, not an object'); return 'no-throw'; }
      catch (e) { return 'threw: ' + e.message; }
    });
    assert.notEqual(outcome, 'no-throw',
      'createInstantEvent must reject non-object data');
  });

  it('survives a modelChange that removes events', async () => {
    // No server flow emits removes yet, but the handler must not blow up
    // when one arrives (it used to reference a bare `eventMap`).
    const outcome = await page.evaluate(async () => {
      const model = Object.values(window.__sh.session.models)[0];
      const anyEvent = model.events[0];
      if (!anyEvent) return 'no events to exercise the remove path with';
      try {
        model.handleChangeMessage({ add: [], remove: [anyEvent.id] });
        return 'no-throw';
      } catch (e) { return 'threw: ' + e.message; }
    });
    assert.notEqual(outcome, 'no events to exercise the remove path with',
      'the test needs at least one recorded event — earlier tests must have produced one');
    assert.equal(outcome, 'no-throw', `the remove path must not throw (got: ${outcome})`);
  });

  it('acknowledges start() for the session owner', async () => {
    const reply = await page.evaluate(() => window.__sh.session.start());
    assert.equal(reply.status, true,
      `a successful start must be acknowledged by the server, not covered by the client's give-up reply (got: ${JSON.stringify(reply)})`);
  });

  it('gives up on commands that are never answered (built-in timeout)', async () => {
    const reply = await page.evaluate(() =>
      window.__sh.session.sendWithReply({ cmd: 'definitelyNotACommand' }, 3000));
    assert.equal(reply.status, false, 'an unanswered command must be a failure, not a hang');
    assert.equal(reply.timedOut, true, 'the reply must be marked as a client-side give-up');
    assert.equal(reply.message, 'Timed out after 3000ms waiting for the reply to command definitelyNotACommand',
      'the give-up reply must say which command it waited for and how long');
  });

  it('disposes an open session without throwing', async () => {
    const outcome = await page.evaluate(() => {
      try { window.__sh.session.dispose(); return 'no-throw'; }
      catch (e) { return 'threw: ' + e.message; }
    });
    assert.equal(outcome, 'no-throw', 'dispose() must not throw on an open session');
  });
});
