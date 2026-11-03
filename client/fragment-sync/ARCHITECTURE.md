# Stund Architecture

## What this project is

Stund is a collaborative browser app built on Webstrates/Codestrates with:

- A shared `tldraw` canvas.
- Widget shapes backed by code fragments (React components).
- An AI sidebar (SlopScript + a pluggable connector, LiteLLM by default) that can read/write canvas, search, inspect history, and edit widgets/processors.
- Session history capture + processing via a remote history service.
- Real-time audio/video/screen stream sharing and embedding on the canvas.
- Widget and processor fragment repositories (local + remote).
- State export/import for moving a canvas, its fragments and its assets between webstrates.

There is no local build/runtime step in this sync folder; runtime composition happens in the browser from fragments.

## Runtime composition

### Entry and hot reload

`Code/Core/Core.wpm/React Reloader.jsx`:

- Reads `Code/Core/Core.wpm/Reloader Config.json` (looked up as `#Core code-fragment[name="Reloader Config"]`), falling back to built-in defaults if it is missing or invalid.
  - `entryFragmentSelector`: `#App .default`.
  - `reloadFragmentSelectors`: `#code [name="Core"] [data-type="text/javascript+babel"]` — i.e. only JSX under `Code/Core` triggers a rerender.
- Creates transient `#app-root` once and caches the React root in `window.cachedAppRoot`.
- Requires the entry fragment and renders its exported `App` component; retries once if the first render fails.
- Registers `registerOnFragmentChangedHandler` on the watched fragments and rerenders (debounced ~1 s) when the reloader fragment itself is `auto`.

### Root app tree

`Code/Core/App.wpm/App.jsx`:

- Wraps everything in `GlobalEventProvider`.
- Renders:
  - `Canvas` — `CanvasView` inside an `ErrorBoundary` that is reset whenever the transient `canvas-reload-counter` DOM state changes.
  - `DynamicComponents('.dynamic-gui-component')` (dialogs/managers/sidebars/etc.).
- Shape utils and tools are **static imports**, not discovered at runtime:
  - shapes: `#Document`, `#Widget`, `#VideoStream`, `#ScreenStream` `.dynamic-shape-component`.
  - tools: the same four packages' `.dynamic-tool-component`.

### Dynamic module/component discovery

`Code/Core/CoreHelpers.wpm/Dynamic Components.jsx`:

- `DynamicComponents({ selector })`:
  - `cQuery(document).liveQuery(selector)` to track matching fragments.
  - Renders each fragment's exported `Main` inside its own `ErrorBoundary`.
  - Re-requires and re-renders on `registerOnFragmentChangedHandler`.
- `useDynamicModules(selector)` does the same for `module.Main` values instead of elements. It is currently **not used anywhere** — shapes, tools and context menus moved to static imports. Keep this in mind before assuming shape/tool registration is live.

## Extension points (fragment classes)

These classes are the plugin-style extension surfaces. Only three of them are live-queried; the rest are plain import selectors.

Live-queried (add a fragment and it appears without touching a central file):

- `.dynamic-gui-component` -> app-level UI components (`App.jsx`).
- `.dynamic-canvas-component` -> components mounted inside `<Tldraw>` (`Canvas View.jsx`).
- `.dynamic-button-bar-component` -> button-bar items (`Button Bar Component.jsx`).

Statically imported (adding one also requires editing the importer):

- `.dynamic-shape-component` -> tldraw shape utils, imported in `App.jsx`.
- `.dynamic-tool-component` -> tldraw tools, imported in `App.jsx`.
- `.dynamic-context-menu-component` -> context menu entries, imported in `Editor Changes.jsx` (`Document`, `Widget`, `AISidebar`).

## Core data/state infrastructure

### In-memory event bus

`Global Events.jsx` provides:

- `triggerEvent(eventName, data)`
- `subscribeEvent(eventName, callback) -> unsubscribe`

Used for intra-client pub/sub (chat orchestration, stream notifications, cookie sync, recorder hooks).

### DOM-backed shared state

`DOM Store.jsx` provides:

- `useDOMState(key, initialValue, storeId = 'default', persistent = true)`
- `useTransientDOMState(...)` (`persistent = false`)
- `getDOMStore/getDOMState/setDOMState/deleteDOMState`

Implementation details:

- Store nodes (`<dom-store data-store-id="...">`) are appended under `#meta-elements` (fallback `document.body`). Widget-created stores live separately under `#widget-stores` (`Widget Helpers.jsx`).
- Supports primitive/object, arrays, and `Map`.
- Uses `MutationObserver` to propagate DOM changes back into React state.
- Persistence uses Webstrates DOM sync; `WPMv2.stripProtection(...)` is applied to writable nodes.

### Fragment-backed state

`Fragment Store.jsx` provides `useFragmentState/getFragmentState/setFragmentState`, backing a value on a code fragment's text content rather than a DOM store node. It is currently not used by any package.

### Cookie state

`Cookie Store.jsx`:

- Browser cookie state scoped to `location.pathname`.
- Uses Global Events (`cookie-change:<key>`) for same-client synchronization across components.

`Webstrate Cookie Store.jsx`:

- Uses `webstrate.user.cookies.anywhere` / `.here` when logged in.
- Falls back to browser cookies when anonymous.

### String helpers

`String Utils.jsx` exposes `toTrimmedString`, `toKey`, `safeJsonParse`, `safeJsonStringify` and `readLastJsonObject` — used wherever cookie or attribute payloads are parsed (e.g. `ConnectorFactory.jsx`).

## Canvas and collaboration flow

### Canvas initialization

`Canvas View/Canvas View.jsx`:

- Creates the TL store with `defaultShapeUtils + shape utils passed from App.jsx` and `assets: new WebstrateAssetStore()`.
- Binds the store via `useDOMSync({ store, node: document.querySelector('tldraw-document') })`.
- Mounts `.dynamic-canvas-component` inside `<Tldraw>` with `options={{ maxPages: 1 }}`, and passes the `components`, `uiOverrides` and `assetUrls` from `Editor Changes.jsx`.
- On mount, publishes the editor as `window.tldrawEditor`, applies the Webstrates user id/display name to tldraw user preferences, and zooms to fit (capped at `z = 1.5`).
- Renders a loading state while `useDOMSync` is still resolving, and a "Canvas Migration Failed" panel if migration threw.

### TL store <-> DOM sync

`tldraw Components/DOM Sync.jsx`:

- If `tldraw-document` is empty, seeds base `DocumentRecord` and `PageRecord`.
- Syncs TL changes to DOM nodes (`<document|page|shape ...>` elements with JSON payload); the store schema is persisted in a `<tldraw-schema>` child.
- Syncs DOM mutations back into TL store via `mergeRemoteChanges`.
- Syncs presence:
  - TL presence -> `node.webstrate.signal(...)`.
  - Webstrate signal -> TL presence records.
- Removes presence on `webstrate clientPart`.
- Stops syncing when the window event `tldraw-canvas-state-replacing` fires, which `Stund State Transfer.jsx` dispatches before replacing the whole canvas on import.

### Schema migration

`tldraw Components/Tldraw Migration.jsx`:

- `migrateTldrawStore({ store, records, persistedSchema })` runs `store.schema.migrateStoreSnapshot` before the records are loaded.
- Documents written before the schema was persisted are assumed to be `LEGACY_TLDRAW_SCHEMA_4_2_1`.
- Returns `shouldRewriteSnapshot` so `DOM Sync.jsx` only rewrites persisted state when the schema actually changed. A failed migration leaves the persisted document untouched and surfaces the error in `Canvas View.jsx`.

### Assets

`tldraw Components/Webstrate Asset Store.jsx`:

- Upload: POST file to current path, return `./<fileName>`.
- Remove: `webstrate.deleteAsset(asset.props.name)`.

### Editor UI overrides

`tldraw Components/Editor Changes.jsx`:

- Adds tool entries for `Document`, `Widget`, `VideoStream`, `ScreenStream`, with inline SVG data-URL icons via `assetUrls`.
- Custom toolbar and custom context menu; hides `PageMenu`, `DebugPanel`, `DebugMenu` and `SharePanel`.
- Context menu includes, in order: document, widget and AI sidebar entries, then the default content.

## AI subsystem

### Main pieces

- `AISidebar` (`Code/AI Integration/AISidebar.wpm/AI Sidebar.jsx`): chat tabs + orchestration.
- `AIChatComponent` (`Code/AI Integration/AIChatComponent.wpm/`): its own package, split into
  - `AI Chat Component.jsx` — composition root, imperative controls, profile/connector menus.
  - `Chat Session.jsx` — entries, persistence, tool groups, request execution.
  - `Chat Context Controller.jsx` — image and shape context state.
  - `Context/Chat Image Context.jsx`, `Context/Chat Shape Context.jsx` — drag/drop/paste and shape/screenshot context.
  - `Utils/Chat Speech Input.jsx` — STT recording via `transcribeAudioBlob` and the `speak-prompt-transcription` model.
  - `Views/Chat Views.jsx` — `ChatHistory` and `ChatComposer` (the composer owns the prompt text box).
  - `Chat Contract.jsx` — shared keys, typedefs and the sanitizers.
- `SlopScript`: decorators, tool-calling loop, connector execution trace. `SlopScript Fragment.jsx` registers the `text/slopscript+babel` fragment type (`.slop` files); `API.jsx` (`#SlopScript .api`) re-exports `Context`, `Slop`, `Tool`, `js`, `image` and `shape`.
- Agent fragments under `Agents.wpm`, imported by id: `#main-agent-slop`, `#search-expert-slop`, `#canvas-expert-slop`, `#history-model-expert-slop`, `#widget-expert-slop`, `#processor-expert-slop`.
- `Agents.wpm/Utils/Harness Helpers.jsx` (`#Agents .harness-helpers`): the fragment coding harness used by the Widget and Processor experts — list/search/read/edit/patch/validate/write tools, each scoped to `#widget-fragments` or `#processor-fragments`.
- `Agents.wpm/Utils/Widget Helpers.jsx`: the helper API for widget code — AI calls using the user's widget model selections, speech, canvas/screenshot helpers, a widget-scoped `useDOMState` (stores under `#widget-stores`), `SharedInput`/`SharedTextArea`, and `useHistoryModelWidgetEventStream`.

`AIChatComponent` is agent-agnostic: it takes `profiles` (each `{ name, connector, onInit, onPrompt, getToolGroups }`) and optional `connectors`, so the sidebar — not the chat — knows about `MainAgent`.

### Connectors

The AI backend is a per-user setting chosen in the Model Manager's connector section; it is not
shared across clients of the webstrate. Connector ids: `litellm` (default), `openai`, `anthropic`,
`ollama`.

`Connectors/ConnectorFactory.jsx` is the single source of truth. It owns the id → backend mapping
(`CONNECTOR_DESCRIPTORS`), the cookie names, the `DEFAULT_*_URL` constants and API-key handling; the
Model Manager imports these rather than re-declaring them. `Connector.jsx` stays a pure base class
with no imports.

#### Model Manager storage

Every setting is per-user. Only the dialog's open/closed flag is DOM state, and it is transient.

| Setting | Key | Store |
|---|---|---|
| Dialog visibility | `model-manager-visible` | transient DOM state |
| Per-expert / per-widget model choice | `ai-models` | browser cookie |
| Active connector | `ai-connector` (`CONNECTOR_COOKIE`) | browser cookie |
| Connector base URLs | `ai-connector-base-urls` (`CONNECTOR_BASE_URLS_COOKIE`) | browser cookie |
| Available models (user-added) | `ai-completion-models`, `ai-image-models`, `ai-stt-models`, `ai-tts-models` | webstrate cookie |
| API keys | `API_KEY_COOKIES` (none for Ollama) | webstrate cookie |

- The available-model lists store only user-added entries; the built-in `DEFAULT_*_MODELS` are merged
  in at render time, so defaults never occupy cookie space and can be changed in code.
- Browser cookies are scoped to `location.pathname`, i.e. per webstrate. `useCookieState`
  JSON-encodes what it writes, so the factory parses on read.
- "Webstrate cookie" means the user's account only when signed in; `useWebstrateCookieState` and
  `getWebstrateCookie` silently fall back to a browser cookie for anonymous users.
- Why two stores: the browser store's `getCookie` is synchronous, which keeps `getConnectorConfig()`
  and `createConnector()` synchronous for `Main Agent.slop` and `AI Sidebar.jsx`. The webstrate
  store is `async`, which is acceptable for API keys only because they are read lazily at request
  time.

**Credentials live in the factory, not in the connectors.** `ConnectorFactory.jsx` owns
`API_KEY_COOKIES`, `getAPIKeyFromCookie(cookieName, providerLabel)` and `resetAPIKey(cookieName)`.
The connector classes are credential-free HTTP clients: the factory injects a `getApiKey` callback
that they call at request time, so constructing a connector never reads a cookie or prompts for a
key. The factory imports the connectors, so the connectors must never import the factory.

#### Two consumer paths

1. `createConnector(model, customOptions)` → a `Connector` subclass, used by `AI Sidebar.jsx` (per
   tab) and by the experts in `Main Agent.slop`. This is the tool-calling agent path.
   Ollama here uses its **native `/api/chat`** route.
2. `getConnectorConfig()` / `requireConnectorCapability(capability, label)` /
   `getConnectorAuthHeaders(config)` → plain `fetch` calls in `AI Helpers.jsx`, used by widgets (via
   `Agents.wpm/Utils/Widget Helpers.jsx`) and by chat STT. This path always speaks the **OpenAI REST
   style**: `/chat/completions`, `/audio/transcriptions`, `/audio/speech`, `/images/generations`.
   Ollama here uses its **OpenAI-compatibility layer** at `/v1/...`, not `/api/chat`.

Both read the same cookies, so the two paths always agree on which backend is in use, even though
they reach Ollama by different routes.

#### Capability matrix

Not every backend serves every route. `AI Helpers.jsx` guards each call with
`requireConnectorCapability(...)`, which throws
`"<Feature> is not supported by the '<id>' connector. Choose a different connector in the Model
Manager."` rather than silently falling back to a provider the user did not select.

| Capability | litellm | openai | anthropic | ollama |
|---|---|---|---|---|
| `chatCompletion` | ✓ | ✓ | ✓ | ✓ (OpenAI-compat) |
| `transcription` (STT) | ✓ | ✓ | ✗ | ✗ |
| `speech` (TTS) | ✓ | ✓ | ✗ | ✗ |
| `imageGeneration` | ✓ | ✓ | ✗ | ✗ |
| `webSearch` | ✓ | ✗ | ✗ | ✗ |

Ollama's compatibility layer covers chat, completions, embeddings and model listing — no audio, no
image generation. Web search is a LiteLLM proxy feature (see limitations below).

#### Conventions

- **Base URLs.** LiteLLM and Ollama store a host root and the factory appends `/v1`; OpenAI and
  Anthropic store a base that already ends in `/v1`. `getConnectorConfig().apiBase` normalizes both
  into an OpenAI-style base including the version segment.
- **Model ids.** The Model Manager's model list is LiteLLM-style and carries provider prefixes
  (`openai/gpt-6.1-sol`, `anthropic/claude-sonnet-5-5`). `config.resolveModel(model)` strips the matching
  prefix when talking to a native provider that expects a bare id.
- **Body params.** `drop_params: true` is LiteLLM-only. On the `AI Helpers.jsx` path it is supplied
  through `config.bodyExtras`; on the `createConnector` path only `LiteLLMConnector` sets it. It is
  never sent to the other three backends.
- **CORS.** `api.openai.com` and `api.anthropic.com` are blocked from the browser. Using those
  connectors in practice means overriding the base URL to point at a CORS-enabled proxy.
- **Model defaults.** The `MODEL_CONFIGS` table in `Model Manager.jsx` is the single source of model
  defaults, reached through `getModel(id)` / `useModel(id)`. `AI Helpers.jsx` and the connector
  descriptors hold none: every chat, image, TTS and STT entry point requires the caller to supply a
  model and throws if one is missing.

#### Known limitations / follow-ups

- **Web search is LiteLLM-only.** Both entry points depend on LiteLLM proxy features: `webSearch`
  calls `/v1/search/tavily-search`, and `chatCompletionWithSearch` injects an MCP tool with
  `server_url: 'litellm_proxy/mcp/tavily'`. Making search provider-independent is a real feature, not
  a config change: it means calling the Tavily API directly against its own base URL and
  `TAVILY_API_KEY`, and replacing the injected MCP tool with an ordinary function tool that the agent
  loop executes locally.
- **Unprefixed model ids are sent verbatim.** `resolveModel` only strips known provider prefixes, so
  a proxy-specific id without one (e.g. a LiteLLM alias) will 404 on the native OpenAI/Anthropic
  connectors.

### AI sidebar orchestration

`AI Sidebar.jsx`:

- Imports `MainAgent` from `#main-agent-slop`.
- Tab types:
  - Local tabs (ephemeral component state).
  - Shared tabs (`useDOMState('ai-sidebar-shared-tabs')`).
- Tracks active users for shared tabs in `useDOMState('ai-sidebar-active-users')`, pruning clients that have left.
- Keeps a per-tab connector (`createConnector(mainAgentModel)`) and a per-tab `MainAgent` instance, wired together in the tab's "Main Agent" profile (`onInit`/`onPrompt`/`getToolGroups`).
- Connector model for each tab from `useModel('main-agent')`.
- Sidebar width/minimized state in browser cookies (`ai-sidebar-width`, `ai-sidebar-minimized`); the width is published as the `--sidebar-width` custom property on `#app-root`.
- Handles global events:
  - `ai-sidebar-create-chat`
  - `ai-sidebar-update-active-chat`
- Exposes `useAISidebar()` helper API for other modules (e.g. `attachImagesToCurrentChat`, used by the context menu).

### AI chat persistence and events

`Chat Contract.jsx` defines the shared keys; `Chat Session.jsx` and `Views/Chat Views.jsx` own the state:

- DOM store namespace: `AI_CHAT_DOM_STORE_KEY = 'ai-chat'`.
- Per chat id persisted keys (shared mode only — `persistent` is `false` for local tabs):
  - `chat-entries-${chatId}`, `chat-processing-${chatId}`, `chat-toolgroups-${chatId}` (`Chat Session.jsx`)
  - `chat-input-${chatId}` (`Chat Views.jsx`, the composer)
- Emits global events:
  - `ai-chat-entry-finalized`
  - `ai-chat-step-added`
- Shared mode sanitizes binary/image payloads before persistence (`sanitizeEntriesForSharedPersistence` / `stripImageDataFromValue`); image previews are kept in local component state.
- Supports:
  - Drag/drop/paste image context.
  - Shape context + screenshot capture.
  - STT transcription via `transcribeAudioBlob`.
- Exposes imperative controls to the sidebar via `onControlState`:
  - `isReady`, `setPrompt`, `setToolGroups`, `setImages/appendImages`, `setShapes/appendShapes`, `submit`.

### Agent routing and tool groups

`Main Agent.slop` routes calls to experts:

- `SearchExpert`
- `CanvasExpert`
- `HistoryModelExpert`
- `WidgetExpert`
- `ProcessorExpert`

`MainAgent.TOOL_GROUPS` (key -> tools):

| Group | Tool | Default |
|---|---|---|
| `search` | `askSearchExpert` | on, always enabled |
| `canvasRead` | `askCanvasExpert` | on, always enabled |
| `canvasWrite` | `askCanvasExpertForChanges` | off |
| `history` | `askHistoryModelExpert` | on, always enabled |
| `widgets` | `askWidgetExpert` | off |
| `processors` | `askProcessorExpert` | off |

Tool group state is managed in `Chat Session.jsx` and passed into `MainAgent.prompt(...)` through the profile's `onPrompt`.

### SlopScript execution model

Core files:

- `Decorators/Slop.jsx`
- `Decorators/Tool.jsx`
- `Types/JS.jsx`, `Types/Image.jsx`, `Types/Shape.jsx`
- `Connectors/Connector.jsx`
- `Connectors/ConnectorFactory.jsx`
- `Connectors/LiteLLMConnector.jsx`
- `Connectors/OpenAIConnector.jsx` (also serves the Anthropic connector)
- `Connectors/OllamaConnector.jsx`

Flow:

1. `@Slop` extracts method prompt template from function body.
2. Converts custom JSON-schema types (`js`, `image`, `shape`) for tool-calling.
3. Runs iterative tool-calling loop (at most `MAX_TOOL_CALLS = 32` calls and `MAX_CONSEQUTIVE_TOOL_ERRORS = 4` consecutive errors).
4. Requires explicit control tools:
   - `resolve(...)`
   - `reject(error)`
5. Emits execution listener events (`stackEntry`, `slopCall`, `toolCall`, `toolReturn`, etc.).
6. `Connector` cancellation propagates abort to nested connectors through connector stack.

## History model subsystem

### Session and model hooks

`Session History.jsx` exposes:

- `useSession()`
- `useSessionHelpers()`
- `useSessionIngest()`
- `useSessionModel()`
- `resolveSchemaRefs(schema, schemasMap)` for the JSON schemas in `EventSchema.wpm`.

Important state keys:

- `history-session-id` (persistent DOM state)
- `history-session-joined` (transient DOM state)
- `history-session-auto-join` (persistent DOM state)
- `history-model-server` (persistent DOM state; overrides `DEFAULT_SESSION_HISTORY_SERVER` from `Session History API.jsx`)

### Session API

The history client is owned by the server, not by Stund. `Session History API.jsx` loads it once from
`<server>/session.js` (`window.SessionHistory`) and wraps it:

- `normalizeSessionHistoryServerUrl(url)` only trims, strips trailing slashes and adds `http://` when
  no scheme is given; the server URL is otherwise used as typed.
- Access tokens: `SessionHistory.generateAccessToken(entityId, masterPassword, serverUrl)` logs in and
  stores the entity key per server and entity in `localStorage` (`stund-history-auth:[server,entity]`).
  `getTokenState`, `getCredentials`, `removeAccessToken` and `invalidateToken` manage it; expired or
  rejected tokens must be regenerated.
- `SessionHistory.create(entityId, serverUrl)` / `.join(sessionId, entityId, serverUrl)` require a
  token. `create` builds the session spec with `buildSessionSpec(...)` from `Session Spec.jsx`, which
  replaces the server's `application0` processor with an `EventStreamProcessor` declaring Stund's
  `application.*` outputs and their schemas from `EventSchema.wpm`.
- The returned upstream session provides `connectIngest()`, `connectModel('history')`,
  `addProcessor(...)` / `removeProcessor(...)`, `getEvent(...)` and `resolveMediaResource(...)`.
- Ingest streams come from `ingest.startEventStream(type)` and support `createInstantEvent`,
  `createDurationEvent` and `createStateEvent`. Stund listens to the model's `eventAdded`,
  `eventUpdated` and `eventTypesChanged` events.

### Recorders

Recorder fragments (`MeetingRecorder.wpm`; `Recorder Helpers.jsx` holds the shared `cleanShapeData`/`cleanShapesData` serializers):

- `State Recorder.jsx` -> `application.state.event`
- `Interaction Recorder.jsx` -> `application.interaction.shape.created|deleted|moved|colorChanged|textChanged` and `application.interaction.document.textChanged`
- `Stream Recorder.jsx` -> forwards local streams to ingest (`user.voice`, `user.camera`)
- `Chat Recorder.jsx` -> subscribes to AI chat global events and writes:
  - `application.chat.entry`
  - `application.chat.step`

Widgets can write their own events to `application.widget.widgetEvent` through
`useHistoryModelWidgetEventStream()` in `Agents.wpm/Utils/Widget Helpers.jsx`.

Recorder toggles are cookie flags (all default to `true`):

- `stateRecorderActive`
- `interactionRecorderActive`
- `streamRecorderActive`
- `chatRecorderActive`

Event schemas live as JSON fragments in `EventSchema.wpm`: one per `application.*` event type, plus the shared `event.json` and `shape.json`.

## Streaming subsystem

### Stream manager model

`Stream Manager.jsx` exposes `StreamManager`, `useStreamSharing` and the `createStreamModule({ streamKey, signalingElementSelector, mediaAcquisitionMethod, constraints })` factory. `AudioStreamManager.wpm`, `VideoStreamManager.wpm` and `ScreenStreamManager.wpm` are thin instantiations of that factory:

- One manager per stream key (`audio-stream`, `video-stream`, `screen-stream`), each with its own signaling element (`audio-signaling`, …).
- Persistent DOM maps:
  - `client-streams-${streamKey}`: `Map<clientId, streamId>`
  - `client-names-${streamKey}`: `Map<clientId, displayName>`
- Actual `MediaStream` objects live in the `window.clientStreams` **Map**, keyed `${streamKey}${clientId}`.
- Event bus:
  - local intent events:
    - `local-stream-added-${streamKey}`
    - `local-stream-removed-${streamKey}`
  - propagated events:
    - `stream-added-${streamKey}`
    - `stream-removed-${streamKey}`
- Webstrate stream signaling via `element.webstrate.signalStream(...)`.
- The audio module additionally exports `MUTE_ALL_OTHERS_CHANGED_EVENT` / `MUTE_ALL_OTHERS_REQUEST_EVENT`, used by `Stream Center Component.jsx` and `Audio Stream Element.jsx`.

### Stream consumers

- `Audio Stream Element.jsx` creates `<audio>` for remote streams.
- `Media Stream Shape Factory.jsx` (`MediaStreamShapeFactory.wpm`) builds the stream shape util from a config; `Video Stream Shape.jsx` and `Screen Stream Shape.jsx` are one `createMediaStreamShape({...})` call each, supplying the stream key, the manager hooks, labels, icons and styling.
- `Stream Center Component.jsx` exposes quick share/stop controls, participant avatars and mute-all-others.

## Widget subsystem

### Widget shape runtime

`Widget Shape.jsx`:

- Shape prop `sourceFragmentId` points to widget fragment in `#widget-fragments`.
- If fragment missing, creates default widget skeleton fragment.
- Requires fragment and renders exported `Widget` React component.
- Listens to fragment changes and hot reloads widget component.
- Supports fullscreen mode with cookie key `fullscreen-shape-id` (shared with documents; see below).
- Supports Cauldron open/edit (installing the `Cauldron` package on demand) and widget forking (clone fragment + create new shape).

### Fullscreen

`Helpers/ShapeFullscreen.wpm/Shape Fullscreen.jsx` is a `.dynamic-canvas-component` that renders whichever shape id is in the `fullscreen-shape-id` cookie over the canvas. `Widget Shape.jsx`, `Document Shape.jsx` and `Mobile Interface Component.jsx` all read/write the same key; supported types are `Widget` and `Document`.

### Widget repository

See "Fragment repositories" below. Local container `#widget-fragments`, default remote repo `stund-widget-repository`.

## Document subsystem

`Shape Types/Document.wpm` adds a Markdown document shape:

- The shape itself is the persisted source of truth: the Markdown lives in the shape props `name` and `text`, so documents are stored and synced with the canvas records. There is no persistent document fragment.
- `useDocumentFragment` (`Document Helper.jsx`) gives each mounted view a local `text/markdown` fragment inside a detached `transient` element, only so the Codestrates preview and source editors can be reused. It is kept in two-way sync with the shape props and discarded on unmount.
- `Document Helper.jsx` also exports `createDocument`, `getDocumentText/Name` and `setDocumentText/Name`; `React Preview Editor.jsx` provides the in-shape editing/preview surface; `Document Context Menu.jsx` adds the canvas context-menu entries.
- Document edits are recorded as `application.interaction.document.textChanged`.

## Processor subsystem

### Processor fragments

- Local container: `#processor-fragments`.
- Processor fragments export a `processor` definition of type `ScriptProcessor` (`options.script`), `AIPromptProcessor` or `AIVisionProcessor` (`options.prompt`).

### Processor activation in session history

`Session History Manager.jsx` discovers local processor fragments and can activate/deactivate them on the connected session (`session.addProcessor/removeProcessor`). The server's system processors (`application0`, `transcription0`, `voicedetect0`) are shown locked and cannot be replaced or removed; active server processors without a local fragment can be deactivated.

## Fragment repositories

`Button Bar Components/FragmentRepository.wpm/Fragment Repository Factory.jsx` exports `createFragmentRepository(config)`; the widget and processor repository packages are one call each:

```js
export const Main = createFragmentRepository({
    type: 'widget', singular: 'Widget', plural: 'Widgets',
    fragmentContainerId: 'widget-fragments',
    defaultRepositoryUrl: 'stund-widget-repository',
    shapeType: 'Widget'   // omitted for processors — no canvas instances
});
```

The factory provides:

- The local fragment list (rename, describe, open in Cauldron, delete, upload; "create on canvas" and an instance count when `shapeType` is set).
- The remote repository, loaded in a hidden iframe (`/<repo>/?codestrates=false`), with folder navigation and download.
- Upload/download clones fragments and stamps `timestamp` and `from-document` attributes.
- Per-repository state:
  - `${type}-repository-visible` — transient DOM state (dialog visibility)
  - `${type}-repository-urls` — webstrate cookie (custom repositories)
  - `${type}-repository-selected` — webstrate cookie

Defaults: `stund-widget-repository`, `stund-processor-repository`.

## Other app-level packages

- `Button Bar Components/StundInfo.wpm` — about/changelog dialog (`Changelog.md`, version read from the package `descriptor.json`) plus `Stund State Transfer.jsx`, which exports/imports a state bundle: canvas records and schema from `tldraw-document` (including document content), widget/processor fragments, `#widget-stores` DOM stores, the session id and history server, and referenced canvas image assets. When importing from an older webstrate, its legacy `#document-fragments` are read once and inlined into the canvas records. `Update Head Content.js` installs the manifest link and favicon in `<head>`.
- `Button Bar Components/MobileInterface.wpm` — below `MOBILE_BREAKPOINT_PX = 900`, a menu (`mobile-interface-menu-visible`) that lists `Widget` and `Document` shapes and opens them through the shared `fullscreen-shape-id` key.
- `Button Bar Components/ButtonBarBasics.wpm` — the default button-bar entries.
- `Helpers/ButtonBar.wpm` — the button bar itself; a `.dynamic-gui-component` that renders `.dynamic-button-bar-component` fragments.
- `Helpers/Dialog.wpm` — `Dialog`, `DialogHeader`, `Section` and `DialogToggleRow` used by every dialog.
- `Helpers/CanvasHelpers.wpm` — `convertAndValidateShapes`, `createSelectionScreenshotImage` and `forwardShapeZoomWheel`.
- `Code/ImportMapping.wpm` — the esm.sh import map, pinned to the versions listed in `Dependencies.json`. The map itself is the package's `<script type="importmap">`, synced to disk as `Importmap.json` and edited there directly; its esm.sh entries mark the other packages as `external` so a single React instance is shared, and `lz-string` comes from JSPM to avoid an AMD loader conflict. On MyWebstrates, `Update Import Mapping.js` copies it into `webstrate.importMap`. See the package `README.md`.
- `Code/Core/InterFont.wpm`, `Code/Core/MaterialSymbolsFont.wpm` — fonts and icon font.

## End-to-end data flows

### 1) Shared AI chat with screenshot context

1. User selects shapes on canvas.
2. Context menu (`AI Sidebar Context Menu.jsx`) calls `createSelectionScreenshotImage(...)`.
3. `useAISidebar().attachImagesToCurrentChat(...)` emits `ai-sidebar-update-active-chat`.
4. `AI Sidebar.jsx` applies the pending request to the active chat's `onControlState` controls.
5. `Chat Session.jsx` sends prompt + tool group state + image/shape context through the profile's `onPrompt` into `MainAgent`.
6. Entry and step events are emitted (`ai-chat-entry-finalized`, `ai-chat-step-added`).
7. `Chat Recorder` persists those events into history ingest streams.
8. If the chat tab is shared, sanitized chat state is persisted in the DOM store (`ai-chat` namespace) and syncs to other clients.

### 2) Canvas collaboration

1. User modifies shapes in `tldraw`.
2. TL store changes are mirrored into `tldraw-document` DOM nodes.
3. Webstrates syncs DOM changes to other clients.
4. Remote clients' DOM mutation observer applies updates back into local TL store.
5. Presence packets are exchanged via `node.webstrate.signal` and merged into TL presence records.

### 3) Media stream sharing

1. User starts audio/video/screen via `useStreamSharing`.
2. Local event `local-stream-added-${streamKey}` is emitted.
3. `StreamManager` updates DOM maps and emits `stream-added-${streamKey}`.
4. Stream signal is negotiated via `webstrate.signalStream`.
5. Remote clients receive the stream and store the `MediaStream` in the `window.clientStreams` map.
6. Stream shapes / audio elements subscribe and render/play matching stream.

## Key runtime anchors

- App root: `#app-root` (transient).
- Canvas document mirror: `<tldraw-document>`.
- DOM state parent: `#meta-elements`; widget DOM stores: `#widget-stores`.
- Widget fragments: `#widget-fragments`.
- Processor fragments: `#processor-fragments`.
- Code root: `#code` (the `Code` folder; watched for hot reload under `[name="Core"]`).
- Active main agent fragment: `#main-agent-slop`.
- Editor handle: `window.tldrawEditor`.
- Live media streams: `window.clientStreams`.

## Deployment-specific configuration

The code carries no hosted endpoints or private models, so the public repository works against any
backend. The defaults are placeholders that must be replaced before the feature works:

| Setting | Code default | Configured in | Scope |
|---|---|---|---|
| LiteLLM base URL | `DEFAULT_LITELLM_URL = https://your-litellm-server.com` | Model Manager → Connector | per user (`ai-connector-base-urls` cookie) |
| History server | `DEFAULT_SESSION_HISTORY_SERVER = https://your-stund-session-server.com` | Session History Manager | per webstrate (`history-model-server` DOM state) |
| Available models | `DEFAULT_*_MODELS` (public provider ids only) | Model Manager → Available Models | per user (`ai-*-models` webstrate cookies) |
| Model selections | `MODEL_CONFIGS` (STT: `openai/whisper-1`) | Model Manager | per user (`ai-models` cookie) |

A deployment's own hosts and models can also be applied with a browser-console snippet that writes
the same keys. Keep such snippets out of the repository. Browser cookies are per path, so per-user
settings have to be applied on each webstrate.

Note that an override equal to the code default is stored as empty (`''`), meaning "use the default".
Changing a default therefore also moves every webstrate that relied on it; those need an explicit
override.

## Practical implications for development

- New GUI, canvas or button-bar components only need the right dynamic class. New **shapes, tools and context menus** additionally need an import in `App.jsx` / `Editor Changes.jsx`.
- Hot reload only watches JSX under `Code/Core`; changes elsewhere reload through each component's own fragment-changed handler, so a full app rerender may need a manual reload (or a change to `Reloader Config.json`).
- Cross-client durable UI state should usually use `useDOMState`; per-user settings should use cookie/webstrate-cookie hooks.
- Shared AI chats must avoid large/binary payload persistence; keep metadata only.
- Stream object references are not persisted in DOM; only ids are. Always resolve actual streams from the `window.clientStreams` map.
- Repository dialogs rely on iframe `cQuery` availability and can briefly show empty state until iframe APIs load.
- `Widget` and `Document` shapes share the fullscreen key; extend both when touching that behaviour.
- Never hard-code deployment-specific endpoints, models or keys; see "Deployment-specific configuration".
