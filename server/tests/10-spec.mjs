/**
 * SessionHistoryServer functional tests — 10. session specs
 *
 * The client-supplied session blueprint: POST /session demands {spec} — the
 * processors to install (exactly the addProcessor wire shape, so anything a
 * spec leaves out falls back to the config class's field-initializer
 * default) plus the models to gather events. Bookkeeping (owner, created,
 * start, end) is painted by the server from the entityKey, never taken from
 * the body. The generic starting point is served at /default-spec.json, the
 * reference app's vocabulary at /application-spec.json.
 *
 * The restart tests spawn their own servers (schema.udta reload and the
 * BrokenProcessor preservation for entries whose class no longer parses)
 * and are skipped when no jar/TEN VAD is available, like 7-replay.
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
  applicationSpec, createSession, getRaw, login, postJSON, randomEntity,
  requireMasterPassword, spawnServer, wsConnect, modelEvents, BASE_URL, REPO_ROOT,
} from './helpers.mjs';

/** A valid but empty spec — a bare session with no processors and no models. */
const BARE_SPEC = { processors: [], models: [] };

/** The broadcast schema of a connected socket (the immediate schemaChange). */
const schemaOf = (socket) =>
  socket.awaitMsg((m) => m.cmd === 'schemaChange', 10000, 'schemaChange').then((m) => m.schema);

/**
 * The minimal custom spec used by the restart tests: one sandboxed script
 * processor (harmless init, one output) and one model reading it. Small on
 * purpose — what must survive the schema.udta round-trip is its shape, not
 * its size.
 */
const TINY_SPEC = {
  processors: [{
    name: 'tiny0', type: 'ScriptProcessor',
    config: {
      language: 'js', emitExceptionEvents: true, emitLogEvents: false,
      script: `
        let s = null;
        function init() { s = stund.startEventStream("tiny.out"); }
        function onEventAdded(ev) {}
        function onEventUpdated(ev) {}`,
      inputs: { 'tiny\\.(.*)': {} },
      outputs: { 'tiny.out': { schemaId: 'stund://tinyOut.json', internal: true } },
      schemas: {
        'stund://tinyOut.json': {
          type: 'object', properties: { n: { type: 'integer' } },
          required: ['n'], additionalProperties: false,
        },
      },
    },
  }],
  models: [{ name: 'm', config: { inputs: { 'tiny\\.(.*)': {} } } }],
};

describe('session specs (the client-supplied session setup)', () => {
  it('rejects a spec-less create with 400 and points at the served specs', async function () {
    requireMasterPassword(this);
    const { status, text } = await postJSON('/session', {}, { entity: randomEntity('spec-less') });
    assert.equal(status, 400);
    assert.match(text, /Must provide a session spec/);
    assert.match(text, /\/default-spec\.json/, 'the error must point at the generic starting point');
    assert.match(text, /\/application-spec\.json/, 'and at the reference app setup');
    assert.ok(!text.includes('at dk.cavi'), 'Java stack trace leaked to the client:\n' + text.slice(0, 400));
  });

  it('accepts an empty spec for a bare session (201)', async function () {
    requireMasterPassword(this);
    const { status, json } = await postJSON('/session', { spec: BARE_SPEC }, { entity: randomEntity('bare') });
    assert.equal(status, 201);
    assert.match(json.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('rejects an unknown processor type with 400', async function () {
    requireMasterPassword(this);
    const { status, text } = await postJSON('/session', { spec: {
      processors: [{ name: 'nope0', type: 'NoSuchProcessor', config: { inputs: { 'x\\.(.*)': {} } } }],
      models: [],
    } }, { entity: randomEntity('bad-type') });
    assert.equal(status, 400);
    assert.match(text, /NoSuchProcessor/);
    assert.ok(!text.includes('at dk.cavi'), 'stack trace leaked:\n' + text.slice(0, 400));
  });

  it('rejects invalid input patterns with 400 (processor and model)', async function () {
    requireMasterPassword(this);
    const entity = randomEntity('bad-regex');
    const processorRegex = await postJSON('/session', { spec: {
      processors: [{ name: 'r0', type: 'ScriptProcessor', config: { inputs: { '(': {} } } }],
      models: [],
    } }, { entity });
    assert.equal(processorRegex.status, 400);
    assert.match(processorRegex.text, /invalid input pattern/);

    const modelRegex = await postJSON('/session', { spec: {
      processors: [],
      models: [{ name: 'm', config: { inputs: { '[': {} } } }],
    } }, { entity });
    assert.equal(modelRegex.status, 400);
    assert.match(modelRegex.text, /invalid input pattern/);
  });

  it('rejects the same invalid input pattern over ws addProcessor (clean reply, nothing half-installed, dispatch intact)', async function () {
    requireMasterPassword(this);
    const sessionId = await createSession(randomEntity('ws-bad-regex'));
    const socket = await wsConnect(sessionId, randomEntity('ws-bad-regex'));
    try {
      assert.equal((await socket.request({ cmd: 'connectModel', model: 'history' })).status, true);

      // The exact input pattern the 400 test above rejects: the ws command
      // used to accept it with status:true, and the installed processor then
      // threw PatternSyntaxException inside event dispatch
      // (Processor.matchesStreamType) on every later event.
      const reply = await socket.request({
        cmd: 'addProcessor', name: 'r1', type: 'ScriptProcessor',
        config: { language: 'js', script: 'function onEventAdded(ev){}', inputs: { '(': {} } },
      });
      assert.equal(reply.status, false, 'the ws command must reject what the spec path rejects');
      assert.match(reply.message, /invalid input pattern/);
      assert.match(reply.message, /r1/);

      // A good processor still installs, and its init-time emission runs the
      // exact dispatch loop the bad processor used to poison - the event must
      // reach the history model.
      const emitted = modelEvents(socket, { types: '^spec10\\.pingok$' });
      const good = await socket.request({
        cmd: 'addProcessor', name: 'wsok0', type: 'ScriptProcessor',
        config: {
          language: 'js', emitExceptionEvents: true,
          script: `
            let s = null;
            function init() {
              s = stund.startEventStream("spec10.pingok");
              s.createInstantEvent({ n: 1 }, Date.now());
            }
            function onEventAdded(ev) {}
            function onEventUpdated(ev) {}`,
          inputs: {},
          outputs: { 'spec10.pingok': { schemaId: 'stund://spec10Pingok.json', internal: true } },
          schemas: {
            'stund://spec10Pingok.json': {
              type: 'object', properties: { n: { type: 'integer' } },
              required: ['n'], additionalProperties: false,
            },
          },
        },
      });
      assert.equal(good.status, true, 'a valid processor must still install after a rejected one');
      const event = await emitted.waitFor(() => true, 15000, 'spec10.pingok event through the history model');
      assert.equal(event.data.n, 1);

      // ...and stored, not just broadcast: onEventAdded notifies the models
      // before the processor loop and before currentEvents.put, so a poisoned
      // dispatch broadcasts the event yet never stores it (the pre-fix
      // behavior: getEvent answered "No such event").
      const fetched = await socket.request({ cmd: 'getEvent', id: event.id });
      assert.equal(fetched.status, true, 'the emitted event must be stored, not just broadcast');
      assert.equal(fetched.event.data.n, 1);

      // The schema broadcast that carried the good add must not contain the
      // rejected one - nothing was half-installed.
      const schema = await socket.awaitMsg(
        (m) => m.cmd === 'schemaChange' && m.schema.processors && m.schema.processors.wsok0,
        10000, 'schemaChange carrying wsok0');
      assert.ok(!schema.schema.processors.r1, 'the rejected processor must not appear in the schema');
    } finally {
      socket?.close();
    }
  });

  it('rejects duplicate processor and model names with 400', async function () {
    requireMasterPassword(this);
    const entity = randomEntity('dupes');
    const script = { language: 'js', script: 'function onEventAdded(ev){}', inputs: {} };
    const processors = await postJSON('/session', { spec: {
      processors: [
        { name: 'dup0', type: 'ScriptProcessor', config: script },
        { name: 'dup0', type: 'ScriptProcessor', config: script },
      ],
      models: [],
    } }, { entity });
    assert.equal(processors.status, 400);
    assert.match(processors.text, /duplicate processor name 'dup0'/);

    const models = await postJSON('/session', { spec: {
      processors: [],
      models: [
        { name: 'm', config: { inputs: { 'a\\.(.*)': {} } } },
        { name: 'm', config: { inputs: { 'a\\.(.*)': {} } } },
      ],
    } }, { entity });
    assert.equal(models.status, 400);
    assert.match(models.text, /duplicate model name 'm'/);
  });

  it('rejects an output whose schemaId has no schema in the registry with 400', async function () {
    requireMasterPassword(this);
    const { status, text } = await postJSON('/session', { spec: {
      processors: [{
        name: 'unwired0', type: 'EventStreamProcessor',
        config: {
          inputs: { 'a\\.(.*)': {} },
          outputs: { 'a.b': { schemaId: 'stund://never-registered.json', internal: true } },
          schemas: {},
        },
      }],
      models: [],
    } }, { entity: randomEntity('unwired') });
    assert.equal(status, 400);
    assert.match(text, /No such schema id in registry/);
  });

  it('rejects malformed model fields paths with 400', async function () {
    requireMasterPassword(this);
    const entity = randomEntity('bad-path');
    const cases = [
      [{ fields: ['text'] }, /fields path 'text': .*dot-separated data keys/],
      [{ fields: ['$.text', null] }, /null entry in its fields filter/],
      [{ fields: ['$'] }, /the '\$' path addresses the whole data object/],
      [{ fields: ['$.keep.*b'] }, /'\*' wildcard is a whole segment/],
      [{ fields: ['$.a..b'] }, /a fields path segment is empty/],
      [null, /carries no specification/],
    ];
    for (const [specification, message] of cases) {
      const { status, text } = await postJSON('/session', { spec: {
        processors: [],
        models: [{ name: 'm', config: { inputs: { 'a\\.(.*)': specification } } }],
      } }, { entity });
      assert.equal(status, 400, `expected 400 for input ${JSON.stringify(specification)}`);
      assert.match(text, message);
      assert.ok(!text.includes('at dk.cavi'), `stack trace leaked for ${JSON.stringify(specification)}:\n` + text.slice(0, 400));
    }
  });

  it('accepts an empty fields list — an envelope-only model', async function () {
    requireMasterPassword(this);
    const { status } = await postJSON('/session', { spec: {
      processors: [],
      models: [{ name: 'm', config: { inputs: { 'a\\.(.*)': { fields: [] } } } }],
    } }, { entity: randomEntity('vad-feed') });
    assert.equal(status, 201, 'an empty fields list is a valid envelope-only filter');
  });

  it('falls back to config-class defaults for omitted fields (VAD: threshold + built-in output)', async function () {
    // The spec entry carries ONLY the input pattern — everything else must
    // come from TENVadConfig's field initializers: threshold 0.6, the
    // deactivate delay, and the built-in processor.voicedetect output with
    // its tenvadEvent schema.
    requireMasterPassword(this);
    const entity = randomEntity('vad-defaults');
    const sessionId = await createSession(entity, { spec: {
      processors: [{ name: 'vad0', type: 'VoiceActivationProcessor', config: { inputs: { 'user\\.(.*)\\.audio': {} } } }],
      models: [],
    } });
    const socket = await wsConnect(sessionId, entity);
    try {
      const schema = await schemaOf(socket);
      const vad = schema.processors.vad0;
      assert.ok(vad, 'the spec-built processor is in the schema');
      assert.equal(vad.type, 'VoiceActivationProcessor');
      assert.equal(vad.config.threshold, 0.6, 'the omitted threshold falls back to the class default');
      assert.equal(vad.config.deactivateDelayMS, 200, 'so does the omitted deactivate delay');
      assert.ok(vad.config.outputs['processor.voicedetect'], 'the built-in output survives an omitted outputs map');
      assert.ok(vad.config.schemas['stund://tenvadEvent.json'], 'the built-in schema is registered');
      assert.ok(vad.config.schemas['stund://tenvadEvent.json'].properties.maxSegment,
        'the schema matches what the VAD actually stamps - maxSegment is declared');
      assert.ok(vad.config.schemas['stund://tenvadEvent.json'].required.includes('maxSegment'),
        'and required, since every speech-segment event carries it');
    } finally { socket.close(); }
  });

  it('gives the spec-built transcription processor its built-in output (the no-arg ctor regression)', async function () {
    // TranscriptionConfig's Gson-default construction used to leave the
    // outputs map empty: every completed speech segment paid for a whisper
    // call and then threw NoSuchElementException - zero transcription
    // events, ever, with any spec that omits outputs (both shipped ones).
    // The built-in output is now registered at init from the config-class
    // default, exactly like the VAD's.
    requireMasterPassword(this);
    const entity = randomEntity('tr-defaults');
    const sessionId = await createSession(entity, { spec: {
      processors: [{ name: 'tr0', type: 'AITranscriptionProcessor', config: { inputs: { 'processor\\.voicedetect': {} } } }],
      models: [],
    } });
    const socket = await wsConnect(sessionId, entity);
    try {
      const schema = await schemaOf(socket);
      const tr = schema.processors.tr0;
      assert.ok(tr, 'the spec-built processor is in the schema');
      assert.equal(tr.type, 'AITranscriptionProcessor');
      assert.ok(tr.config.outputs['processor.transcription'],
        'the built-in output survives an omitted outputs map');
      assert.equal(tr.config.outputs['processor.transcription'].schemaId, 'stund://openAITranscription.json',
        'with the server-controlled schema attached');
      assert.ok(tr.config.schemas['stund://openAITranscription.json'], 'the built-in schema is registered');
    } finally { socket.close(); }
  });

  it('honors a client-chosen built-in output name and rewires the voice pipeline', async function () {
    // The client controls the base name of a processor's built-in output:
    // renaming the VAD stream to custom.vad and pointing the transcription
    // input at it keeps the pipeline wired without any server-side coupling.
    requireMasterPassword(this);
    const entity = randomEntity('vad-custom');
    const sessionId = await createSession(entity, { spec: {
      processors: [
        { name: 'vad0', type: 'VoiceActivationProcessor', config: {
          inputs: { 'user\\.(.*)\\.audio': {} }, outputStreamType: 'custom.vad' } },
        { name: 'tr0', type: 'AITranscriptionProcessor', config: { inputs: { 'custom\\.vad': {} } } },
      ],
      models: [],
    } });
    const socket = await wsConnect(sessionId, entity);
    try {
      const schema = await schemaOf(socket);
      const vad = schema.processors.vad0;
      assert.ok(vad.config.outputs['custom.vad'], 'the built-in output is registered under the client-chosen name');
      assert.equal(vad.config.outputs['custom.vad'].schemaId, 'stund://tenvadEvent.json',
        'the server-controlled schema stays attached to it');
      assert.ok(!vad.config.outputs['processor.voicedetect'], 'the default name is replaced, not duplicated');
      assert.equal(vad.config.outputStreamType, 'custom.vad', 'the chosen name is part of the config');
      assert.ok(schema.processors.tr0.config.inputs['custom\\.vad'], 'the downstream transcription is rewired to it');
    } finally { socket.close(); }
  });

  it('re-registers the built-in output even when the spec sends an explicit empty outputs map', async function () {
    // A present-but-empty outputs key used to replace the whole map and
    // silently kill the built-in (only an omitted map left it standing).
    requireMasterPassword(this);
    const entity = randomEntity('vad-empty-outputs');
    const sessionId = await createSession(entity, { spec: {
      processors: [{ name: 'vad0', type: 'VoiceActivationProcessor', config: {
        inputs: { 'user\\.(.*)\\.audio': {} }, outputs: {} } }],
      models: [],
    } });
    const socket = await wsConnect(sessionId, entity);
    try {
      const schema = await schemaOf(socket);
      assert.ok(schema.processors.vad0.config.outputs['processor.voicedetect'],
        'the built-in output is re-registered after the JSON binding');
    } finally { socket.close(); }
  });

  it('gives prompt and vision processors their built-in text output (an inputs-only config used to be a silent no-op)', async function () {
    // The tool-calling AI processors had no built-in output: a config
    // without client-declared outputs was accepted and then could only ever
    // doNothing (an empty output enum for the LLM). Each now always emits
    // plain text notes on its own built-in stream.
    requireMasterPassword(this);
    const entity = randomEntity('ai-builtins');
    const sessionId = await createSession(entity, { spec: {
      processors: [
        { name: 'prompt0', type: 'AIPromptProcessor', config: {
          inputs: { 'processor\\.transcription': {} }, prompt: 'Summarize what is being said as it is said.' } },
        { name: 'vision0', type: 'AIVisionProcessor', config: {
          inputs: { 'user\\.(.*)\\.video': {} }, intervalSeconds: 10, prompt: 'Describe what you see.' } },
      ],
      models: [],
    } });
    const socket = await wsConnect(sessionId, entity);
    try {
      const schema = await schemaOf(socket);
      const prompt = schema.processors.prompt0.config;
      assert.ok(prompt.outputs['processor.prompt'], 'the prompt processor emits on its built-in text stream by default');
      assert.equal(prompt.outputs['processor.prompt'].schemaId, 'stund://aiTextEvent.json');
      assert.ok(prompt.schemas['stund://aiTextEvent.json'], 'the shared text schema is registered');
      const vision = schema.processors.vision0.config;
      assert.ok(vision.outputs['processor.vision'], 'the vision processor has its own built-in text stream');
      assert.equal(vision.outputs['processor.vision'].schemaId, 'stund://aiTextEvent.json');
      assert.ok(!vision.outputs['processor.prompt'], 'distinct defaults keep the two AI streams separate');
    } finally { socket.close(); }
  });

  it('rejects an invalid built-in output name with 400 (null, blank, path-unsafe, self-ingesting)', async function () {
    requireMasterPassword(this);
    const entity = randomEntity('bad-output-name');
    const cases = [
      [null, /must be a non-empty string/],
      ['', /must be a non-empty string/],
      ['a/b', /must not contain '\/' or '\.\.'/],
      ['x/../y', /must not contain '\/' or '\.\.'/],
      // the flat output name matching an input pattern is the recursion case:
      // the VAD would ingest its own derived track forever. (Note: 'user.me.vad'
      // would NOT match user\.(.*)\.audio — the pattern needs the .audio suffix.)
      ['user.me.audio', /matches this processor's own input .* would re-ingest/],
    ];
    for (const [outputStreamType, message] of cases) {
      const { status, text } = await postJSON('/session', { spec: {
        processors: [{ name: 'vad0', type: 'VoiceActivationProcessor', config: {
          inputs: { 'user\\.(.*)\\.audio': {} }, outputStreamType } }],
        models: [],
      } }, { entity });
      assert.equal(status, 400, `expected 400 for outputStreamType ${JSON.stringify(outputStreamType)}`);
      assert.match(text, message);
      assert.ok(!text.includes('at dk.cavi'), `stack trace leaked for ${JSON.stringify(outputStreamType)}:\n` + text.slice(0, 400));
    }
  });

  it('paints the owner from the entityKey — body bookkeeping fields are ignored', async function () {
    requireMasterPassword(this);
    const entity = randomEntity('painted-owner');
    const entityKey = await login(entity);
    const { status, json } = await postJSON('/session', {
      // smuggled bookkeeping — the spec DTO is closed, none of this lands
      spec: BARE_SPEC, owner: 'someone-else', created: 0, start: 123, end: 456,
      serverVersion: '0.0.0-evil',
    }, { baseUrl: BASE_URL, entityKey });
    assert.equal(status, 201);
    const socket = await wsConnect(json.sessionId, entity);
    try {
      const schema = await schemaOf(socket);
      assert.equal(schema.owner, entity, 'the owner is the authenticated token\'s entity');
      assert.ok(schema.created > 0 && schema.created <= Date.now(), 'created is painted by the server, not the body');
      assert.ok(!('start' in schema), 'start is not taken from the body');
      assert.ok(!('end' in schema), 'end is not taken from the body');
      assert.ok(schema.serverVersion, 'the server stamps its own version');
      assert.notEqual(schema.serverVersion, '0.0.0-evil');
    } finally { socket.close(); }
  });

  it('builds exactly the spec the client sends (custom tiny spec)', async function () {
    requireMasterPassword(this);
    const entity = randomEntity('tiny');
    const sessionId = await createSession(entity, { spec: TINY_SPEC });
    const socket = await wsConnect(sessionId, entity);
    try {
      const schema = await schemaOf(socket);
      assert.deepEqual(Object.keys(schema.processors), ['tiny0'], 'no implicit processors appear');
      assert.deepEqual(Object.keys(schema.models), ['m'], 'no implicit models appear');
      assert.equal(schema.owner, entity);
      const tiny = schema.processors.tiny0;
      assert.equal(tiny.type, 'ScriptProcessor');
      assert.ok(tiny.config.inputs['tiny\\.(.*)'], 'the declared input pattern is installed');
      assert.ok(tiny.config.outputs['tiny.out'], 'the declared output is installed');
      assert.ok(tiny.config.schemas['stund://tinyOut.json'], 'the declared schema is registered');
      assert.deepEqual(schema.models.m.config.inputs, { 'tiny\\.(.*)': {} });
    } finally { socket.close(); }
  });

  it('creates the reference-app session from the application spec (the setup the suite assumes)', async function () {
    requireMasterPassword(this);
    const entity = randomEntity('app-spec');
    const sessionId = await createSession(entity, { spec: await applicationSpec() });
    const socket = await wsConnect(sessionId, entity);
    try {
      const schema = await schemaOf(socket);
      assert.deepEqual(Object.keys(schema.processors).sort(), ['application0', 'transcription0', 'voicedetect0']);
      assert.deepEqual(Object.keys(schema.models), ['history']);
      assert.deepEqual(schema.models.history.config.inputs, { '.*': {} });
      const outputs = Object.keys(schema.processors.application0.config.outputs);
      assert.ok(outputs.includes('application.interaction.shape.textChanged'));
      assert.ok(outputs.includes('application.interaction.shape.colorChanged'),
        'the color change is its own event type now, not a second textChanged registration');
    } finally { socket.close(); }
  });

  it('serves the generic default spec without application.* events, and the app spec with them', async () => {
    const [generic, application] = await Promise.all([
      getRaw('/default-spec.json').then((r) => r.json()),
      getRaw('/application-spec.json').then((r) => r.json()),
    ]);
    // the served assets are exactly the repo files
    assert.deepEqual(generic, JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'src/main/webapp/default-spec.json'), 'utf8')),
      'the served /default-spec.json must match the repo copy');
    assert.deepEqual(application, JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'src/main/webapp/application-spec.json'), 'utf8')),
      'the served /application-spec.json must match the repo copy');

    // the generic default: the voice pipeline + history, no application vocabulary
    assert.deepEqual(generic.processors.map((p) => p.name), ['voicedetect0', 'transcription0']);
    assert.deepEqual(generic.models.map((m) => m.name), ['history']);
    const genericOutputs = generic.processors.flatMap((p) => Object.keys(p.config?.outputs || {}));
    assert.equal(genericOutputs.filter((o) => o.startsWith('application.')).length, 0,
      `the generic default must not carry application.* events (found ${genericOutputs.join(', ')})`);

    // the application spec: the reference app's vocabulary, split text/color changes included
    const app0 = application.processors.find((p) => p.name === 'application0');
    assert.ok(app0, 'the application spec carries the application0 entry');
    const outputs = Object.keys(app0.config.outputs);
    assert.equal(outputs.filter((o) => o.startsWith('application.')).length, 10,
      'ten application.* outputs — the reference app\'s complete vocabulary');
    assert.ok(outputs.includes('application.interaction.shape.textChanged'), 'the text-edit event');
    assert.ok(outputs.includes('application.interaction.shape.colorChanged'),
      'the color-change event (the duplicate registration, split into its own type)');
    assert.equal(Object.keys(app0.config.schemas).length, 11, 'eleven schemas (10 named + the bare shape schema)');
  });
});

describe('schema.udta reload (spawned servers)', () => {
  /** The tiny spec's emitter plus a filtered model, for the field-filter round-trip. */
  const FIELDS_SPEC = {
    processors: [{
      name: 'tiny0', type: 'ScriptProcessor',
      config: {
        language: 'js', emitExceptionEvents: true,
        script: `
          let s = null;
          function init() { s = stund.startEventStream("tiny.out"); s.createInstantEvent({ n: 1 }, Date.now()); }
          function onEventAdded(ev) {}
          function onEventUpdated(ev) {}`,
        inputs: { 'tiny\\.(.*)': {} },
        outputs: { 'tiny.out': { schemaId: 'stund://tinyOut.json', internal: true } },
        schemas: {
          'stund://tinyOut.json': {
            type: 'object', properties: { n: { type: 'integer' } },
            required: ['n'], additionalProperties: false,
          },
        },
      },
    }],
    models: [{ name: 'm', config: { inputs: { 'tiny\\.(.*)': { fields: ['$.n'] } } } }],
  };

  it('round-trips a model field filter through schema.udta', async function () {
    this.timeout(240000);
    const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'shs-spec-fields-'));
    let serverA = null;
    let serverB = null;
    let socket = null;
    try {
      serverA = await spawnServer({ basePath });
      if (serverA.unavailable) return this.skip(`server spawn unavailable: ${serverA.unavailable}`);

      const sessionId = await createSession('fields-owner',
        { baseUrl: serverA.url, password: serverA.masterPassword, spec: FIELDS_SPEC });
      await serverA.stop();

      serverB = await spawnServer({ basePath });
      assert.ok(!serverB.unavailable, 'server B must come up on the same base path');
      socket = await wsConnect(sessionId, 'fields-reader',
        { baseUrl: serverB.url.replace('http', 'ws'), password: serverB.masterPassword });

      const schema = await schemaOf(socket);
      assert.deepEqual(schema.models.m.config.inputs,
        { 'tiny\\.(.*)': { fields: ['$.n'] } },
        'the field filter survives the schema.udta round-trip');
    } finally {
      socket?.close();
      await serverA?.stop?.();
      await serverB?.stop?.();
      fs.rmSync(basePath, { recursive: true, force: true });
    }
  });

  it('round-trips the built-in output names through schema.udta', async function () {
    this.timeout(240000);
    const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'shs-spec-builtin-'));
    let serverA = null;
    let serverB = null;
    let socket = null;
    try {
      serverA = await spawnServer({ basePath });
      if (serverA.unavailable) return this.skip(`server spawn unavailable: ${serverA.unavailable}`);

      // A client-renamed VAD stream plus a transcription rewired to it: the
      // chosen name must persist and the built-ins must re-derive on reload
      const sessionId = await createSession('builtin-owner',
        { baseUrl: serverA.url, password: serverA.masterPassword, spec: {
          processors: [
            { name: 'vad0', type: 'VoiceActivationProcessor', config: {
              inputs: { 'user\\.(.*)\\.audio': {} }, outputStreamType: 'custom.vad' } },
            { name: 'tr0', type: 'AITranscriptionProcessor', config: { inputs: { 'custom\\.vad': {} } } },
          ],
          models: [],
        } });
      await serverA.stop();

      serverB = await spawnServer({ basePath });
      assert.ok(!serverB.unavailable, 'server B must come up on the same base path');
      socket = await wsConnect(sessionId, 'builtin-reader',
        { baseUrl: serverB.url.replace('http', 'ws'), password: serverB.masterPassword });

      const schema = await schemaOf(socket);
      const vad = schema.processors.vad0.config;
      assert.equal(vad.outputStreamType, 'custom.vad', 'the client-chosen name is persisted in schema.udta');
      assert.ok(vad.outputs['custom.vad'], 'the built-in output is re-derived from it on reload');
      assert.equal(vad.outputs['custom.vad'].schemaId, 'stund://tenvadEvent.json');
      assert.ok(schema.processors.tr0.config.outputs['processor.transcription'],
        'the transcription built-in survives the round-trip');
    } finally {
      socket?.close();
      await serverA?.stop?.();
      await serverB?.stop?.();
      fs.rmSync(basePath, { recursive: true, force: true });
    }
  });

  it('tolerates a hand-edited fields filter: valid paths harvest, broken ones warn, ingestion intact', async function () {
    this.timeout(240000);
    const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'shs-spec-corrupt-'));
    let serverA = null;
    let serverB = null;
    let socket = null;
    try {
      serverA = await spawnServer({ basePath });
      if (serverA.unavailable) return this.skip(`server spawn unavailable: ${serverA.unavailable}`);

      const sessionId = await createSession('corrupt-owner',
        { baseUrl: serverA.url, password: serverA.masterPassword, spec: FIELDS_SPEC });
      await serverA.stop();

      // degrade the persisted filter: an unrooted path beside a valid one
      // (the spec gate rejects the former; schema.udta is trusted on restore)
      const schemaFile = path.join(basePath, sessionId, 'schema.udta');
      const persisted = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
      persisted.models.m.config.inputs['tiny\\.(.*)'].fields = ['$.n', '$oops'];
      fs.writeFileSync(schemaFile, JSON.stringify(persisted, null, 2));

      serverB = await spawnServer({ basePath });
      assert.ok(!serverB.unavailable, 'server B must come up on the same base path');
      socket = await wsConnect(sessionId, 'corrupt-reader',
        { baseUrl: serverB.url.replace('http', 'ws'), password: serverB.masterPassword });

      const schema = await schemaOf(socket);
      assert.ok(schema.models.m, 'the session opens and the model is restored');

      // a live event must still flow through the degraded model - its
      // envelope intact, the valid path harvested, the broken one ignored,
      // never a crash, never a lost session
      const events = modelEvents(socket);
      assert.equal((await socket.request({ cmd: 'connectModel', model: 'm' })).status, true);
      assert.equal((await socket.request({
        cmd: 'addProcessor', name: 'emit0', type: 'ScriptProcessor',
        config: {
          language: 'js', emitExceptionEvents: true,
          script: `
            let s = null;
            function init() { s = stund.startEventStream("tiny.out"); s.createInstantEvent({ n: 1 }, Date.now()); }
            function onEventAdded(ev) {}
            function onEventUpdated(ev) {}`,
          inputs: {},
          outputs: { 'tiny.out': { schemaId: 'stund://tinyOut.json', internal: true } },
          schemas: {
            'stund://tinyOut.json': {
              type: 'object', properties: { n: { type: 'integer' } },
              required: ['n'], additionalProperties: false,
            },
          },
        },
      })).status, true);
      const event = await events.waitFor((e) => e.type === 'tiny.out', 45000, 'degraded event');
      assert.equal(event.type, 'tiny.out');
      assert.ok(event.id);
      assert.equal(typeof event.start, 'number', 'the TimedEvent envelope is never filtered');
      assert.deepEqual(event.data, { n: 1 }, 'the valid path still harvests; the broken one is ignored');
      assert.ok(serverB.log().includes("Event model 'm' input 'tiny\\.(.*)' ignores invalid fields paths [$oops]"),
        'the degradation is logged');
    } finally {
      socket?.close();
      await serverA?.stop?.();
      await serverB?.stop?.();
      fs.rmSync(basePath, { recursive: true, force: true });
    }
  });

  it('restores the schema across a server restart (a rejoin gets the spec-built session back)', async function () {
    this.timeout(240000);
    const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'shs-spec-rejoin-'));
    let serverA = null;
    let serverB = null;
    let socket = null;
    try {
      serverA = await spawnServer({ basePath });
      if (serverA.unavailable) return this.skip(`server spawn unavailable: ${serverA.unavailable}`);

      const sessionId = await createSession('rejoin-owner',
        { baseUrl: serverA.url, password: serverA.masterPassword, spec: TINY_SPEC });
      const persistedAt = Date.now();
      await serverA.stop();

      // a second server on the SAME recordings — the session must come back
      // from schema.udta, not from any hardcoded default
      serverB = await spawnServer({ basePath });
      assert.ok(!serverB.unavailable, 'server B must come up on the same base path');
      socket = await wsConnect(sessionId, 'rejoin-reader',
        { baseUrl: serverB.url.replace('http', 'ws'), password: serverB.masterPassword });

      const schema = await schemaOf(socket);
      assert.deepEqual(Object.keys(schema.processors), ['tiny0'], 'the spec-built processor is restored');
      assert.deepEqual(Object.keys(schema.models), ['m'], 'the spec-built model is restored');
      assert.equal(schema.owner, 'rejoin-owner', 'the owner survives the restart');
      assert.ok(schema.created > 0 && schema.created <= persistedAt,
        'created is restored from disk, not re-painted at reload');

      const tiny = schema.processors.tiny0;
      assert.equal(tiny.type, 'ScriptProcessor');
      assert.ok(tiny.config.inputs['tiny\\.(.*)'], 'the input pattern survives the round-trip');
      assert.ok(tiny.config.outputs['tiny.out'], 'the declared output survives');
      assert.ok(tiny.config.schemas['stund://tinyOut.json'], 'the declared schema survives');
      assert.deepEqual(schema.models.m.config.inputs, { 'tiny\\.(.*)': {} });
    } finally {
      socket?.close();
      await serverA?.stop?.();
      await serverB?.stop?.();
      fs.rmSync(basePath, { recursive: true, force: true });
    }
  });

  it('keeps an unloadable processor as a BrokenProcessor (raw JSON preserved, round-trips through saves)', async function () {
    this.timeout(240000);
    const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'shs-spec-broken-'));
    let serverA = null;
    let serverB = null;
    let socket = null;
    try {
      serverA = await spawnServer({ basePath });
      if (serverA.unavailable) return this.skip(`server spawn unavailable: ${serverA.unavailable}`);

      const sessionId = await createSession('broken-owner',
        { baseUrl: serverA.url, password: serverA.masterPassword, spec: TINY_SPEC });
      await serverA.stop();

      // hand a schema.udta entry to the next server whose class does not
      // exist — the load path must not drop it
      const schemaFile = path.join(basePath, sessionId, 'schema.udta');
      const persisted = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
      const ghostEntry = { type: 'NoSuchProcessorEver', config: { inputs: { 'ghost\\.(.*)': {} } } };
      persisted.processors.ghost0 = ghostEntry;
      fs.writeFileSync(schemaFile, JSON.stringify(persisted, null, 2));

      serverB = await spawnServer({ basePath });
      assert.ok(!serverB.unavailable, 'server B must come up on the same base path');
      socket = await wsConnect(sessionId, 'broken-reader',
        { baseUrl: serverB.url.replace('http', 'ws'), password: serverB.masterPassword });

      const schema = await schemaOf(socket);
      const ghost = schema.processors.ghost0;
      assert.ok(ghost, 'the unloadable entry is kept in the schema');
      assert.equal(ghost.type, 'BrokenProcessor');
      assert.ok(ghost.loadError, 'the load error is inspectable by clients');
      assert.equal(ghost.config.originalType, 'NoSuchProcessorEver', 'the type that failed is recorded');
      assert.deepEqual(ghost.config.raw, ghostEntry, 'the original entry JSON is preserved verbatim');
      assert.deepEqual(Object.keys(schema.processors).sort(), ['ghost0', 'tiny0'],
        'the healthy processor loads alongside the broken one');

      assert.match(serverB.log(), /could not load processor 'ghost0'/,
        'the load failure must be logged server-side');

      // it survives a save (any schema change rewrites schema.udta)
      assert.equal((await socket.request({
        cmd: 'addProcessor', name: 'probe0', type: 'ScriptProcessor',
        config: {
          language: 'js', script: 'function onEventAdded(ev){}', inputs: { 'probe\\.(.*)': {} },
        },
      })).status, true);
      const saved = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
      assert.equal(saved.processors.ghost0.type, 'BrokenProcessor',
        'the placeholder survives a saveConfig round-trip');
      assert.equal(saved.processors.ghost0.config.originalType, 'NoSuchProcessorEver');
      assert.deepEqual(saved.processors.ghost0.config.raw, ghostEntry,
        'the preserved entry survives the round-trip verbatim');
      assert.ok(saved.processors.probe0, 'the newly added processor is saved alongside it');
    } finally {
      socket?.close();
      await serverA?.stop?.();
      await serverB?.stop?.();
      fs.rmSync(basePath, { recursive: true, force: true });
    }
  });
});
