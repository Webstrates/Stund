/**
 * SessionHistoryServer functional tests — 5. browser ingest (puppeteer)
 *
 * The full round trip through the bundled client library in a real
 * Chromium: create a session, negotiate WebRTC (offer/answer/ICE/DTLS),
 * send events over the data channel, and record the fake camera +
 * microphone into server-side Matroska tracks that are HTTP-servable
 * while they are still growing.
 *
 * Needs a server and a Chromium with --use-fake-device-for-media-stream
 * (the getBrowser() helper passes those flags; see README.md).
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

import assert from 'node:assert/strict';
import {
  BASE_URL, openPage, pageLogin, login, wsConnect, modelEvents, record, randomEntity, sleep,
} from './helpers.mjs';

const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];

describe('browser ingest via the bundled client library (puppeteer, fake media)', function () {
  this.timeout(60000);

  let page;        // one tab on the server origin, session.js loaded
  let observer;    // node-side raw socket subscribed to the history model
  let chat;        // collector: application.test.chat (field "add")
  let chatUpdates; // collector: application.test.chat (field "update")
  let camTracks;   // collector: user.test.cam.* track events
  let sessionId;
  let videoTrackId;

  before(async function () {
    this.timeout(120000); // retries against the negotiation race

    // The negotiation race can leave a fresh join
    // with no working data channel. The client gives up on individual
    // commands (5s default, 15s for the negotiation round trips) — but
    // nothing caps the join as a whole (the create POST, the websocket
    // open, the data-channel wait), and page.evaluate has no timeout
    // either. So: race the join against a wall clock, probe the data
    // channel with one instant event, and retry — counting the defeats
    // as a measurement, the same way the demo tests do.
    const withTimeout = (promise, ms, what) => Promise.race([
      promise,
      sleep(ms).then(() => { throw new Error(`timed out after ${ms}ms: ${what}`); }),
    ]);

    let created;
    for (let attempt = 1; ; attempt++) {
      try {
        page = await openPage();
        // the server demands an entityKey — log the page in as the ingest
        // entity before the library creates the session
        await pageLogin(page, 'browser-tester');
        created = await withTimeout(page.evaluate(async () => {
          const t0 = performance.now();
          // the application.* streams below need the application0 router
          const spec = await fetch('application-spec.json').then((r) => r.json());
          const session = await window.SessionHistory.create(spec);
          const t1 = performance.now();
          const ingest = await session.connectIngest();
          window.__sh = { session, ingest };
          return { id: session.id, msCreate: t1 - t0, msIngest: performance.now() - t1 };
        }), 30000, 'create + connectIngest (negotiation race?)');
        sessionId = created.id;

        observer = await wsConnect(sessionId, randomEntity('observer'));
        assert.equal((await observer.request({ cmd: 'connectModel', model: 'history' })).status, true);
        chat = modelEvents(observer, { types: '^application\\.test\\.chat$' });
        chatUpdates = modelEvents(observer, { types: '^application\\.test\\.chat$', field: 'update' });
        camTracks = modelEvents(observer, { types: '^user\\.test\\.cam\\.' });

        await withTimeout(page.evaluate(async () => {
          window.__sh.chat = await window.__sh.session.ingest.startEventStream('application.test.chat');
          window.__sh.chat.createInstantEvent({ text: 'join probe', n: 0 });
        }), 20000, 'startEventStream on the probe channel');
        await chat.waitFor((e) => e.data?.n === 0, 8000, 'the join probe event');
        break; // healthy join
      } catch (err) {
        record('browser joins defeated by the ingest negotiation race', 1, 'joins');
        await page?.evaluate(() => window.__sh?.session.websocket.close()).catch(() => {});
        await page?.close().catch(() => {});
        observer?.close();
        if (attempt >= 3) throw err;
      }
    }

    record('browser: create + join session', created.msCreate);
    record('browser: connectIngest (offer → answer → ICE → DTLS → channel open)', created.msIngest);
  });

  after(async () => {
    await page.evaluate(() => window.__sh?.session.websocket.close()).catch(() => {});
    observer?.close();
    await page.close().catch(() => {});
  });

  it('creates a session and opens the ingest data channel', () => {
    assert.match(sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      'session id must be a UUID');
  });

  it('sends an instant event that reaches the history model', async () => {
    const sentAt = Date.now();
    await page.evaluate(async () => {
      window.__sh.chat = await window.__sh.session.ingest.startEventStream('application.test.chat');
      window.__sh.chat.createInstantEvent({ text: 'hello from the browser', n: 1 });
    });
    const event = await chat.waitFor((e) => e.data?.n === 1, 20000, 'chat event in the model');
    record('browser: data-channel event → modelChange', Date.now() - sentAt);

    assert.equal(event.type, 'application.test.chat');
    assert.equal(event.entity, 'browser-tester', 'ingested events carry the ingest entity');
    assert.ok(Math.abs(event.start - sentAt) < 15000,
      `the relative channel timestamp must be translated to wall-clock (start=${event.start}, sent=${sentAt})`);
  });

  it("[known-bug: data-channel events whose type matches no processor input are persisted to the track file but never enter the model — EntityIngestPipeline's 'TODO: Validate data against session schema' leaves them silently invisible] makes uncovered event types visible in the model", async () => {
    // The default EventStreamProcessor (application0) tails event tracks
    // back into the session only when its input regex matches the stream
    // type (application\.(.*) by default). A stream named outside that
    // namespace is written to disk perfectly — and then never dispatched:
    // no model event, no replay, no getEvent, and no error anywhere.
    // Desired: uncovered types reach the model like covered ones do (or
    // the server rejects them loudly instead of hiding them).
    await page.evaluate(async () => {
      window.__sh.orphan = await window.__sh.session.ingest.startEventStream('test5.orphan');
      window.__sh.orphan.createInstantEvent({ text: 'anybody there?', n: 1 });
    });
    const orphans = modelEvents(observer, { types: '^test5\\.orphan$' });
    await sleep(2500); // give the tailing reader every chance to misbehave
    assert.equal(orphans.seen.length, 1,
      `an event stream outside every processor input must still surface in the model; got ${orphans.seen.length} (the event IS on disk in the track file)`);
  });

  it('delivers a burst of 10 events within a few seconds', async () => {
    const sentAt = Date.now();
    await page.evaluate(() => {
      for (let i = 0; i < 10; i++) window.__sh.chat.createInstantEvent({ text: 'burst', n: 100 + i });
    });
    await chat.waitFor((e) => e.data?.n === 109, 20000, 'the 10th burst event');
    const latency = Date.now() - sentAt;
    record('browser: 10-event burst → modelChange', latency);
    assert.ok(latency < 5000, `10 events took ${latency}ms to surface — too slow for a live UI`);
  });

  it('runs a duration event through update and close on a single id', async () => {
    await page.evaluate(async () => {
      const ev = window.__sh.chat.createDurationEvent({ phase: 'begin' });
      await new Promise((r) => setTimeout(r, 150));
      ev.update({ phase: 'middle' });
      await new Promise((r) => setTimeout(r, 150));
      ev.update({ phase: 'end' });
      ev.stop();
    });
    const closed = await chatUpdates.waitFor(
      (e) => e.data?.phase === 'end' && e.tentative !== true, 20000, 'closed duration event');
    // note: the client's stop() sends tentative:undefined (dropped by
    // JSON.stringify), so a client-closed event arrives without the key —
    // "closed" on the wire is tentative !== true, not === false.
    assert.ok(closed.end > closed.start, 'a closed duration event must carry end > start');
    // the collectors span the whole file, so scope to this test's event:
    // the invariant is that its add and its updates all share ONE id
    assert.ok(chat.seen.some((e) => e.id === closed.id), 'the duration event must be added');
    assert.ok(chatUpdates.seen.some((e) => e.id === closed.id),
      'its updates must reuse the same id instead of creating new events');
  });

  it('records fake camera + microphone into server-side Matroska tracks', async () => {
    const started = Date.now();
    await page.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      await window.__sh.session.ingest.startMediaStream('user.test.cam', stream);
      window.__sh.cam = stream;
    });
    const video = await camTracks.waitFor((e) => e.type === 'user.test.cam.video', 30000, 'video track event');
    const audio = await camTracks.waitFor((e) => e.type === 'user.test.cam.audio', 30000, 'audio track event');
    record('browser: startMediaStream → track events', Date.now() - started);
    videoTrackId = video.id;

    assert.equal(video.entity, 'browser-tester');
    assert.equal(audio.entity, 'browser-tester');
  });

  it('serves the live recording as a growing HTTP stream while it records', async () => {
    const reply = await observer.request({ cmd: 'getEvent', id: videoTrackId, options: { includeMeta: true } });
    assert.equal(reply.status, true, `getEvent on the track failed: ${reply.message}`);
    const resource = reply.event.track.resource;
    assert.match(resource, /^user\.test\.cam\.video_.*\.(vp8|vp9|h264)\.mkv$/,
      `unexpected track resource name: ${resource}`);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 2500); // read the live tail for 2.5s, then stop
    // media URLs carry the entityKey (media elements cannot send headers)
    const response = await fetch(
      `${BASE_URL}/session/${sessionId}/media/${resource}?entityKey=${encodeURIComponent(await login('browser-reader'))}`,
      { signal: controller.signal });
    assert.equal(response.status, 200, 'the track must be served while still recording');

    let bytes = 0;
    let magic = null;
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!magic && value && value.length >= 4) magic = Array.from(value.slice(0, 4));
        bytes += value ? value.length : 0;
      }
    } catch (err) {
      assert.equal(err.name, 'AbortError', `the read should end via our abort, not: ${err.message}`);
    }
    record('browser: bytes served from the live track in 2.5s', bytes, 'bytes');
    assert.deepEqual(magic, EBML_MAGIC, 'a Matroska file must start with the EBML magic bytes');
    assert.ok(bytes > 0, 'the live tail must deliver bytes while the track grows');
  });

  it('[known-bug: stopMediaStream is invisible to the server — it only stops local tracks and calls removeTrack, nothing ever reaches GStreamer] closes the track event when the media stream stops', async () => {
    // Desired: the track event stops being tentative when the client stops
    // the media stream. Today session.js sends no message and no
    // renegotiation, so the server never learns about it.
    await page.evaluate(() => window.__sh.session.ingest.stopMediaStream(window.__sh.cam));
    const trackUpdates = modelEvents(observer, { types: '^user\\.test\\.cam\\.video$', field: 'update' });
    await trackUpdates.waitFor((e) => e.id === videoTrackId && e.tentative !== true, 20000, 'closed track event');
  });

  it('[known-bug: no code path ever stamps end/tentative=false on a media track event — onCompleted only feeds the transcription listener] closes the track events when the ingest connection goes away', async () => {
    // Dropping the websocket tears down the GStreamer pipeline and EOS-es
    // the muxers (the files are finalized), but the track EVENTS stay
    // tentative in the model forever.
    await page.evaluate(() => window.__sh.session.websocket.close());
    const trackUpdates = modelEvents(observer, { types: '^user\\.test\\.cam\\.(video|audio)$', field: 'update' });
    await trackUpdates.waitFor((e) => e.tentative !== true, 20000, 'closed track events');
  });

  it('serves the recordings to completion once the ingest connection is gone', async () => {
    // The practical close path today: pipeline teardown flushes the
    // Matroska files, and a plain fetch reads them back to a finite end.
    // (The teardown includes a hardcoded 2s flush delay — give it room.)
    await sleep(4000);
    const reply = await observer.request({ cmd: 'getEvent', id: videoTrackId, options: { includeMeta: true } });
    assert.equal(reply.status, true, `getEvent on the track failed: ${reply.message}`);
    const response = await fetch(
      `${BASE_URL}/session/${sessionId}/media/${reply.event.track.resource}?entityKey=${encodeURIComponent(await login('browser-reader'))}`);
    assert.equal(response.status, 200);
    const buffer = new Uint8Array(await response.arrayBuffer());
    record('browser: cam.video track size after teardown', buffer.byteLength, 'bytes');
    assert.deepEqual(Array.from(buffer.slice(0, 4)), EBML_MAGIC);
    assert.ok(buffer.byteLength > 500,
      `expected a real Matroska recording, got ${buffer.byteLength} bytes`);
  });
});
