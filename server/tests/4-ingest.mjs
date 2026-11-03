/**
 * SessionHistoryServer functional tests — 4. WebRTC ingest negotiation
 *
 * The raw signaling protocol before any media flows: the SDP offer the
 * server generates for requestIngestNegotiation (shape, munging, the
 * negotiation race), the ICE candidates it gathers (RTP port range), and
 * the error paths.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

import assert from 'node:assert/strict';
import { createSession, wsConnect, randomEntity, record, sleep } from './helpers.mjs';

function assertCompleteOffer(sdp, label = 'offer') {
  assert.ok(typeof sdp === 'string' && sdp.length > 100, `${label}: expected a non-trivial SDP string`);
  assert.match(sdp, /v=0/, `${label}: missing SDP header`);
  assert.match(sdp, /m=application/, `${label}: the data channel m-line is missing`);
  assert.match(sdp, /a=ice-ufrag:/, `${label}: no ICE username fragment — truncated offer?`);
  assert.match(sdp, /a=ice-pwd:/, `${label}: no ICE password — truncated offer?`);
  assert.match(sdp, /a=fingerprint:/, `${label}: no DTLS fingerprint — truncated offer?`);
  assert.match(sdp, /a=setup:active/, `${label}: the offer must force the server to initiate the data channel`);
}

describe('initial ingest negotiation', () => {
  let sessionId;
  let socket; // the one connection with a negotiated pipeline
  before(async () => {
    sessionId = await createSession('ingest-probe');
    socket = await wsConnect(sessionId, randomEntity());
  });
  after(() => socket?.close());

  it('answers requestIngestNegotiation with a complete SDP offer', async () => {
    const started = Date.now();
    const reply = await socket.request({ cmd: 'requestIngestNegotiation' }, 20000);
    record('SDP offer arrival', Date.now() - started);
    assert.equal(reply.status, true);
    assertCompleteOffer(reply.offer);
  });

  it('munges the offer: no a=ssrc, no a=msid-semantic', async () => {
    const other = await wsConnect(sessionId, randomEntity());
    const offer = (await other.request({ cmd: 'requestIngestNegotiation' }, 20000)).offer;
    assert.ok(!offer.includes('a=ssrc'), 'a=ssrc lines must be stripped from the offer');
    assert.ok(!offer.includes('a=msid-semantic'), 'a=msid-semantic must be stripped from the offer');
    other.close();
  });

  it('rejects a second ingest pipeline on the same connection', async () => {
    const reply = await socket.request({ cmd: 'requestIngestNegotiation' });
    assert.equal(reply.status, false);
    assert.match(reply.message, /already exists/);
  });

  it('[known-bug: GStreamer rejects it asynchronously, no reply is ever sent] rejects a garbage SDP answer', async () => {
    // Desired: a {status:false} reply. Today the SDP parse fails inside a
    // GStreamer callback thread (onInitialNegotiationCompleted); the client
    // just never hears back - no error reply is wired to the op. (The
    // pad-added ingest path does report failures now, via ingestError.)
    const reply = await socket.request({ cmd: 'completeIngestNegotiation', sdp: 'absolute garbage' }, 5000);
    assert.equal(reply.status, false, 'a bad SDP answer must produce an error reply, not silence');
    assert.ok(socket.isOpen, 'the connection itself must survive a bad answer');
  });

  it('rejects ICE candidates before a pipeline exists', async () => {
    const probe = await wsConnect(sessionId, randomEntity());
    const reply = await probe.request({ cmd: 'ingestICECandidate', candidate: 'candidate:1 1 UDP 2130706431 192.0.2.1 60000 typ host', sdpMLineIndex: 0 });
    // Note: today this surfaces as a NullPointerException ("this.pipeline" is
    // null in the endpoint dispatch) — the intended "non-started WebRTC"
    // guard in onInputICECandidate can never fire. A clean error message
    // would be nicer, but the status:false reply shape is the contract.
    assert.equal(reply.status, false);
    assert.ok(reply.message, 'the error reply must carry a message');
    probe.close();
  });

  it('accepts client ICE candidates on a negotiated pipeline', async () => {
    socket.websocket.send(JSON.stringify({
      op: 999, cmd: 'ingestICECandidate',
      candidate: 'candidate:1 1 UDP 2130706431 192.0.2.1 60001 typ host',
      sdpMLineIndex: 0,
    }));
    await sleep(500);
    assert.ok(socket.isOpen, 'adding an ICE candidate must not break the connection');
  });
});

describe('ICE gathering', () => {
  it('gathers host candidates inside the configured RTP port range', async () => {
    const sessionId = await createSession('ice-probe');
    const socket = await wsConnect(sessionId, randomEntity());
    assert.equal((await socket.request({ cmd: 'requestIngestNegotiation' }, 20000)).status, true);

    const deadline = Date.now() + 6000;
    const candidates = [];
    while (Date.now() < deadline && candidates.length === 0) {
      await socket.awaitMsg((m) => m.cmd === 'iceCandidate', Math.max(200, deadline - Date.now()), 'ICE candidate').then((m) => {
        candidates.push(m.candidate);
      }).catch(() => {});
    }
    // drain whatever else arrives in the next two seconds
    await sleep(2000);
    for (const msg of socket.messages) if (msg.cmd === 'iceCandidate' && !candidates.includes(msg.candidate)) candidates.push(msg.candidate);

    assert.ok(candidates.length >= 1, 'the server must gather at least one ICE candidate');
    for (const candidate of candidates) {
      assert.ok(!candidate.includes('tcptype active'), `tcp/active candidates must be filtered: ${candidate}`);
      const match = candidate.match(/ UDP \d+ (\S+) (\d+) typ (\w+)/);
      if (!match) continue; // tcp candidates that slip through differently
      const [, host, port, type] = match;
      assert.ok(+port >= 60000 && +port <= 61000, `candidate port ${port} (${type} ${host}) outside the configured RTP range 60000-61000`);
    }
    record('ICE candidates gathered', candidates.length, 'candidates');
    socket.close();
  });
});

describe('negotiation reliability (the create-data-channel race)', () => {
  // EntityIngestPipeline starts the pipeline and immediately creates the
  // data channel; when the channel creation races ahead of webrtcbin's
  // negotiation state, the emitted offer comes out truncated (no ICE
  // attributes, no m-lines) and the client can never answer. Any client
  // hitting that window never opens a data channel — connectIngest()
  // rejects on the malformed offer or, if the channel simply never opens,
  // waits without an overall cap.
  it('produces a complete offer on every negotiation', async function () {
    this.timeout(180000);
    const ROUNDS = 10;
    const malformed = [];
    const durations = [];
    for (let i = 0; i < ROUNDS; i++) {
      const sessionId = await createSession('race-probe');
      const socket = await wsConnect(sessionId, `race-${i}`);
      const started = Date.now();
      try {
        const reply = await socket.request({ cmd: 'requestIngestNegotiation' }, 20000);
        durations.push(Date.now() - started);
        try {
          assert.equal(reply.status, true, `round ${i}: reply carried an error: ${reply.message}`);
          assertCompleteOffer(reply.offer, `round ${i}`);
        } catch (failure) {
          malformed.push(`round ${i}: ${failure.message.split('\n')[0]}`);
        }
      } finally {
        socket.close();
      }
    }
    for (const ms of durations) record('SDP offer arrival', ms);
    assert.deepEqual(malformed, [], `${malformed.length} of ${ROUNDS} negotiations produced a broken offer`);
  });
});
