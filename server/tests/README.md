# SessionHistoryServer functional tests

Executable protocol documentation: each file drives a **running
SessionHistoryServer** over real HTTP, real websockets, and (for the
ingest/demo tests) a real headless Chromium with fake media devices —
and takes measurements along the way. The style is deliberately the
same short-and-clear one as the Webstrates functional tests: one page
per protocol area, each test a few lines that say what the contract *is*.

```
tests/
├── 0-auth.mjs            the auth layer: /login, entityKey transports, 401/403, expiry
├── 1-sessions.mjs       HTTP surface: creating sessions, media/resource serving, error paths
├── 2-protocol.mjs        websocket protocol: connect, schema broadcast, commands, lifecycle
├── 3-models.mjs          the "history" model: subscriptions, coalescing, replay, tentative events
├── 4-ingest.mjs          WebRTC signaling: SDP offers, munging, ICE, the negotiation race
├── 5-ingest-browser.mjs  full browser ingest: data-channel events, camera → Matroska → HTTP
├── 6-processors.mjs      processor lifecycle: script processors, schemas, removal
├── 7-replay.mjs          replay ordering, getEvent meta, persistence across servers
├── 8-client.mjs          the bundled session.js client library, bug by bug
├── 9-demo.mjs            the bundled demo page (src/main/webapp/demo2.html) like a user
├── 10-spec.mjs           session specs: the {spec} create contract, defaults, owner painting, schema.udta reload
├── 11-health.mjs         the /health report: field contract, green values, spam-resistance
└── helpers.mjs           auth (login + keying), HTTP + raw-ws clients, server spawner, browser launcher, measurements
```

## Running

```bash
cd tests
npm install
npx mocha                     # everything (spec comes from .mocharc.json)
```

A single file:

```bash
npx mocha --no-config --timeout 60000 --exit ./4-ingest.mjs
```

(`--no-config` keeps `.mocharc.json` from merging in the whole spec;
`--exit` is needed because open websockets otherwise keep node alive.)

### Prerequisites

- **A running server** — by default at `http://localhost:3001`. Build and
  start one from the `server` folder:
  ```bash
  mvn package
  java -Djna.library.path=<ten-vad-dir> -jar target/SessionHistoryServer-*.jar
  ```
  Run it from a directory containing a link or copy of ten-vad's
  `onnx_model` directory — the VAD loads it from the working directory
  (a self-built arm64 `libten_vad.so` also needs `libonnxruntime.so.1`
  next to it; the prebuilt x86-64 one does not).
- **The server's master password** — the server under test demands an
  entityKey on everything under `/session`, so the tests must log in.
  The password is read from `SHS_MASTER_PASSWORD` or the `server` folder's
  `config.json` (`{"auth": {"masterPassword": "..."}}` — that file is
  untracked, see the server README). Tests that need it skip themselves
  with an explanation when neither is set. The servers spawned by the
  tests (files 0 and 7) write their own generated master password into
  their working directory, so they never depend on this.
- **Chromium/Chrome** for files 5, 8 and 9 (`--use-fake-device-for-media-stream`
  supplies camera/microphone without hardware).
- The files that spawn their own server instances (0, 1, 7, 10) need `java` and
  a built jar; they skip themselves with a message if either is missing.
  Files 0 (the expiry test), 7 and 10 additionally need the TEN VAD library on
  disk (their servers must pass the native self-tests); file 1's spawned
  tests only exercise the sessions-base-directory startup check, which
  runs before them.
- **Session specs** — every `POST /session` must carry `{spec: {processors,
  models}}` (see 10-spec.mjs for the contract). The helpers' `createSession`
  builds sessions from the application spec by default (fetched from the
  server's `/application-spec.json`, falling back to the repo copy), which is
  the setup the suite's assertions assume; pass your own `spec` for bare or
  custom sessions.

### Environment variables

| Variable | Meaning | Default |
|---|---|---|
| `SHS_URL` | base URL of the server under test | `http://localhost:3001` |
| `SHS_MASTER_PASSWORD` | master password of the server under test | `auth.masterPassword` in the `server` folder's `config.json` |
| `SHS_BROWSER` | Chromium/Chrome executable for puppeteer | first of `/usr/bin/chromium`, … |
| `SHS_JAR` | jar used by the spawned-server tests | newest `target/SessionHistoryServer-*.jar` |
| `SHS_TEN_VAD` | directory with `libten_vad.so` + `onnx_model` | `/tmp/tenvad-arm64`, `/usr/local/lib` |


## Future Work

The server only supports working with live sessions. It cannot yet load back 
and reprocess session state for old sessions after a restart. All event data is
kept in memory forever, which is currently by design.


## The `[known-bug]` convention

A test whose title starts with `[known-bug: …]` asserts the **desired**
behavior and fails today. Each one is a reproducible bug report — the
assertion message tells you what the contract should be, and the prefix
tells you why it isn't. The failing tests at any moment are the open bug
list for the wire protocol; when a bug is fixed, its test goes green
without being touched. Every failure prints exactly what it got instead.

Currently known-failing (the open bug list; 12 tests — verified
against the release tree by a full suite run, 2026-10-20):

| File | Test (shortened) | Bug |
|---|---|---|
| 1-sessions | unknown session → 404 | unknown sessions take the 500 path — Jetty's default error page with the stack trace — instead of a clean 404 |
| 1-sessions | unknown resource → 404 | same dead null-check family on the resource path |
| 2-protocol | survives malformed JSON | the error handler drops the connection instead of answering with an error reply |
| 2-protocol | survives a missing op | the error handler NPEs and drops the connection |
| 4-ingest | garbage SDP answer → clean rejection | GStreamer rejects it asynchronously — no reply is ever sent |
| 5-ingest-browser | stopMediaStream closes the track | removeTrack alone is invisible to the server |
| 5-ingest-browser | teardown closes track events | no code path stamps end on media track events |
| 5-ingest-browser | uncovered event types visible | data-channel events matching no processor input are persisted but never enter the model — silently |
| 6-processors | quiet when emitLogEvents is false | `emitLogEvents` gates only the schema declaration — `Processor.log()` still publishes engine warnings and `console.log` lines as events |
| 7-replay | replays in start order | the pre-fill iterates a HashMap — arbitrary order |
| 7-replay | getEvent honors options | `EventQuery.options` is ignored (FIXME in the endpoint) |
| 7-replay | second server serves recordings | recorded events are still not replayed after a restart — the schema (processors, models, owner) now IS restored from schema.udta, but the events themselves stay missing |
