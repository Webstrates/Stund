<!--
  SessionHistoryServer README
  A Getting Started walkthrough, build and run instructions,
  native-installation instructions (Ubuntu, Linux Mint, Gentoo)
  plus a containerized setup with Dockerfile and docker-compose.yaml.

  Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
  Visualization and Interaction - Aarhus University
  SPDX-License-Identifier: MIT
-->

# SessionHistoryServer

[![DOI](https://img.shields.io/badge/DOI-10.1145%2F3830398.3830508-blue)](https://doi.org/10.1145/3830398.3830508)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Java](https://img.shields.io/badge/Java-17-orange)](https://openjdk.java.net/projects/jdk/17/)
An embedded-Jetty server that records and replays sessions of synchronized
event and media streams: WebRTC media ingest via GStreamer, a websocket
command API, queryable timed-event history, pluggable AI processors
(OpenAI-compatible) and GraalVM polyglot JavaScript scripting.

SessionHistoryServer is the session-history component of **Stund**, an
activity-enriched collaborative workspace (UIST '26 — [paper][paper],
[video][video]).

## Getting started

Two paths to running a server: 

* Either use **Docker** to compile and run the server. It installs the native requirements inside the image - nothing needed on the host. 
* Or use the **native** path that builds with JDK 17 + Maven and runs on a system GStreamer + TEN VAD installation.

| Component | What it is for | Needed for |
|-----------|---------------|------------|
| JDK 17 + Maven 3 | compiles and runs the server | Native path only — Docker compiles inside the image |
| GStreamer 1.x (1.20+ recommended) — the `base`, `good` and `bad` plugin sets plus libnice's `nice` plugin | WebRTC ingest (`webrtcbin` does all of its ICE through libnice) and the server-side recording pipelines | Native path, run only |
| The TEN VAD library (`libten_vad.so`, Apache-2.0) | voice-activity detection in the audio processors | Native path, run only |
| MP4Box (GPAC ≥ 2.2) | authors the owner-export MP4 of a session (`/session/{sessionId}/export?type=raw`) | Export only — the Docker image builds it in; on the native path install GPAC ≥ 2.2 (or point `session.mp4boxPath` at the binary) |
| Node.js with npm — the browser-driven tests also need a Chromium/Chrome | the functional tests (`tests/`) and the API docs (`docs/`), never the server itself | Tests & docs only |

The startup self-test instantiates every GStreamer element the server requires — including the ones a browser
connection spawns dynamically — and the TEN VAD detector; a missing component is logged with the package it
usually ships in and the server exits (status 233) rather than starting half-working. The `[OK]` lines
print at the default log level, so a healthy install logs its way through
startup. Per distribution: [Native installation](#native-installation).

MP4Box is the one prerequisite the self-test does not gate on: the server starts and records fine
without it — only the owner export then fails (HTTP 500, with the underlying error naming the
missing binary and pointing at GPAC or `session.mp4boxPath`).

### The master password

The server is protected by an auth layer: everything under `/session`
demands an entityKey, and keys are minted by POSTing the master password
to `/login` (see [Authentication](#authentication)). Without a master
password no key can ever be minted — the server starts and says so
loudly, and every session request is rejected until one is set:

```bash
'{"auth": {"masterPassword": "a secret of yours"}}'
```

`config.json` is read from the server's working directory — the repo root, if that is where you run the jar
(a writable `sessions/` ships there; from anywhere else create one, or pass `-Dsession.basePath`). Keys the
file leaves out keep the built-in default — the full template is [config.json.sample](config.json.sample).

### The Docker path

The image compiles the server and installs the GStreamer plugin sets, libnice, the libc++
runtime, TEN VAD itself and the MP4Box export tool — nothing but Docker and the `config.json`
from above are needed on the host (compose mounts it and `./sessions`):

```bash
docker compose up -d --build   # compiles the server inside the image
docker compose logs -f        # watch the build, self-test and startup
```

Continue at [First steps](#first-steps); [Docker](#docker) covers the RTP port range and persistent entityKeys.

### The native path

The build needs nothing but JDK 17 and Maven — both natives are runtime prerequisites, so a first `mvn
package` works on a bare box. Boot runs the self-test from the prerequisites, then starts Jetty —
`Configuration loaded successfully from file.` is your `config.json` being picked up.

```bash
mvn validate            # once per machine: registers the vendored jar
mvn clean package
java -jar target/SessionHistoryServer-0.1.151.jar
```

All dependencies resolve from public sources. The `mvn validate` step
installs the one vendored, LGPL-licensed library (`gst1-java-fixups`,
see the License section) from `libs/` into your local Maven repository —
run it once per machine, after that every build resolves on its own. It
also covers the setups where the in-project `file://` repository that
`libs/` doubles as cannot be used directly: Windows drive letters
(rejected by some Maven versions) and `settings.xml` mirrors with
`mirrorOf: *` (they intercept every repository, file-based ones
included).

The server listens on port 3001 by default:

| Path | Purpose |
|------|---------|
| `/` | Static frontpage |
| `/health` | Health report for uptime monitors (see [Health monitoring](#health-monitoring)) |
| `/login` | Mint an entityKey (POST the master password; a browser login is planned) |
| `/session` | Session management endpoint |
| `/session/{sessionId}/media/*` | Session resources (streamed recordings) |
| `/session/{sessionId}/export?type=raw` | Owner-only session export |
| `/session/{sessionId}/{entityId}` | Websocket endpoint |

### First steps

The example data web application at `/demo2.html` is a single-file, zero-dependency demo of the whole stack.

1. **Get access.** Open http://localhost:3001/demo2.html - type in an entity name of your choice and the password to get an access key. The browser remembers one such access
   key at a time.
2. **Create or join a session.** *Create new session* builds the session from the reference
   spec it fetches at `/application-spec.json` — the `application.*` event vocabulary plus the
   voice pipeline. Or open the page in a second window, paste the session id into "…or paste
   a session id" and *Join* — a fresh entity, every event flowing to all participants live.
   A `?session=` URL jumps straight into that session once access is granted.
3. **Watch events work.** Send an instant event and see it in every live feed; hold the
   hold-to-record button for a duration event — tentative while held, growing on the timeline,
   snapping solid on release. Click any event in the live feed or on the timeline to show
   details (entity, start/end, data and meta) underneath the timeline.
4. **Ingest media.** The Camera / Microphone / Screen buttons start WebRTC ingest: the recordings grow
   server-side as streamable Matroska under `sessions/`. With the microphone running, voice-activity
   events arrive in the feed — the native TEN VAD chain, no AI endpoint (transcription needs an
   `openAIConnections` entry named `default`; see the [`config.json`](#configjson) table).
5. **Replay and extend.** ▶ Replay (1×–8×) plays the recorded session back through the same
   subscription that served the live tail; the Processors panel includes a live JavaScript
   playground for your own event processors.

From a terminal, the same two calls the client makes:

```bash
curl -X POST http://localhost:3001/login \
     -H 'Content-Type: application/json' \
     -d '{"entity": "alice", "masterPassword": "a secret of yours"}'
curl -X POST http://localhost:3001/session \
     -H 'Content-Type: application/json' \
     -H 'Authorization: Bearer No1nZUguBlhIIlCm...' \
     -d '{"spec": {"processors": [], "models": []}}'
# → {"sessionId": "3fc8a5ac-..."} — paste it into the demo's join field
```

Richer sessions POST `/default-spec.json` or `/application-spec.json`, wrapped as `{"spec": ...}` — see
[Session specs](#session-specs). The functional tests in `tests/` keep every still-open bug as a failing
test whose title documents it. Deeper: [Authentication](#authentication), [API documentation](#api-documentation).

## Authentication

Every request under `/session` — HTTP *and* websocket upgrades alike —
must present an **entityKey**: a token proving ownership of the entity id
the request acts as. A request with no key, an unknown or expired one, or
one granting a different entity than the request claims is rejected
(401/403) before anything else runs — before session existence is even
considered.

**Minting a key:** POST the master password and the entity id you want to
act as to `/login` — anyone who knows the master password can claim any
entity id (the password is the trust anchor):

```bash
curl -X POST http://localhost:3001/login \
     -H 'Content-Type: application/json' \
     -d '{"entity": "alice", "masterPassword": "<from your config.json>"}'
```

The reply carries the key (and sets it as an `entityKey` cookie for
browsers):

```json
{"entityKey": "No1nZUguBlhIIlCm...", "entity": "alice",
 "created": 1792411976553, "expires": 1793016776553, "source": "pass"}
```

Browsing to `/login` with a browser and authenticating through OpenID
Connect is planned (the entity id would then be the OpenID Connect id);
until then the endpoint answers a GET with 405.

**Presenting the key**, in order of precedence:

| Transport | Example |
|-----------|---------|
| `Authorization: Bearer` header | `Authorization: Bearer No1nZUgu...` |
| `X-Entity-Key` header | `X-Entity-Key: No1nZUgu...` |
| `entityKey` query parameter | `/session/...?entityKey=No1nZUgu...` |
| `entityKey` cookie | `Cookie: entityKey=No1nZUgu...` |

The query parameter and cookie transports exist because websocket
handshakes and HTML media elements cannot set headers — the bundled
`session.js` keys its URLs automatically with the key it obtained at
login (`SessionHistory.login(entity, masterPassword)`).

**EntityKeys are files:** one JSON file per key under the tokens
directory, with the secret key as the file name —

```json
{"entity":"alice","created":1792411976553,"expires":1793016776553,"source":"pass"}
```

— living a week by default, swept when they expire, and re-minted by a
fresh login. Deleting a file revokes the key.

Auth settings (in `config.json`, like everything below):

| Key | Default | Purpose |
|-----|---------|---------|
| `auth.masterPassword` | *(unset)* | The password that mints entityKeys at `/login`. **Fail-closed:** without it nobody can ever log in, so every `/session` request is rejected — the server says so loudly at startup instead of running unprotected |
| `auth.tokenLifetimeDays` | `7` | How long minted entityKeys live (fractional days allowed) |
| `auth.tokenPath` | `tokens` | Directory holding the entityKey files — created and checked at startup, must be writable |

In Docker, persist the tokens directory with a volume like `./sessions`
(`- ./tokens:/app/tokens`), or every minted entityKey vanishes with the
container and clients must log in again after each restart.

Configuration (Java system properties, e.g. `-Djetty.port=8080` or via
`JAVA_TOOL_OPTIONS`):

| Property | Default | Purpose |
|----------|---------|---------|
| `jetty.port` | `3001` | HTTP/websocket port |
| `context` | `/` | Context path |
| `session.basePath` | `sessions` | Directory holding recorded sessions — checked at startup: it must exist and be writable |

### `config.json`

Besides the system properties, the server reads an optional `config.json`
from its **working directory** the first time it needs a setting — every
key the file leaves out keeps the built-in default shown below. A
copy-paste template with all keys ships as
[config.json.sample](config.json.sample):

| Key | Default | Purpose |
|-----|---------|---------|
| `webrtc.iceServers` | `["stun://stun.l.google.com:19302"]` | ICE servers offered to ingest clients (`stun://`, `turn://` and `turns://` URLs — see below) |
| `webrtc.minRTPPort` / `webrtc.maxRTPPort` | `60000` / `61000` | Port range reserved for the RTP of incoming ingest streams (in Docker, publish the same range as UDP — see the Docker notes) |
| `ai.defaultModel` | `gpt-4o-mini` | The model AI processors use when their own configuration names none |
| `ai.defaultTranscriptionModel` | `whisper-1` | The model the transcription processor uses when its configuration names none |
| `openAIConnections` | *(empty)* | The named OpenAI-compatible endpoints: each entry maps a connection name to its `url` and `key` |

`webrtc.iceServers` accepts `stun://host:port` entries (server-reflexive
ICE candidates) and `turn://user:password@host:port` /
`turns://user:password@host:port` entries (TURN relay, `turns://` being
TURN over TLS). GStreamer's `webrtcbin` honors exactly **one** STUN
server — later `stun://` entries are ignored with a warning — but any
number of TURN servers; redundancy and restrictive-NAT traversal
therefore come from TURN, not from more STUN entries. A `turn://` entry
may carry a `?transport=tcp` (or `?transport=udp`) query to pin the
relay transport; without one, both are configured.

The AI processors resolve their endpoint through the connection named
**`default`** — an `openAIConnections` entry with that name is what
enables them, and any OpenAI-compatible service works behind it (the
public API, or a self-hosted vLLM or whisper server, e.g.
`http://my-server:8000/v1/`). A processor can override both choices per
instance through the `model` and `connection` fields of its
configuration, for example when adding a processor over the websocket
API.

The file carries API keys, so `config.json` is never committed — it is
git-ignored and only the sample ships. In Docker, `docker-compose.yaml` always mounts
`./config.json` into the server's working directory (`/app`), so a
`config.json` next to it — copied from the sample — is all the container
needs.

## Functional tests

The stack is exercised end-to-end by the functional tests in
`tests/` — real HTTP, real websockets and a real
headless Chromium with fake media devices, in the style of executable
protocol documentation. They take measurements along the way (latencies,
message counts, bytes served), and every still-open bug is kept as a
failing test whose title documents it — the failing tests at any moment
are the open bug list:

```bash
cd tests/
npm install
npx mocha          # see tests/README.md for details
```

## Health monitoring

`GET /health` serves a small JSON report of the server's self-observations,
written for any uptime monitor — HTTP 200 when everything is
green, HTTP 503 when any check is degraded:


## Session specs

A session's setup — its processors and its event models — is supplied by
the client that creates it; the server ships defaults only as the spec
documents served over HTTP. `POST
/session` (authenticated as described above) carries a **session spec**:

```json
{
  "spec": {
    "processors": [
      { "name": "voicedetect0", "type": "VoiceActivationProcessor",
        "config": { "inputs": { "user\\.(.*)\\.audio": {} } } },
      { "name": "myapp0", "type": "EventStreamProcessor",
        "config": { "inputs": { "myapp\\.(.*)": {} } },
        "outputs": { "myapp.interaction": { "schemaId": "stund://mySchema.json", "internal": true } },
        "schemas": { "stund://mySchema.json": { "type": "object" } } }
    ],
    "models": [
      { "name": "history", "config": { "inputs": { ".*": {} } } }
    ]
  }
}
```

- Every `processors` entry is exactly the `addProcessor` wire shape, so
  anything the config leaves out falls back to that config class's
  field-initializer default — an AI processor's omitted `model`, for
  example, resolves through `ai.defaultModel` /
  `ai.defaultTranscriptionModel` (see `config.json` above), and the voice
  activation detector keeps its threshold and built-in output.
- `models` entries are the ModelConfig shape the schema broadcast carries:
  each input pattern keys a specification object whose optional `fields`
  list selects which parts of the event **data** the model broadcasts for
  matching events — `$.`-rooted, dot-separated data paths with `*` as a
  whole-segment wildcard. The TimedEvent envelope itself (`type`, `id`,
  `start`, `end`, `tentative`, `entity`) is never filtered; only `data` is.
  A transcription processor's segments carry `text`, `noSpeechProb` and
  `avgLogprob` — a client that only needs the text asks for
  `fields: ["$.text"]`; one that only wants a voice activity detector's
  start/stop asks for `fields: []` and gets the envelope with no data at
  all. Paths that address nothing in a given event keep nothing (an empty
  harvest leaves out the `data` member), an event matching several
  patterns sees the union of their lists, and any matching pattern without
  a filter keeps the whole event. The filter shapes model broadcasts only;
  `getEvent` still serves the full raw event.
- The spec is validated all-or-nothing: an unknown type, an invalid input
  pattern, a duplicate name, a model input without a specification, a
  `fields` filter with a null entry or a malformed data path, or an output
  whose `schemaId` has no schema in the entry's registry is a clean 400
  before anything is built. The ws `addProcessor` command runs the same
  per-processor pre-flight — a bad entry is a clean `status:false` reply,
  never a half-installed processor that throws inside event dispatch. As
  with a spec, an output's `schemaId` must ship its schema in `schemas`
  (built-in schemas included) to be referenceable — the ws `addProcessor`
  path applies exactly the rule a spec does.
- Bookkeeping is painted by the server, never taken from the body: the
  **owner is the authenticated token's entity**, and `serverVersion`,
  `created`, `start` and `end` are the server's own.
- Old clients that POST without a spec get a 400 pointing at
  `/default-spec.json` — the generic starting point (the voice pipeline
  plus the history model, no application vocabulary). The reference app's
  setup — the `application.*` event vocabulary — ships as a ready-to-POST
  `/application-spec.json`, and `SessionHistory.defaultSpec()` fetches the
  generic one from the client library.

Sessions persist their schema to `schema.udta` and restore it whenever
the session is materialized again — a rejoin after a server restart, or
a copy/import of the recordings. An entry whose processor class is absent
from the classpath — or whose config fails the
same pre-flight a spec runs (an invalid input pattern, an output whose
`schemaId` is missing from its registry) — is kept as a
`BrokenProcessor`: the original JSON is preserved verbatim, inspectable
through the `schemaChange` broadcast, and round-trips through saves until
the class returns (then `removeProcessor` + re-`addProcessor` restores
it).
Input filters are spec-validated on creation and trusted when restored:
a hand-edited `schema.udta` filter with malformed paths keeps matching
events' envelopes and harvests whatever its valid paths address (with a
WARNING naming the ignored ones); unknown members are dropped on load, so
a schema that loses its field filters keeps its envelopes. 

The contract is exercised end-to-end by `tests/10-spec.mjs`.

## API documentation

The bundled client library `src/main/webapp/session.js` is documented with
JSDoc (the same jsdoc-baseline setup the Codestrates API docs use):

```bash
cd docs
npm install
npm run docs   # generates docs/api/ — open docs/api/index.html in a browser
npm run serve  # or serve it at http://localhost:3002
```

See `docs/README.md` for details.

## Native installation

The native server does **not** bundle libraries - only the Docker version does.
It expects a working system installation of GStreamer and the TEN VAD library
 — the server lists every missing component and exits (status 233) on failure
instead of starting half-working. Install the following once and you are
done.

### GStreamer

The server requires GStreamer 1.x (1.20 or newer recommended) with the
`base`, `good` and `bad` plugin sets, plus the `nice` plugin from
[libnice](https://libnice.freedesktop.org): `webrtcbin` does all of its
ICE connectivity through it, and it is packaged separately from the
plugin sets (Ubuntu/Mint: `gstreamer1.0-nice`, Gentoo:
`media-plugins/gst-plugins-libnice`). The self-test checks every
element below at startup:

| GStreamer element | Shipped in |
|-------------------|------------|
| `webrtcbin` | gst-plugins-bad |
| `nicesink` | the libnice plugin (`gstreamer1.0-nice`) |
| `queue`, `capsfilter`, `appsink`, `appsrc`, `decodebin`, `capssetter`, `videorate`, `audioconvert` | gst-plugins-base |
| `audioresample` | gst-plugins-base |
| `matroskamux`, `jpegenc`, `wavenc`, `audiobuffersplit` | gst-plugins-good |
| `rtpsession`, `rtpvp8depay`, `rtpopusdepay` | gst-plugins-good |
| `sctpenc`, `dtlsenc`, `srtpenc` | gst-plugins-bad |
| `identity` | GStreamer core |

`sctpenc`, `dtlsenc`, `srtpenc`, `rtpsession`, `rtpvp8depay` and
`rtpopusdepay` appear in no static pipeline: they are created
dynamically once a browser connects — `webrtcbin` spawns the SCTP data
channels, the DTLS and SRTP transports and one `rtpsession` per
incoming stream (its internal `rtpbin`), while the ingest pipeline
itself creates an `rtp<codec>depay` per incoming stream, the factory
name composed from the browser's negotiated codec (so only the common
VP8 and Opus ones can be preflighted), and `audioresample` is created
by the voice activation processor. No additional packages are needed
beyond the plugin sets above; these checks catch installations whose
plugin sets are present but incomplete or damaged — a bare
`webrtcbin` check passes those while ICE is in fact broken.

Verify an installation with:

```bash
gst-inspect-1.0 webrtcbin   # the ingest pipeline (gst-plugins-bad)
gst-inspect-1.0 nicesink    # the libnice plugin it needs for ICE
```

#### Ubuntu

```bash
sudo apt update
sudo apt install libgstreamer1.0-0 gstreamer1.0-tools gstreamer1.0-plugins-base \
     gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-nice
# optional - gives decodebin more codecs to pick from:
sudo apt install gstreamer1.0-libav
```

`gstreamer1.0-nice` lives in the *universe* repository — enable it
first with `sudo add-apt-repository universe` if needed (standard
Ubuntu and Linux Mint installs have *universe* enabled by default).

#### Linux Mint

Mint is Ubuntu-based (LMDE is Debian-based), so the package names are the
same as on Ubuntu:

```bash
sudo apt update
sudo apt install libgstreamer1.0-0 gstreamer1.0-tools gstreamer1.0-plugins-base \
     gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-nice
# optional:
sudo apt install gstreamer1.0-libav
```

#### Gentoo

```bash
sudo emerge --ask media-libs/gst-plugins-base \
     media-libs/gst-plugins-good media-libs/gst-plugins-bad \
     media-plugins/gst-plugins-libnice
# optional:
sudo emerge --ask media-libs/gst-plugins-libav
```

On Gentoo the `nice` plugin lives in
`media-plugins/gst-plugins-libnice` - not in the plugin sets, and no
longer in `net-libs/libnice` itself (its current ebuilds build the
library only).

Some elements in `gst-plugins-bad` are gated behind USE flags. If
`gst-inspect-1.0 webrtcbin` reports nothing after installing, enable the
`webrtc` USE flag and rebuild:

```bash
mkdir -p /etc/portage/package.use
echo "media-libs/gst-plugins-bad webrtc" | sudo tee -a /etc/portage/package.use/gstreamer
sudo emerge --ask media-libs/gst-plugins-bad
```

### TEN VAD

The voice-activity detector used by the audio processors comes from the
TEN framework (Apache-2.0): https://github.com/TEN-framework/ten-vad

The repository ships a prebuilt Linux x86-64 library at
`lib/Linux/x64/libten_vad.so`. To install it system-wide:

```bash
git clone https://github.com/TEN-framework/ten-vad.git
sudo cp ten-vad/lib/Linux/x64/libten_vad.so /usr/local/lib/
sudo ldconfig
```

Alternatively, keep the library anywhere and point the JVM at it:

```bash
java -Djna.library.path=/opt/ten-vad/lib -jar target/SessionHistoryServer-0.1.151.jar
```

On other architectures (e.g. ARM64) there is no prebuilt and the library
must be built from source. Note that the current ten-vad sources use the
onnxruntime C API and open the VAD model from a path **relative to the
working directory** (`onnx_model/ten-vad.onnx`):

```bash
git clone --depth 1 https://github.com/TEN-framework/ten-vad.git
# prebuilt onnxruntime for your architecture, e.g. aarch64:
curl -fsSL -o ort.tgz \
  https://github.com/microsoft/onnxruntime/releases/download/v1.31.0/onnxruntime-linux-aarch64-1.31.0.tgz
tar -xzf ort.tgz --no-same-owner
ORT=$(echo onnxruntime-linux-aarch64-*)

gcc -c -fPIC -O2 ten-vad/src/fftw.c -o fftw.o
g++ -shared -fPIC -O2 -std=c++17 -fvisibility=hidden \
    -Iten-vad/include -I"$ORT/include" ten-vad/src/*.cc fftw.o \
    -L"$ORT/lib" -lonnxruntime -Wl,-rpath,'$ORIGIN' -o libten_vad.so

mkdir -p onnx_model
cp ten-vad/src/onnx_model/ten-vad.onnx onnx_model/
cp -L "$ORT/lib/libonnxruntime.so.1" .
```

The resulting `libten_vad.so` is linked against libstdc++ (present on
every mainstream distribution) and finds onnxruntime next to itself via
its rpath. Install the library (and `libonnxruntime.so.1`) e.g. in
`/usr/local/lib` with `ldconfig`, and start the server from a directory
that contains `onnx_model/` — or use `-Djna.library.path` to point at the
library directory. The self-test verifies the whole chain. Note that
the sessions base directory (the `session.basePath` property, `sessions`
by default, resolved relative to the working directory) must exist and
be writable — the server checks at startup — so from a directory other
than the repo root, also create a `sessions/` directory there or pass
`-Dsession.basePath` (see the property table above).

Note: the upstream x86-64 prebuilt is an older, self-contained DSP
implementation, while a build from source (as on ARM64 above) uses the
current ONNX-model based implementation. Both expose the same C API, but
detection behaviour may differ slightly between them.

The prebuilt `libten_vad.so` is linked against **LLVM's libc++**, not the
usual system libstdc++, so the libc++ runtime must also be installed:

- Ubuntu (22.04/24.04): `sudo apt install libc++1` (package `libc++1`
  lives in the *universe* repository — enable it first with
  `sudo add-apt-repository universe` if needed)
- Linux Mint: same as Ubuntu — `sudo apt install libc++1`
- Gentoo: `sudo emerge --ask sys-libs/libcxx`
  (modern ebuilds include the libc++abi part)

The server self-test logs `TEN Voice Activation Detector... [OK]` when
the library loads correctly — the `[OK]` lines print at the default log
level.

## Docker

The repository contains a `Dockerfile` and a `docker-compose.yaml` that
provide a complete environment: the server is compiled inside the image
by a Maven builder stage, and the runtime image installs the GStreamer
plugin sets, the libnice ICE plugin `webrtcbin` needs, and the required
libc++ runtime via apt plus the TEN VAD library (official prebuilt on
x86-64, compiled from source on arm64) and a statically linked MP4Box
(GPAC ≥ 2.2 with a demux-only FFmpeg) for the owner export — Ubuntu's
archives stopped shipping the orphaned `gpac` package after 24.04
(24.04 itself still has it, and the runtime image's base is newer),
so the image builds it from pinned sources. Nothing but Docker is
needed on the host.

```bash
docker compose up -d --build   # compiles the server inside the image
docker compose logs -f        # watch the build, self-test and startup
```

Notes:

- The server runs on http://localhost:3001/ ; recorded sessions
  are persisted in the `./sessions` directory (bind-mounted by compose).
  Add a `- ./tokens:/app/tokens` volume to also persist the minted
  entityKeys across container restarts (see Authentication).
- Compose publishes `3001/tcp` plus the RTP media range
  `60000-61000/udp`, which must cover the same ports as
  `webrtc.minRTPPort`/`maxRTPPort` in `config.json` and stay mapped
  1:1 — docker's masquerade then preserves the port numbers the srflx
  ICE candidates advertise, and ingest clients on **other machines**
  can connect. Override both ends of the mapping at once with the
  `RTP_PORT_RANGE` environment variable. Without a published range ICE
  only succeeds from browsers on the Docker host itself;
  `network_mode: host` (drop `ports:`) or a TURN server in
  `webrtc.iceServers` are the alternatives. Note that on default
  Docker setups every published port also runs a userland-proxy
  process — if a 1000-port range is too heavy, publish a smaller
  matching range or set `"userland-proxy": false` in `daemon.json`.
- To serve on another port, change the `ports` mapping and the
  `JAVA_TOOL_OPTIONS` environment variable in `docker-compose.yaml`.
- The server is built inside the image, so no Java or Maven installation
  is needed on the host, and all Maven dependencies resolve from public
  sources: the one LGPL-licensed library (`gst1-java-fixups`) is vendored
  in `libs/` and travels with the build context — no internal repository
  access is required (see the License section). The Maven inside the image
  runs with stock settings (no `settings.xml`, no mirrors), so it reads
  the vendored `file://` repository directly — the `mvn validate` step
  from Getting started is not needed in Docker.
- The image builds on both **x86-64 and arm64** hosts. On x86-64 the
  official TEN VAD prebuilt is used; on arm64 TEN VAD is compiled from
  source during the image build, bundling onnxruntime and the VAD model
  automatically. To use a custom `libten_vad.so` instead, mount yours
  over the in-image copy, e.g. add
  `- ./libten_vad.so:/usr/local/lib/libten_vad.so:ro` under the `volumes`
  of `docker-compose.yaml`.

### Reproducible builds

All downloaded external resources are pinned in the `Dockerfile`:

- base images (`ubuntu:24.04`, `eclipse-temurin:17-jre`,
  `maven:3.9-eclipse-temurin-17`) by digest,
- TEN VAD (prebuilt, source and model) by exact commit,
- onnxruntime and FFmpeg (the demux-only build behind MP4Box) by
  release version with a sha256 check during the build,
- GPAC (MP4Box) by exact commit with a sha256 check during the build.

Only the apt packages (GStreamer plugin sets, libnice plugin, libc++)
float within the digest-pinned base images, so rebuilds pick up
security updates. To
move any pin forward, edit the `ARG` values at the top of the
`Dockerfile` (or override them with
`docker build --build-arg ONNXRUNTIME_VERSION=...`).

## Publications and citation

The research behind this system is published as part of **Stund**, an
activity-enriched collaborative workspace, at UIST 2026:

> Marcel Borowski, Janus Bager Kristensen, Payod Panda, Sean Rintel,
> Niklas Elmqvist, Jens Emil Sloth Grønbæk, and Clemens Nylandsted
> Klokmose. 2026. Stund: Activity-Enriched Collaborative Workspaces
> Mediated by Artificial Intelligence. In *The 39th Annual ACM Symposium
> on User Interface Software and Technology (UIST '26)*, November 02–05,
> 2026, Detroit, MI, USA. ACM, New York, NY, USA, 14 pages.
> <https://doi.org/10.1145/3830398.3830508>

- 📄 Paper: <https://doi.org/10.1145/3830398.3830508>
- 🎬 Video: <https://www.youtube.com/watch?v=QjgDFruIFh0>

See [CITATION.cff](CITATION.cff) for machine-readable citation metadata
(BibTeX-ready on GitHub).


## License

This project is released under the MIT License — see [LICENSE](LICENSE),
with one exception: **GNU LGPL version 3 only** components are used
by the server - the jars are vendored in [`libs/`](libs/) (the
`gst1-java-fixups` GStreamer WebRTC/GBytes bindings; notice and license
text in [libs/LICENSE](libs/LICENSE), complete corresponding source as
the `-sources` jar next to the binary) and the GStreamer Java bindings
library `gst1-java-core` (source at the
repository linked from [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES.txt)).
[THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt) lists every
third-party component embedded in the JAR and its license.

GStreamer, libnice and the TEN VAD library are third-party run-time
dependencies that you install on your system; they are not
redistributed with this project. Check their respective licenses if you
redistribute the server image. MP4Box is the one exception on the Docker
path: the image builds it from pinned sources (GPAC ≥ 2.2 and a
demux-only FFmpeg, both LGPL-2.1, plus GPAC's bundled QuickJS, MIT)
and ships the single statically linked binary, so redistributing the
image redistributes those too;
the pins and provenance notes travel in the `Dockerfile`.

[paper]: https://doi.org/10.1145/3830398.3830508
[video]: https://www.youtube.com/watch?v=QjgDFruIFh0

