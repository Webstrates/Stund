/**
 * @file SessionHistory Client Library
 * @module SessionHistory
 * @author Janus Kristensen - CAVI, Center for Advanced Visualization and Interaction - Aarhus University
 * @license MIT
 * @description Client-side companion to the SessionHistoryServer: joins or
 * creates sessions over a websocket, establishes the WebRTC ingest connection,
 * publishes instant and duration events on data channel streams, and
 * subscribes to history models with live event updates. The library is served
 * by the server itself (at <code>/session.js</code>) and has no dependencies.
 *
 * The server is protected by an auth layer: every request must present an
 * entityKey minted via <code>POST /login</code> with the master password from
 * the server's config.json. Log in first with
 * {@link SessionHistory.login} — the key is remembered for the page and
 * across reloads, and {@link SessionHistory.create}/{@link SessionHistory.join}
 * act as that logged-in entity.
 *
 * Sessions are built from client-supplied specs: {@link SessionHistory.create}
 * takes the spec (the processors to install and the models that gather
 * events — no server-side defaults). Fetch a starting point with
 * {@link SessionHistory.defaultSpec}.
 *
 * @example <caption>Logging in and joining a session</caption>
 * // <script src="/session.js"></script>
 * await SessionHistory.login("my-entity", "<the master password>"); // once per entity
 * const session = await SessionHistory.create(await SessionHistory.defaultSpec()); // or .join(sessionId)
 * const ingest  = await session.connectIngest();
 * const notes   = await ingest.startEventStream("application.myapp.notes");
 * notes.createInstantEvent({ text: "hello" });
 *
 * @example <caption>Watching the recorded history live</caption>
 * const history = await session.connectModel("history");
 * history.addEventListener("eventAdded", (event) => {
 *     console.log(event.type, event.data); // every recorded event, past and future
 * });
 */

/**
 * Debug logging for the library: everything the library would print on the
 * info level (websocket/WebRTC chatter, negotiated descriptions, track
 * changes) is gated behind <code>SessionHistory.DEBUG</code>, which is false
 * by default. Warnings and errors are never gated.
 */
const shDebugLog = (...args) => {
    if (window.SessionHistory?.DEBUG === true) console.log(...args);
};

/**
 * Overall cap on waiting for the ingest base data channel after the SDP
 * answer was sent. A server offer that (erroneously) carries no data
 * channel m-line never opens one, and ICE/DTLS failures can otherwise
 * leave {@link SessionHistory#connectIngest} pending forever — this bound
 * turns both into a prompt, descriptive rejection.
 * @constant
 */
const BASE_CHANNEL_TIMEOUT_MS = 30000;

/**
 * The remembered entityKey of the auth layer and the entity it belongs to
 * (module-private; use {@link SessionHistory.login},
 * {@link SessionHistory.setEntityKey} and {@link SessionHistory.clearEntityKey}
 * to manage it). The key is also mirrored to localStorage so it survives page
 * reloads; the memory copy wins while the page lives.
 */
const shEntityAuth = {
    key: null,
    entity: null
};

/** localStorage names the entityKey is mirrored under. */
const SHS_ENTITY_KEY_STORAGE = "shsEntityKey";
const SHS_ENTITY_KEY_ENTITY_STORAGE = "shsEntityKeyEntity";

/**
 * localStorage may be unavailable (privacy settings, sandboxed iframes); all
 * access to it is best-effort and never throws.
 */
const shStorage = {
    get(name){
        try { return window.localStorage?.getItem(name) ?? null; }
        catch { return null; }
    },
    set(name, value){
        try { window.localStorage?.setItem(name, value); }
        catch { /* unavailable - the key then only lives for this page */ }
    },
    remove(name){
        try { window.localStorage?.removeItem(name); }
        catch { /* unavailable */ }
    }
};

/**
 * A connection to a SessionHistory session: the command websocket, the
 * (optional) WebRTC ingest connection and any number of model subscriptions.
 * Obtain instances through {@link SessionHistory.join} or
 * {@link SessionHistory.create} — never through the constructor.
 *
 * @class SessionHistory
 */
class SessionHistory {
    /**
     * Log in as `entityId` and obtain the entityKey every subsequent call
     * presents to the server. POSTs `{entity, masterPassword}` to
     * <code>/login</code>; on success the server's reply (the entityKey and
     * its expiry) is stored in the library — keyed onto every websocket,
     * session creation, export and media request — and mirrored to
     * localStorage so it survives page reloads. Anyone who knows the master
     * password can claim any entity id; browser-based OpenID Connect login
     * is planned for the server but not implemented yet.
     * @param {string} entityId - The entity id to claim (the server mints a
     *   key granting exactly this entity).
     * @param {string} masterPassword - The master password from the server's
     *   config.json (see its README).
     * @returns {Promise<{entityKey: string, entity: string, created: number, expires: number, source: string}>}
     *   The server's login reply.
     * @throws Rejects with the server's error text on a wrong password, an
     *   unconfigured server (no master password set) or a rejected entity id.
     * @example
     * const { expires } = await SessionHistory.login("my-entity", "the master password");
     * const session = await SessionHistory.create(await SessionHistory.defaultSpec());
     */
    static async login(entityId, masterPassword){
        const response = await fetch(SessionHistory.serverBase + "login", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entity: entityId, masterPassword: masterPassword })
        });
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Login as "${entityId}" failed. Status: ${response.status}`);
            throw new Error(errorText);
        }
        const loginInfo = await response.json();
        SessionHistory.setEntityKey(loginInfo.entityKey, loginInfo.entity ?? entityId);
        shDebugLog("Logged in as", loginInfo.entity, "until", new Date(loginInfo.expires));
        return loginInfo;
    }

    /**
     * Explicitly install an entityKey (as obtained from a previous
     * {@link SessionHistory.login} in another page or session) instead of
     * logging in again. The key is remembered for the page and mirrored to
     * localStorage.
     * @param {string} entityKey - The entityKey to present to the server.
     * @param {string} [entityId] - The entity the key grants; the value from
     *   the login reply. Defaults to null, which limits
     *   {@link SessionHistory#getEntityKeyFor} matching — pass it when known.
     */
    static setEntityKey(entityKey, entityId=null){
        shEntityAuth.key = entityKey ?? null;
        shEntityAuth.entity = entityId ?? null;
        if (shEntityAuth.key){
            shStorage.set(SHS_ENTITY_KEY_STORAGE, shEntityAuth.key);
            shStorage.set(SHS_ENTITY_KEY_ENTITY_STORAGE, shEntityAuth.entity ?? "");
        } else {
            shStorage.remove(SHS_ENTITY_KEY_STORAGE);
            shStorage.remove(SHS_ENTITY_KEY_ENTITY_STORAGE);
        }
    }

    /**
     * Forget the remembered entityKey (memory and localStorage). The next
     * server interaction will be rejected until a new
     * {@link SessionHistory.login}.
     */
    static clearEntityKey(){
        SessionHistory.setEntityKey(null);
    }

    /**
     * The remembered entityKey, or null when none is (or none for that
     * entity).
     * @returns {?string} The entityKey currently presented to the server.
     */
    static getEntityKey(){
        return shEntityAuth.key;
    }

    /**
     * The remembered entityKey, but only when it grants exactly `entityId`.
     * The server rejects a key that claims a different entity than the
     * session id it is used with, so calls always present the key matching
     * the entity they act as.
     * @param {string} entityId - The entity the key must grant.
     * @returns {?string} The entityKey for that entity, or null when the
     *   remembered key grants another entity or none is remembered.
     */
    static getEntityKeyFor(entityId){
        return (shEntityAuth.key && shEntityAuth.entity === entityId) ? shEntityAuth.key : null;
    }

    /**
     * The entity the remembered entityKey grants — the identity every
     * {@link SessionHistory.create}/{@link SessionHistory.join} call acts
     * as (it is no longer a parameter of those calls;
     * {@link SessionHistory.login} establishes it).
     * @returns {?string} The current entity id, or null when not logged in.
     */
    static getEntity(){
        return shEntityAuth.entity;
    }

    /**
     * Append the remembered entityKey to a URL as its <code>entityKey</code>
     * query parameter — the transport used for websockets (which cannot set
     * headers) and for media/export URLs (fetches could send headers, but a
     * single keying rule keeps every request uniformly keyed).
     * @param {string} url - The URL to key.
     * @param {string} [key] - The key to append; defaults to the remembered
     *   one ({@link SessionHistory#getEntityKey}). A null/absent key returns
     *   the URL unchanged — the server then rejects with a descriptive 401.
     * @returns {string} The keyed URL.
     */
    static withEntityKey(url, key){
        key = key || SessionHistory.getEntityKey();
        if (!key) return url;
        return url + (url.includes("?") ? "&" : "?") + "entityKey=" + encodeURIComponent(key);
    }

    /**
     * Join an existing session over a websocket, acting as the entity of the
     * last {@link SessionHistory.login}.
     * @param {string} sessionId - The session to join (its UUID).
     * @returns {Promise<SessionHistory>} Resolved once the command websocket is open.
     * @throws Rejects if not logged in yet, or if the websocket cannot be
     *   established (unknown session, unreachable server, missing/expired
     *   entityKey, ...).
     * @example
     * await SessionHistory.login("alice", "the master password");
     * const session = await SessionHistory.join("4dc0a2e8-...");
     */
    static async join(sessionId){
        if (!SessionHistory.getEntityKey() || !SessionHistory.getEntity()){
            throw new Error("join() needs an identity - call SessionHistory.login(entityId, masterPassword) first");
        }
        let session = new SessionHistory(sessionId, SessionHistory.getEntity());
        await session.waitForWebsocket();
        return session;
    }

    /**
     * Create a new session from a client-supplied spec and join it. The
     * session's owner is the entity of the last
     * {@link SessionHistory.login} (painted by the server from the
     * entityKey), and the spec — not any server-side default — defines the
     * session's processors and models. Convenience shorthand for POSTing
     * to `/session` followed by {@link SessionHistory.join}.
     * @param {Object} spec - The session spec:
     *   `{processors:[{name,type,config},...], models:[{name,config:{inputs:{...}}},...]}`.
     *   Processor entries use exactly the addProcessor wire shape, and a
     *   config field left out falls back to that processor's built-in
     *   default. Fetch {@link SessionHistory.defaultSpec} for a generic
     *   starting point (or `/application-spec.json` for the reference
     *   application's setup).
     * @returns {Promise<SessionHistory>} The joined session.
     * @throws Rejects if not logged in yet, or with the server's error text
     *   if the spec is invalid or the session could not be created.
     * @example
     * await SessionHistory.login("my-entity", "the master password");
     * const session = await SessionHistory.create(await SessionHistory.defaultSpec());
     * console.log(session.getId());
     */
    static async create(spec){
        const entityKey = SessionHistory.getEntityKey();
        if (!entityKey || !SessionHistory.getEntity()){
            throw new Error("create() needs an identity - call SessionHistory.login(entityId, masterPassword) first");
        }

        // Request a new session built from the spec
        const response = await fetch(SessionHistory.withEntityKey(
            SessionHistory.serverBase + "session", entityKey), {
            method: 'POST', // The HTTP method for creation
            headers: {
                // Must specify that you are sending JSON
                'Content-Type': 'application/json'
            },
            // Convert the JavaScript object to a JSON string
            body: JSON.stringify({
                spec: spec
            })
        });

        // Check if the response status is 201 Created (or 200 OK)
        if (response.ok) {
            // Parse the JSON body of the response
            const sessionData = await response.json();
            const sessionId = sessionData.sessionId;
            shDebugLog('Generated SessionHistory ID:', sessionId);

            return await SessionHistory.join(sessionId);
        } else {
            // A key that was actually presented but is no longer accepted is
            // stale (expired since the last login) — forget it so the next
            // call demands a fresh login instead of replaying the corpse.
            if (response.status === 401 && entityKey) SessionHistory.clearEntityKey();
            // Handle HTTP error status codes
            console.error(`Error creating session. Status: ${response.status}`);
            const errorText = await response.text();
            throw new Error(errorText);
        }
    }

    /**
     * The server's generic default session spec, fetched once from
     * <code>/default-spec.json</code> and cached: the voice pipeline and
     * the history model, without any application event vocabulary — new
     * applications start here and add their own processors. The reference
     * application's full setup is served at
     * <code>/application-spec.json</code>.
     * @returns {Promise<Object>} The default spec, ready to pass to
     *   {@link SessionHistory.create}.
     */
    static async defaultSpec(){
        if (!SessionHistory._defaultSpec){
            SessionHistory._defaultSpec = fetch(SessionHistory.serverBase + "default-spec.json").then((response) => {
                if (!response.ok) throw new Error(`Could not fetch default-spec.json (${response.status})`);
                return response.json();
            }).catch((error) => {
                SessionHistory._defaultSpec = null; // let a later call retry
                throw error;
            });
        }
        return SessionHistory._defaultSpec;
    }
    
    /**
     * Opens the command websocket to `/session/{sessionId}/{entityId}`.
     * Not part of the public API — use {@link SessionHistory.join} or
     * {@link SessionHistory.create} instead.
     * @private
     * @param {string} sessionId - The session to connect to.
     * @param {string} entityId - The entity to connect as.
     */
    constructor(sessionId, entityId) {
        const self = this;
        this.pendingOps = {};
        this.opCounter = 0;
        this.ingest = null;
        // The websocket presents its entityKey as a query parameter (the
        // handshake cannot set headers) when one is remembered for this
        // entity.
        const entityKey = SessionHistory.getEntityKeyFor(entityId);
        let serverUrl = SessionHistory.withEntityKey(
            SessionHistory.serverBase
                + "session/" + encodeURIComponent(sessionId)
                + "/" + encodeURIComponent(entityId),
            entityKey);
        this.models = {};
        this.streams = new Set(); // every open ingest event stream, closed by dispose()
        this.disposed = false;
        this.id = sessionId;
        this.entity = entityId;

        this.websocketOpen = false;
        this.everOpen = false;
        this.onOpenPromise = new Promise((resolve, reject)=>{
            self.websocket = new WebSocket(serverUrl);

            self.websocket.onopen = ()=>{
                shDebugLog("SessionHistory Websocket opened");
                self.websocketOpen = true;
                self.everOpen = true;
                resolve();
            };

            self.websocket.onclose = (event)=>{
                shDebugLog("SessionHistory Websocket closed", event);
                self.websocketOpen = false;
                if (!self.everOpen) {
                    // The handshake was refused (browsers hide the HTTP
                    // status of a failed websocket upgrade behind a bare
                    // close) — point at the auth layer, the usual reason.
                    reject(new Error("Unable to connect to: "+serverUrl+" — the server refused the connection"
                        + (entityKey
                            ? " (the entityKey may have expired or does not grant '"+entityId+"'; log in again with SessionHistory.login('"+entityId+"', masterPassword))"
                            : " (no entityKey is known for '"+entityId+"'; log in first with SessionHistory.login('"+entityId+"', masterPassword), or pass {masterPassword} to create/join)")
                        + ")"));
                } else {
                    reject("Unable to connect to: "+serverUrl);
                }
                self.failPendingOps("The connection to the server closed before a reply arrived");
            };

            self.websocket.onmessage = (msg)=>{
                self.handleMessage(JSON.parse(msg.data));
            };
        });
    }

    /**
     * The id (UUID) of the joined session.
     * @returns {string} sessionId
     */
    getId(){
        return this.id;
    }
        
    /**
     * Establish the WebRTC ingest connection: offer/answer negotiation over
     * the command websocket, ICE, DTLS, and the base data channel. There is
     * one ingest connection per {@link SessionHistory} — calling this again
     * returns the existing one.
     * @param {Object} [userICEConfig] - RTCPeerConnection config overrides
     *   (iceServers etc.), merged over the defaults.
     * @returns {Promise<WebRTCIngestConnection>} The ingest connection, ready
     *   to {@link WebRTCIngestConnection#startEventStream start event streams}
     *   and {@link WebRTCIngestConnection#startMediaStream media streams}.
     * @example
     * const ingest = await session.connectIngest();
     * const poses  = await ingest.startEventStream("application.demo.pose");
     */
    async connectIngest(userICEConfig={}){
        if (this.disposed) throw new Error("Cannot connect the ingest of a disposed session — join or create a new session instead");
        if (!this.ingestPromise) {
            this.ingestPromise = (async ()=>{
                await this.waitForWebsocket();
                // The session may have been disposed while we waited for
                // the websocket — bailing out here (before the peer
                // connection exists) leaves nothing to clean up.
                if (this.disposed) throw new Error("The session was disposed before the ingest connection was established");
                this.ingest = new WebRTCIngestConnection(this, userICEConfig);
                await this.ingest.start();
                return this.ingest;
            })();
        } else {
            shDebugLog("Notice: connectIngest called more than once? Using existing connection");
        }

        return await this.ingestPromise;
    }
    
    /**
     * Subscribe to a server-side model: its full recorded history replays as
     * `eventAdded` notifications on the returned {@link HistoryModel}, after
     * which every new event arrives live. Each call gets its own subscription.
     * @param {string} modelName - The model to subscribe to; every session
     *   ships with the `"history"` model.
     * @returns {Promise<HistoryModel>} The model subscription.
     * @example
     * const history = await session.connectModel("history");
     * history.addEventListener("eventAdded", (event) => render(event));
     */
    async connectModel(modelName){
        if (this.disposed) throw new Error("Cannot subscribe to a model on a disposed session — join or create a new session instead");
        await this.waitForWebsocket();
        let subscriptionInfo = await this.sendWithReply({cmd:"connectModel", model:modelName});
        // The reply may be the synthetic give-up from sendWithReply (the
        // session was disposed, or the server never answered): there is
        // no subscription to hand out then — reject instead of building a
        // model that can never receive anything.
        if (subscriptionInfo.timedOut) throw new Error("The model subscription was never established: "+subscriptionInfo.message);
        if (this.disposed) throw new Error("The session was disposed before the model subscription was established");
        this.models[subscriptionInfo.subscription] = new HistoryModel(this, modelName, subscriptionInfo.subscription);
        return this.models[subscriptionInfo.subscription];
    }

    /**
     * Start the session (owner only) — marks the session as live in its
     * schema, e.g. to delimit the official recording window. The server
     * stamps the start time into the schema (broadcast as a
     * `schemaChange`) and acknowledges the start with a reply.
     * @returns {Promise<Object>} The server reply; rejects with the
     *   server's message if the session could not be started (not the
     *   owner, already started, already ended, ...).
     */
    async start(){
        return await this.sendWithReply({cmd:"start"});
    }

    /**
     * Stop the session (owner only) and stamp its schema with an end time.
     * The server broadcasts the updated schema and acknowledges the stop
     * with a reply.
     * @returns {Promise<Object>} The server reply; rejects with the
     *   server's message if the session could not be stopped (not the
     *   owner, not started, already ended, ...).
     */
    async stop(){
        return await this.sendWithReply({cmd:"stop"});
    }

    /**
     * Export the whole session as a single MP4 archive and download it as
     * <code>sesraw_&lt;timestamp&gt;.mp4</code>. The archive embeds every
     * session resource byte-exactly (the sidecars verbatim as MP4 user-data
     * boxes, the media additionally as playable tracks in true relative
     * timing). Owner only; the session must have been at least started.
     * <p>The download is triggered automatically; the returned object URL
     * and file name are also exposed for callers that want to handle the
     * blob themselves (revoke it with
     * <code>URL.revokeObjectURL()</code> when done).</p>
     * <p>The export is keyed with the entityKey remembered for this
     * session's entity ({@link SessionHistory.login}) — the server derives
     * the requesting identity from it; there is no entity parameter to
     * spoof.</p>
     * @param {string} [type="raw"] - The export type; currently only
     *   <code>"raw"</code> (the full session archive) is supported.
     * @returns {Promise<{url: string, filename: string}>} Object URL and
     *   file name of the downloaded archive.
     * @throws Rejects with the server's error text if the export is refused
     *   (not the owner, session not started, expired entityKey, ...).
     * @example
     * const { filename } = await session.export(); // downloads sesraw_1792....mp4
     */
    async export(type="raw"){
        const entityKey = SessionHistory.getEntityKeyFor(this.entity);
        const response = await fetch(SessionHistory.withEntityKey(
            SessionHistory.serverBase + "session/" + encodeURIComponent(this.id)
            + "/export?type=" + encodeURIComponent(type),
            entityKey));
        if (!response.ok) {
            // A presented-but-rejected key is stale — forget it.
            if (response.status === 401 && entityKey) SessionHistory.clearEntityKey();
            throw new Error(await response.text());
        }
        const disposition = response.headers.get("Content-Disposition") || "";
        const match = disposition.match(/filename="?([^";]+)"?/);
        const filename = match ? match[1] : ("sesraw_" + Date.now() + ".mp4");
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        return {url, filename};
    }

    /**
     * Remove a processor from the session. Its derivation stops and a
     * schemaChange is broadcast to every subscriber.
     * <p><b>Note:</b> removing a <code>ScriptProcessor</code> currently shuts
     * down the shared executor used by <em>all</em> script processors in the
     * JVM, stopping every other one as well — see the functional tests
     * (tests/README.md) for the tracked bug.</p>
     * @param {string} processorId - Name the processor was added under.
     * @returns {Promise<Object>} Reply with `status:false` plus a message if no
     *   such processor exists.
     */
    async removeProcessor(processorId){
        return await this.sendWithReply({cmd:"removeProcessor", processor:processorId});
    }    
    
    /**
     * Add a processor to the session (sandboxed server-side JavaScript
     * derivations, AI processors, ...). Its outputs and schemas become part of
     * the session schema, and a schemaChange is broadcast to every subscriber.
     * Adding under an existing name replaces that processor.
     * @param {string} processorId - A unique name for the processor instance.
     * @param {string} type - Processor type; `"ScriptProcessor"` for sandboxed
     *   JavaScript.
     * @param {Object} config - Type-specific configuration. For
     *   `"ScriptProcessor"`: `language`, `script`, `inputs` (type regex →
     *   filter), `outputs` (type → schemaId), `schemas` (schemaId → JSON
     *   schema), `emitLogEvents`, `emitExceptionEvents`.
     * @returns {Promise<Object>} The server reply; rejects with the server's
     *   message on invalid configuration. 
     * @example
     * await session.addProcessor("shout0", "ScriptProcessor", {
     *     language: "js",
     *     script: `
     *         let s = null;
     *         function init() { s = stund.startEventStream("application.demo.shout"); }
     *         function onEventAdded(ev) {
     *             if (ev.type === "application.demo.note")
     *                 s.createInstantEvent({ shout: ev.data.note.toUpperCase() }, ev.start);
     *         }`,
     *     inputs:  { "application\\.demo\\.note": {} },
     *     outputs: { "application.demo.shout": { schemaId: "stund://shout.json", internal: true } },
     *     schemas: { "stund://shout.json": {
     *         type: "object", properties: { shout: { type: "string" } },
     *         required: ["shout"], additionalProperties: false } },
     * });
     */
    async addProcessor(processorId, type, config){
        return await this.sendWithReply({config:config, cmd:"addProcessor", name: processorId, type: type});
    }

    /**
     * List the processor types this server can instantiate.
     * @returns {Promise<Object>} The server reply carrying the supported types.
     */
    async getSupportedProcessors(){
        return await this.sendWithReply({cmd:"getSupportedProcessors"});
    }    

    /**
     * Fetch the current state of a single event by id from the session's
     * history model.
     * @param {string} id - The event id to fetch (as seen in model events or
     *   track events).
     * @param {Object} [options] - Serialization options; `includeMeta: true`
     *   is intended to additionally include event generation information
     *   (`created`, `sourceEvents`, `processor`). <b>Note:</b> the server
     *   currently ignores this option and always includes the meta fields.
     * @returns {Promise<Object>} Reply carrying the event under `event`.
     * @example
     * const reply = await session.getEvent(trackEvent.id);
     * const url = session.resolveMediaResource(reply.event.track.resource);
     */
    async getEvent(id, options={includeMeta:false}){
        return await this.sendWithReply({cmd:"getEvent", options, id});
    }        
    
    /**
     * Turn a media resource name (a track event's `track.resource`, e.g.
     * `user.demo.cam.video_demo-0.vp8.mkv`) into the absolute URL it is
     * served from. The server streams these Matroska files over HTTP while
     * they are still growing. The URL carries the remembered entityKey as
     * its query parameter (media elements cannot send headers).
     * @param {string} relativePath - The resource name from the track event.
     * @returns {string} The keyed URL serving this recording
     *   (`/session/{id}/media/{name}?entityKey=...`).
     */
    async resolveMediaResource(relativePath){
        return SessionHistory.withEntityKey(
            SessionHistory.serverBase + "session/"+this.id+"/media/"+relativePath,
            SessionHistory.getEntityKeyFor(this.entity) || SessionHistory.getEntityKey());
    }


    /**
     * Close the session connection: finalizes and closes every open ingest
     * event stream ({@link SCTPEventStream}), tears down the WebRTC ingest
     * connection (if one was established — including one that is still
     * negotiating), closes every model subscription ({@link HistoryModel}),
     * gives up on every command still awaiting a reply and closes the
     * command websocket. Recorded history stays on the server. The session
     * cannot be reused afterwards — open a new one with
     * {@link SessionHistory.join} or {@link SessionHistory.create}.
     *
     * <p>Cleaning up is safe from <b>any</b> state: a websocket that is
     * still connecting, an ingest negotiation still in flight, open event
     * streams and model subscriptions, or a second call to dispose — none
     * of them throw and none of them leave anything open. Open state
     * events are finalized while their data channels can still carry the
     * final updates; media recordings are finalized by the server when the
     * connection drops. Local <code>getUserMedia</code> tracks are
     * deliberately left running (the caller owns them — stop them via
     * {@link WebRTCIngestConnection#stopMediaStream} or
     * <code>track.stop()</code> if done with them).</p>
     */
    dispose() {
        if (this.disposed) return;
        this.disposed = true;

        // Finalize and close every open ingest event stream while the
        // connection can still carry their last event updates.
        // SCTPEventStream#close never throws.
        for (const stream of Array.from(this.streams)) {
            stream.close();
        }
        this.streams.clear();

        // Tear down the ingest connection from any state — including a
        // negotiation that is still in flight (its pending connectIngest()
        // promise rejects instead of hanging forever).
        if (this.ingest) {
            this.ingest.dispose();
            this.ingest = null;
        }
        this.ingestPromise = null;

        // Close every model subscription; model changes still in flight
        // are ignored instead of throwing (see handleMessage).
        for (const model of Object.values(this.models)) {
            model.close();
        }
        this.models = {};

        if (this.websocket) {
            this.websocket.close(); // the onclose handler fails pending replies
            this.websocket = null;
            this.websocketOpen = false;
        } else {
            this.failPendingOps("The session was disposed before a reply arrived");
        }
    }

    /**
     * Promise for the command websocket being open. Generally not needed —
     * every public method awaits it internally.
     * @private
     * @returns {Promise<void>}
     */
    waitForWebsocket() {
        return this.onOpenPromise;
    }

    /**
     * Dispatch incoming websocket messages: replies to pending operations,
     * ICE candidates, model changes and schema changes.
     * @private
     * @param {Object} msg - The parsed message from the server.
     */
    handleMessage(msg) {
        switch(msg.cmd) {
            case "status": 
                break;
            case "return": 
                if (this.pendingOps[msg.op]){
                    const entry = this.pendingOps[msg.op];
                    delete this.pendingOps[msg.op];
                    entry.onReply(msg);
                } else {
                    console.warn("Unmatched op", msg);
                }
                break;
            case "iceCandidate":
                if (!this.ingest || !this.ingest.peerConnection) {
                    console.warn("Ignoring iceCandidate for a session with no open ingest connection", msg);
                    break;
                }
                this.ingest.onRemoteICECandidate(msg);
                break;
            case "modelChange":
                // A subscription unknown here is one that was disposed of
                // while the message was in flight (or never made) — ignore
                // it instead of throwing inside the message handler.
                this.models[msg.subscription]?.handleChangeMessage(msg);
                break;
            case "schemaChange":
                this.schema = msg.schema;

                // Notify model listeners
                for (let [subscription, model] of Object.entries(this.models)) {
                    model.handleSchemaChange(this.schema);
                }
                break;
            case "ingestError":
                // The server could not set up the recording for one of this
                // connection's media streams (unannounced mid, unsupported
                // codec, missing GStreamer element, ...): the stream described
                // by the message is NOT being recorded. Always logged -
                // errors are never debug-gated. Apps can react by assigning
                // their own `session.ingest.onIngestError = (msg) => {...}`.
                console.error(`SessionHistory ingest error: ${msg.message ?? "unknown failure"}`, msg);
                if (typeof this.ingest?.onIngestError === "function") this.ingest.onIngestError(msg);
                break;
            default:
                shDebugLog("Unhandled SessionHistory cmd:", msg);
        }
    }

    /**
     * Send a raw command to the server over the websocket. An incrementing
     * `op` counter is stamped onto the message automatically.
     * @private
     * @param {Object} msg - The command object (e.g. `{cmd:"getSupportedProcessors"}`).
     * @throws If the websocket is not open.
     */
    sendMessage(msg) {
        if(!this.websocketOpen) {
            throw new Error("Trying to send over closed websocket");
        }
        this.opCounter++;
        msg.op = this.opCounter;
        this.websocket.send(JSON.stringify(msg));
    }
    
    /**
     * Send a command and await the server's matching reply (matched on the
     * stamped `op` counter). This is the general command mechanism every
     * other method builds on.
     * @param {Object} msg - The command object, e.g. `{cmd:"getEvent", id:"1a"}`.
     * @param {number} [timeoutMs=6000] - How long to wait for the reply
     *   before giving up on it. 
     * @returns {Promise<Object>} The reply; rejects with the server's
     *   message when it reports `status:false`. When the server never
     *   answers (or the connection goes away first) the promise instead
     *   resolves with a synthetic `{status:false, timedOut:true, message}`
     *   reply — giving up on a command is not an error (a command the
     *   server does not know, for instance, is never answered at all),
     *   so check `timedOut` where the distinction matters.
     */
    sendWithReply(msg, timeoutMs=6000){
        let self = this;
        let stack = new Error("Failed network operation and failed to provide a reason why");
        return new Promise((resolve, reject)=>{
            self.sendMessage(msg);
            const op = this.opCounter;
            // Give up on the reply: resolve with a synthetic status:false
            // reply instead of leaving the caller pending forever — the
            // server never answers some commands at all (an unknown
            // command, for instance).
            const giveUp = (message)=>{
                delete self.pendingOps[op];
                resolve({status:false, timedOut:true, message: message});
            };
            const entry = {
                onReply: (reply)=>{
                    clearTimeout(entry.timer);
                    if (reply.status){
                        resolve(reply);
                    } else {
                        if (reply.message) stack.message = reply.message;
                        reject(stack);
                    }
                },
                giveUp: giveUp,
                timer: setTimeout(()=>giveUp("Timed out after "+timeoutMs+"ms waiting for the reply to command "+(msg.cmd ?? JSON.stringify(msg))), timeoutMs)
            };
            self.pendingOps[op] = entry;
        });
    }

    /**
     * Give up on every command still awaiting a reply — used when the
     * connection goes away (websocket closed, session disposed), so no
     * caller is left pending on a reply that can no longer arrive. Each
     * pending promise resolves with the synthetic reply from
     * {@link SessionHistory#sendWithReply}.
     * @private
     */
    failPendingOps(reason) {
        const pending = this.pendingOps;
        this.pendingOps = {};
        for (const op of Object.keys(pending)) {
            clearTimeout(pending[op].timer);
            pending[op].giveUp(reason);
        }
    }

    /**
     * Returns the schema definition for the data field of events emitted by a
     * specific processor. Schemas arrive with the session schema; see also
     * {@link HistoryModel#getOutputs} for discovering them per event type.
     * @param {string} processorId - The ID of the processor (e.g., "transcription0").
     * @param {string} schemaId - The URI/ID of the schema (e.g., "stund://openAITranscription.json").
     * @returns {Object} The schema definition.
     * @throws If the processor or schema does not exist.
     */
    getEventDataSchema(processorId, schemaId) {
        const processor = this.schema.processors[processorId];
        
        if (!processor || !processor.config || !processor.config.schemas) {
            throw Error("No such processor "+processorId);
        }

        const schema = processor.config.schemas[schemaId];
        if (!schema) throw Error("No such schema URI for processor "+processorId+": "+schemaId);
        return schema;
    }    

    /**
     * The basic structure of all timed events in the system, as a JSON schema.
     * Every recorded event — ingested, derived or debug — carries these fields;
     * the contents of `data` are described per event type by the schemas from
     * {@link SessionHistory#getEventDataSchema}.
     * @returns {Object} The JSON schema for all timed events.
     */
    getBaseEventSchema(){
        return {
            "$schema": "http://json-schema.org/draft-07/schema#",
                "title": "Base timed event",
                    "description": "This template is used for all event types",
                        "type": "object",
                            "required": [
                                "type",
                                "id",
                                "start",
                                "data"
                            ],
                                "properties": {
                "type": {
                    "type": "string",
                        "description": "The event stream name used for this type of events"
                },
                "id": {
                    "type": "string",
                        "description": "A guaranteed unique ID for this event that stays fixed if tentative is true and it updates in the future"
                },
                "start": {
                    "type": "integer",
                        "format": "int64",
                            "description": "Start timestamp (unix timestamp in ms)"
                },
                "end": {
                    "type": [
                        "integer",
                        "null"
                    ],
                        "format": "int64",
                            "description": "End timestamp (unix timestamp in ms, optional, nullable)"
                },
                "tentative": {
                    "type": [
                        "boolean",
                        "null"
                    ],
                        "description": "Whether this event may be updated in the future. If true, future calls may happen to onEventUpdated with this event id. If false/null no further updates will ever be received. nullable"
                },
                "entity": {
                    "type": [
                        "string",
                        "null"
                    ],
                        "description": "Some events may be attributed to specific entities - like a specific person doing a gesture - in that case the entity should be preserved in the output. Not all events originate from entities. nullable"
                },
                "data": {
                    "type": "object",
                        "additionalProperties": true,
                            "description": "The data an event carries is based on its type. The exact data content is detailed in other JSON schemas for each individual event type"
                }
            },
            "additionalProperties": false
        }        
    }
}

/**
 * The library is served as a classic script and installs itself on
 * `window.SessionHistory`. `serverBase` is derived from the script tag's src
 * (so relative links work wherever the server is mounted) and can be
 * overridden before the first {@link SessionHistory.create}/{@link SessionHistory.join} call.
 * `DEBUG` toggles the library's info-level logging
 * @global
 * @name SessionHistory
 * @type {SessionHistory}
 */
window.SessionHistory = SessionHistory;
window.SessionHistory.serverBase = document.currentScript.src.substring(0, document.currentScript.src.lastIndexOf("/")+1);
window.SessionHistory.DEBUG = true;

// Restore a remembered entityKey (mirrored by login) across page reloads —
// an expired one is rejected by the server with a 401, and the create/join/
// export calls then clear it and demand a fresh login.
(function restoreEntityKey(){
    const key = shStorage.get(SHS_ENTITY_KEY_STORAGE);
    if (!key) return;
    const entity = shStorage.get(SHS_ENTITY_KEY_ENTITY_STORAGE);
    shEntityAuth.key = key;
    shEntityAuth.entity = entity && entity.length > 0 ? entity : null;
    shDebugLog("Restored the entityKey for", shEntityAuth.entity ?? "an unknown entity", "from localStorage");
})();

/**
 * A subscription to a server-side model (created through
 * {@link SessionHistory#connectModel}). Holds the model's events — replayed
 * history first, live updates after — in an array sorted by `start`, and
 * notifies listeners through {@link HistoryModel#addEventListener}.
 *
 * Two listener events deserve special mention: `eventAdded` fires for every
 * recorded event, including the full history replay when you first subscribe,
 * so a single listener is enough to build a complete view; and
 * `eventUpdated` fires when an event you have already seen changes (for
 * example a duration event being updated, or closing when its `tentative`
 * flag clears).
 *
 * @class HistoryModel
 */
class HistoryModel {
    /**
     * @private
     * @param {SessionHistory} session - The owning session connection.
     * @param {string} name - The model name (e.g. "history").
     * @param {number} channel - The subscription id on the session's websocket.
     */
    constructor(session, name, channel){
        this.session = session;
        this.name = name;
        this.channel = channel;
        this.events = [];
        this.hasWarnedCoalesce = false;
        this.closed = false;
        this.eventMap = {};
        this.listeners = {
            modelChanged: [],
            eventAdded: [],
            eventUpdated: [],
            eventRemoved: [],
            eventTypesChanged: []
        };
    }

    /**
     * Close the subscription and release everything it holds: the events
     * (replayed history and live updates alike), the listeners, the
     * registration with the session and the back-reference to it. A closed
     * model dispatches no further changes — messages still in flight are
     * ignored. Called by {@link SessionHistory#dispose}; safe to call more
     * than once and from any state.
     */
    close(){
        this.closed = true;
        this.events = [];
        this.eventMap = {};
        if (this.session){
            // Deregister, so the session stops routing changes here (a
            // no-op when the session itself is disposing: it drops its
            // models afterwards anyway).
            delete this.session.models[this.channel];
        }
        this.session = null;
        for (const eventName of Object.keys(this.listeners)){
            this.listeners[eventName] = [];
        }
    }
    
    /**
     * Merge an incoming modelChange message (added, updated and removed
     * events) into the local event array, keeping it sorted by `start`.
     * Missing sections are treated as empty.
     * @private
     * @param {Object} msg - The modelChange message from the server.
     */
    handleChangeMessage(msg){
        if (this.closed) return; // disposed of while this message was in flight
        // Merge changes into event array
        let newEvents = [];        
        let sortedAddedEvents = (msg.add ?? []).sort((a, b) => {
            return b.start - a.start; // Descending order
        });        
        let addNextAndNotify = (a)=>{
            let addedEvent = sortedAddedEvents.pop();
            newEvents.push(addedEvent);
            this.eventMap[addedEvent.id] = addedEvent;
            this.dispatchEvent("eventAdded", addedEvent); 
        };
        for (let event of this.events){
            if ((msg.remove ?? []).includes(event.id)) {
                // Remove it
                delete this.eventMap[event.id];
                this.dispatchEvent("eventRemoved", event.id); 
                continue;
            } 

            // First get all added events earlier than this one
            while (sortedAddedEvents.length>0 && sortedAddedEvents[sortedAddedEvents.length-1].start<event.start){
                addNextAndNotify();
            }

            // Then add this one
            newEvents.push(event);
        }
        // Finally add remaining new ones
        while (sortedAddedEvents.length>0) {
            addNextAndNotify();
        }
        this.events = newEvents;

        // In-place merge updated old event
        (msg.update ?? []).forEach(event =>{
            let oldEvent = this.eventMap[event.id];            
            for (const prop in oldEvent) {
                if (!(prop in event)) {
                    delete oldEvent[prop];
                }
            }
            Object.assign(oldEvent, event);
            this.dispatchEvent("eventUpdated", event);
        });
        
        this.dispatchEvent("modelChanged", this.events, true);
    }
    
    /**
     * Registers an event listener. Supported event names:
     * <ul>
     *   <li><code>"modelChanged"</code> — the full event array, re-fired
     *       after every change. Registered listeners are immediately called
     *       once with the current events.</li>
     *   <li><code>"eventAdded"</code> — a single newly visible event
     *       (TimedEvent). Fires for replayed history as well as live
     *       events.</li>
     *   <li><code>"eventUpdated"</code> — an event that changed (its current
     *       state, e.g. a duration event that was updated or closed).</li>
     *   <li><code>"eventRemoved"</code> — the id of an event that left the
     *       model.</li>
     *   <li><code>"eventTypesChanged"</code> — the event types visible to
     *       this model (see {@link HistoryModel#getOutputs}). Registered
     *       listeners are immediately called once with the current
     *       types.</li>
     * </ul>
     * @param {string} eventName - One of the names above.
     * @param {function} callback - The function to execute when the event fires.
     * @example
     * history.addEventListener("eventAdded", (event) => {
     *     if (event.type === "application.demo.note") render(event.data);
     * });
     */
    addEventListener(eventName, callback) {
        if (this.closed){
            console.warn("Ignoring a listener for \""+eventName+"\" on the closed model "+this.name+" — the session was disposed");
            return;
        }
        // Check if the eventName is one of the supported types
        if (this.listeners[eventName] && typeof callback === 'function') {
            this.listeners[eventName].push(callback);

            // Pre-feed with initial data on event listener hooking for some types
            switch (eventName){
                case "modelChanged":
                    callback(this.events);
                    break;
                case "eventTypesChanged":
                    callback(this.getOutputs());
                    break;
            }
        } else {
            console.error(`Unsupported event name: ${eventName} or callback is not a function.`);
        }
    }

    /**
     * Dispatches (fires) an event, calling all registered listeners for that event.
     * @param {string} eventName - The name of the event to dispatch.
     * @param {*} [data={}] - Optional data to pass to the listener callbacks.
     */
    dispatchEvent(eventName, data = {}, allowCoalescing=false) {
        const callbacks = this.listeners[eventName];
        
        if (allowCoalescing && !this.hasWarnedCoalesce){
            shDebugLog("FIXME: dispatchEvent with coalescing=true but no code supports this yet");
            this.hasWarnedCoalesce = true;
        }

        if (callbacks) {
            // Execute each listener function, passing the optional data
            callbacks.forEach(callback => {
                try {
                    callback(data);
                } catch (error) {
                    console.error(`Error in ${eventName} listener:`, error);
                }
            });
        } else {
            console.warn(`Unsupported event: ${eventName}`);
        }
    }

    /**
     * (Optional) Removes an event listener.
     * @param {string} eventName - The name of the event.
     * @param {function} callback - The specific function reference to remove.
     */
    removeEventListener(eventName, callback) {
        const callbacks = this.listeners[eventName];
        if (callbacks) {
            this.listeners[eventName] = callbacks.filter(cb => cb !== callback);
        }
    }

    /**
     * Handles schema change events by refreshing the visible event types.
     * @private
     * @param {Object} schema - The new schema.
     */
    handleSchemaChange(schema) {
        if (this.closed) return; // disposed of while this message was in flight
        this.dispatchEvent("eventTypesChanged", this.getOutputs());
    }

    /**
     * The event types visible to this model: every processor output whose
     * type matches one of the model's input regexes, mapped to
     * `{ schemaId, processor, getSchema() }`. This is the discovery mechanism
     * for what can be recorded and derived — e.g. everything a UI could
     * render. Refreshes via the `eventTypesChanged` listener.
     * @returns {Object.<string, {schemaId: string, processor: string, getSchema: function()}>}
     *   Event type → output descriptor.
     */
    getOutputs() {
        if (this.closed) throw new Error("This HistoryModel ("+this.name+") is closed — the session was disposed");
        const model = this.session.schema.models[this.name];
        if (!model || !model.config.inputs) return {};

        // Get all regex keys from the model's inputs
        const inputRegexes = Object.keys(model.config.inputs).map(re => new RegExp(`^${re}$`));
        const processors = this.session.schema.processors;
        const result = {};

        // Iterate through each processor
        for (let [processorId, processorBody] of Object.entries(processors)) {
            const outputs = processorBody.config.outputs;
            if (!outputs) continue;

            // Iterate through each output of the processor
            for (let [outputKey, outputValue] of Object.entries(outputs)) {
                // Check if this outputKey matches any of the model's input regexes
                const isMatch = inputRegexes.some(regex => regex.test(outputKey));

                if (isMatch) {
                    result[outputKey] = {
                        schemaId: outputValue.schemaId,
                        processor: processorId,
                        getSchema: ()=>{                            
                            return this.session.getEventDataSchema(processorId, outputValue.schemaId);
                        }
                    };
                }
            }
        }

        return result;
    }
}

/**
 * The WebRTC ingest connection of a session (created through
 * {@link SessionHistory#connectIngest}): one peer connection to the server
 * carrying event data channels and media tracks. Everything a client records
 * — events and media alike — flows through this connection.
 *
 * @class WebRTCIngestConnection
 */
class WebRTCIngestConnection {
    /**
     * @private
     * @param {SessionHistory} socket - The owning session.
     * @param {Object} userICEConfig - ICE config overrides.
     */
    constructor(socket, userICEConfig={}){
        this.socket = socket;
        this.disposed = false;
        let defaultICEConfig = {
            iceTransportPolicy: "all",
            iceServers: [
                {"urls": "stun:stun.l.google.com:19302"}
            ]            
        };
        
        // Combine defaults, webstrate defaults and user config
        this.iceConfig = Object.assign({}, defaultICEConfig, window.webstrate?.config?.peerConnectionConfig, userICEConfig);
    }
    
    /**
     * Negotiate the peer connection (offer/answer over the command websocket,
     * ICE, DTLS) and wait for the server's base data channel. Called by
     * {@link SessionHistory#connectIngest}; not part of the public API.
     * @private
     * @returns {Promise<RTCPeerConnection>}
     */
    async start(){
        let self = this;
        if (this.peerConnection) {
            throw new Error("Cannot start a WebRTCIngestConnection more than once");
        }
        
        shDebugLog("Establishing history ingest connection with ICE", this.iceConfig);
        this.peerConnection = new RTCPeerConnection(this.iceConfig);
        this.peerConnection.onicecandidate = (ice)=>{
            shDebugLog("Sending ingest ICE candidate", ice.candidate);
            if (ice.candidate!==null && !this.disposed){
                this.socket.sendMessage({
                    cmd: 'ingestICECandidate',
                    candidate: ice.candidate.candidate,
                    sdpMLineIndex: ice.candidate.sdpMLineIndex
                });
            }
        };

        this.peerConnection.ontrack = function gotTrack(track){
            shDebugLog("Added Track", track);
        };
        let baseChannelPromise = new Promise((resolve, reject)=>{
            // Remember how to fail the negotiation: dispose() uses it to
            // reject a start() that is still waiting for the base channel.
            self.baseChannelReject = reject;
            // Fail the wait fast instead of leaving connectIngest()
            // pending forever: a peer connection that fails or closes
            // before the channel opens, or a channel that simply never
            // arrives (e.g. a truncated server offer with no
            // m=application section) rejects within the bound with the
            // reason.
            self.baseChannelDeadline = setTimeout(()=>{
                self.failBaseChannelWait("The ingest base data channel did not open within "+BASE_CHANNEL_TIMEOUT_MS+"ms - the server's offer was likely missing its data channel (no m=application line)");
            }, BASE_CHANNEL_TIMEOUT_MS);
            self.peerConnection.onconnectionstatechange = ()=>{
                const state = this.peerConnection ? this.peerConnection.connectionState : null;
                if (state === "failed" || state === "closed"){
                    self.failBaseChannelWait("The ingest peer connection entered state '"+state+"' before the base data channel opened");
                }
            };
            self.peerConnection.ondatachannel = (e)=>{
                shDebugLog("Data channel event",e);
                if (e.channel?.label==="__historybasechannel"){
                    if (self.baseChannelDeadline){ clearTimeout(self.baseChannelDeadline); self.baseChannelDeadline = null; }
                    self.baseChannelReject = null;
                    self.baseChannel = e.channel;
                    self.baseChannel.send(JSON.stringify({
                        url: window.location.href,
                        performanceNow: performance.now(),
                        timestamp: new Date().toUTCString(),
                        userAgent: navigator.userAgent,
                        language: navigator.language,
                        cmd: 'connectIngest'
                    }));
                    resolve();
                }
            };
        });
        // The connection may be torn down before this promise is first
        // awaited (dispose during the offer/answer exchange): keep a
        // no-op handler attached so that rejection is not reported as
        // unhandled — the awaiting start() still sees it.
        baseChannelPromise.catch(()=>{});

        shDebugLog("Waiting for initial ingest offer", this.peerConnection);
        let initialOffer = await this.socket.sendWithReply({cmd:"requestIngestNegotiation"});
        
        shDebugLog("Got initial ingest offer", initialOffer);
        if (typeof initialOffer.offer !== "string" || initialOffer.offer.length === 0) {
            throw new Error("The server sent no ingest offer SDP: "+JSON.stringify(initialOffer));
        }
        await this.peerConnection.setRemoteDescription({type:"offer", sdp: initialOffer.offer});
        this.peerConnection.restartIce();
        const answer = await this.peerConnection.createAnswer();
        await this.peerConnection.setLocalDescription(answer);
        shDebugLog("Sending finalized ingest answer", answer);
        this.socket.sendMessage({
            cmd: 'completeIngestNegotiation',
            sdp: answer.sdp
        });        
        
        this.peerConnection.onnegotiationneeded = async ()=>{
            if (this.disposed) return; // torn down while renegotiating
            shDebugLog("Requesting ingest renegotiation");
            try {
                const offer = await this.peerConnection.createOffer();
                await this.peerConnection.setLocalDescription(offer);

                // Check for any new streams that need to send metadata
                this.peerConnection.getTransceivers().forEach(transceiver=>{
                    if (transceiver.ingestStartStreamEvent){
                        transceiver.ingestStartStreamEvent.mid = transceiver.mid;
                        shDebugLog("Sending startStream event", transceiver, transceiver.ingestStartStreamEvent);
                        this.baseChannel.send(JSON.stringify(transceiver.ingestStartStreamEvent));
                        transceiver.ingestStartStreamEvent = false;
                    }
                });

                shDebugLog("Sending ingest renegotiate offer", offer);
                let answer = await this.socket.sendWithReply({cmd:"requestIngestRenegotiation", sdp: offer.sdp});

                shDebugLog("Got ingest renegotiate answer", answer);
                if (typeof answer.answer !== "string" || answer.answer.length === 0) {
                    throw new Error("The server sent no renegotiation answer SDP: "+JSON.stringify(answer));
                }
                await this.peerConnection.setRemoteDescription({type:"answer", sdp: answer.answer});
            } catch (ex) {
                if (this.disposed){
                    // The connection was torn down mid-renegotiation —
                    // there is nothing left to negotiate about.
                    shDebugLog("Aborted ingest renegotiation on dispose:", ex);
                    return;
                }
                throw ex;
            }
        };
       
        await baseChannelPromise;
        return this.peerConnection;
    }

    /**
     * Reject a start() that is still waiting for the base data channel and
     * stop its deadline — used by the wait timeout, the peer connection
     * state guard and dispose(). A no-op once the channel opened (the
     * promise is settled by then).
     * @private
     * @param {string} reason - Why the wait is being failed.
     */
    failBaseChannelWait(reason){
        if (this.baseChannelReject){
            const reject = this.baseChannelReject;
            this.baseChannelReject = null;
            reject(new Error(reason));
        }
        if (this.baseChannelDeadline){
            clearTimeout(this.baseChannelDeadline);
            this.baseChannelDeadline = null;
        }
    }

    /**
     * Tear down the ingest connection from any state: fails a
     * negotiation that is still waiting for its base channel (the pending
     * connectIngest() promise rejects instead of hanging forever), closes
     * the peer connection — and with it the base channel and every data
     * channel — and makes the connection ignore any further ICE or
     * renegotiation traffic. Open event streams are closed beforehand by
     * {@link SessionHistory#dispose}; recorded history stays on the
     * server. Called by {@link SessionHistory#dispose}; safe to call more
     * than once and from any state.
     * @private
     */
    dispose(){
        if (this.disposed) return;
        this.disposed = true;

        // Fail a start() that is still waiting for the base channel (and
        // stop its wait deadline). If the channel already opened, the
        // promise is settled and this is a no-op.
        this.failBaseChannelWait("The ingest connection was disposed before its base channel opened");

        if (this.baseChannel){
            try {
                this.baseChannel.close();
            } catch (ex) {
                console.warn("Failed to close the ingest base channel:", ex);
            }
            this.baseChannel = null;
        }

        if (this.peerConnection){
            try {
                this.peerConnection.close();
            } catch (ex) {
                console.warn("Failed to close the ingest peer connection:", ex);
            }
            this.peerConnection = null;
        }
    }

    /**
     * Feed a remote ICE candidate (relayed by the server) into the peer
     * connection. Internal.
     * @private
     * @param {Object} candidate - The candidate message from the server.
     */
    onRemoteICECandidate(candidate){
        if (this.disposed || !this.peerConnection) return; // candidate raced the teardown
        shDebugLog("Adding remote ICE candidate ",candidate);
        this.peerConnection.addIceCandidate(candidate);
    }

    /**
     * Open a dedicated data channel for a named event stream and return the
     * handle for publishing events on it.
     *
     * <b>The type name matters:</b> the server only routes event streams into
     * its models when the type matches some processor's input regex — the
     * processors are whatever the session's spec supplied at creation
     * ({@link SessionHistory.create}). The generic default spec
     * ({@link SessionHistory.defaultSpec}) covers `user\.(.*)\.audio` (the
     * voice-activity processor); `/application-spec.json` additionally
     * covers `application\.(.*)` (the reference app's EventStreamProcessor),
     * so applications using it name their streams under
     * `application.<app>.*` — for example `application.myapp.notes`. A
     * stream with an uncovered type is persisted to disk on the server but
     * never appears in any model, replay or getEvent.
     *
     * @param {string} type - The event stream name / event type, under a
     *   processor-covered namespace (see above).
     * @returns {Promise<SCTPEventStream>} The event stream, ready to publish.
     * @example
     * const notes = await ingest.startEventStream("application.myapp.notes");
     * notes.createInstantEvent({ note: "hello" });
     */
    async startEventStream(type){
        if (this.disposed || !this.peerConnection) throw new Error("Cannot start an event stream on an ingest connection that is not open");
        let stream = new SCTPEventStream(this, type);
        this.socket.streams.add(stream); // closed again by SessionHistory#dispose
        try {
            await stream.start(this.peerConnection);
        } catch (ex) {
            this.socket.streams.delete(stream); // never fully opened
            throw ex;
        }
        return stream;
    }

    /**
     * Send a `getUserMedia`/`getDisplayMedia` stream to the server. Each of
     * the stream's tracks becomes a server-side Matroska recording
     * (`<type>.video_....mkv` / `<type>.audio_....mkv`) that grows while it
     * records and is servable over HTTP; track events for them appear in the
     * history model.
     *
     * Naming convention: an audio track named `user.<something>.audio` is also
     * picked up by the voice-activity processor when the session's spec
     * installed one (the generic default spec does; and through it, live
     * transcription); anything else bypasses that pipeline. Video tracks are
     * not processed regardless of name.
     *
     * @param {string} type - Base name for the tracks (the track events are
     *   typed `type.video` / `type.audio`).
     * @param {MediaStream} media - The media stream to ingest.
     * @param {Object} [extraData] - Optional data stored with the track
     *   events.
     * @returns {MediaStream} The same stream that was passed in — keep it
     *   and hand it back to {@link WebRTCIngestConnection#stopMediaStream}
     *   to stop ingesting.
     * @example
     * const camera = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
     * const recording = await ingest.startMediaStream("user.myapp.cam", camera);
     * // ... later:
     * await ingest.stopMediaStream(recording);
     */
    async startMediaStream(type, media, extraData=null){
        if (this.disposed || !this.peerConnection) throw new Error("Cannot start a media stream on an ingest connection that is not open");
        media.getTracks().forEach(track => {
            shDebugLog("Adding track", track);
            let transceiver = this.peerConnection.addTransceiver(track, { direction: 'sendonly' });
            
            // Store an init message on the transceiver for when it has mid/mlineindex/msid etc. ready after sdpOffer set locally
            transceiver.ingestStartStreamEvent = {
                media: media.id,
                track: track.id,
                label: track.label,
                streamType: type,
                clientTimestampPerformance: performance.now(),
                clientTimestamp: new Date().getTime(),
                cmd: 'startMediaStream',
                data: extraData
            };
        });        
        return media;
    }
    
    /**
     * Intended to stop ingesting a media stream: stops the local tracks and
     * removes them from the peer connection.
     * <p><b>Note:</b> currently invisible to the server — nothing is sent
     * over the wire and no renegotiation happens, so the server keeps the
     * tracks (and their track events) live until the whole connection goes
     * away; tracked as a known bug in the functional tests. Dropping the
     * session websocket finalizes the recordings (with a ~2 s flush).</p>
     * @param {MediaStream} media - The stream to stop ingesting: the
     *   object returned by {@link WebRTCIngestConnection#startMediaStream}
     *   (the same stream that was passed to it).
     */
    async stopMediaStream(media){
        media.getTracks().forEach(track => {
            shDebugLog("Removing track", track);
            // Stopping the local track is the main effect — it also applies
            // when the ingest connection is already gone.
            track.stop();
            if (!this.peerConnection) return; // disposed — the server finalized the recording when the connection dropped
            const transceiver = this.peerConnection.getSenders().find(sender => {
                return sender.track === track;
            });
            if (transceiver){
                shDebugLog("Removing WebRTC transceiver", transceiver);
                this.peerConnection.removeTrack(transceiver);
            }
        });
    }
}

/**
 * A named event stream over its own WebRTC data channel — the publishing side
 * of the history. Obtained from
 * {@link WebRTCIngestConnection#startEventStream}; supports instant events,
 * duration events and sequential state events.
 *
 * Events are timestamped relative to the stream's start; the server
 * translates them against the stream's anchor into absolute wall-clock time.
 * For continuous data (telemetry, tracking samples, ...) prefer
 * {@link SCTPEventStream#createInstantEvent} per sample: instant events are
 * delivered one-for-one, while high-frequency updates to a single duration
 * event are coalesced server-side (observers see the merged state, not every
 * intermediate value).
 *
 * @class SCTPEventStream
 */
class SCTPEventStream {
    /**
     * @private
     * @param {WebRTCIngestConnection} parentConnection - The ingest connection.
     * @param {string} type - The event stream name / event type.
     */
    constructor(parentConnection, type){
        this.localTrackStartTimestamp = 0;
        this.parentConnection = parentConnection;
        this.type = type;
        this.danglingRegistry = new FinalizationRegistry(({type, stack}) => {
            console.warn("Dangling event for "+type+" was garbage collected without being stop()ed.",stack);
        });        
    }
    
    /**
     * Register the stream with the server (over the base channel) and open
     * its data channel. Called by
     * {@link WebRTCIngestConnection#startEventStream}; not part of the
     * public API.
     * @private
     * @param {RTCPeerConnection} connection - The peer connection.
     * @param {Object} [extraData] - Optional data stored with the stream's
     *   track descriptor.
     */
    async start(connection, extraData={}){
        let self = this;
        await new Promise((resolve, reject)=>{
            // Remember how to fail the start: close() uses it to reject a
            // start() that is still waiting for its data channel to open.
            self.startReject = reject;
            self.parentConnection.baseChannel.send(JSON.stringify({
                streamType: this.type,
                clientTimestampPerformance: performance.now(),
                clientTimestamp: new Date().getTime(),
                cmd: 'startEventStream',
                data: extraData
            }));
            self.channel = connection.createDataChannel(this.type);
            self.channel.onopen = ()=>{
                shDebugLog("New stream "+this.type+" open");
                this.localTrackStartTimestamp = Date.now();
                resolve();
            };
        });
    }

    /**
     * Milliseconds elapsed since this stream opened — the relative timestamp
     * events are stamped with; the server translates it to absolute time
     * against the stream's anchor.
     * @returns {number} Milliseconds since the stream started.
     */
    getCurrentTimestamp(){
        // STUB: Use session NTP/timestamp here instead
        return Date.now()-this.localTrackStartTimestamp;
    }
    
    /**
     * Publish an instantaneous event on this stream, timestamped "now". The
     * server assigns the event id and attributes it to the ingest entity.
     * @param {Object} data - The event content; its shape should match the
     *   schema declared for this stream's type, where one is declared.
     *   Anything that is not an object is rejected client-side.
     * @example
     * const poses = await ingest.startEventStream("application.game.pose");
     * poses.createInstantEvent({ p: [0, 1.2, -2], q: [1, 0, 0, 0] });
     */
    createInstantEvent(data={}){
        if (typeof data !== "object" || data === null) throw new Error("Illegal data type provided to createInstantEvent(...), must be serializable object");
        if (!this.channel || this.channel.readyState !== "open") throw new Error("Cannot publish on the closed event stream "+this.type);
        this.channel.send(JSON.stringify({
            start: this.getCurrentTimestamp(),
            data: data
        }));
    }

    /**
     * Start a duration event — one that carries both a start and an end
     * timestamp, with its content marked tentative until stopped. Use for
     * things that have an extent in time (a song, a gesture, a phase); for
     * high-frequency updates to one logical value, prefer
     * {@link SCTPEventStream#createInstantEvent} per sample (duration-event
     * updates are coalesced server-side).
     * @param {Object} data - The tentative content of the event.
     * @returns {Object} A handle with `update(data)` — merge new content into
     *   the tentative event and advance its end timestamp — and
     *   `stop(data)` — finalize it (further updates throw). If the handle is
     *   garbage-collected without `stop()`, a console warning points at the
     *   creation site.
     * @example
     * const song = await ingest.startEventStream("application.game.song");
     * const run = song.createDurationEvent({ score: 0 });
     * run.update({ score: 1337 });   // tentative content evolves
     * run.stop({ score: 1337 });      // finalizes the event
     */
    createDurationEvent(data={}){
        if (typeof data !== "object" || data === null) throw new Error("Illegal data type provided to createDurationEvent(...), must be serializable object");
        if (!this.channel || this.channel.readyState !== "open") throw new Error("Cannot publish on the closed event stream "+this.type);
        let event = {
            id: crypto.randomUUID(),
            start: this.getCurrentTimestamp(),
            tentative: true,
            data: data
        };
        this.channel.send(JSON.stringify(event));
        let hasStopped = false;
        let durationAPI = {
            update: (data={})=>{
                if (typeof data !== "object" || data === null) throw new Error("Illegal data type provided to durationEvent.update(...), must be serializable object");
                if (hasStopped) throw new Error("Cannot update an event that has been stopped", this.type, data);
                if (!this.channel || this.channel.readyState !== "open") throw new Error("Cannot update an event on the closed event stream "+this.type);
                event.end = this.getCurrentTimestamp(),
                event.data = {...event.data, ...data};
                this.channel.send(JSON.stringify(event));
            },
            stop: (data={})=>{
                if (hasStopped) throw new Error("Cannot stop an event more than once", this.type, data);
                event.tentative = undefined;
                durationAPI.update(data);
                hasStopped = true;
                this.danglingRegistry.unregister(durationAPI);
            }
        };

        // Warn devs about dangling unclosed events if they accidentally throw the API away
        try {
            throw new Error("Dangling unclosed event originally created here");
        } catch (ex){
            this.danglingRegistry.register(durationAPI, {type:this.type, stack:ex}, durationAPI);
        }
        return durationAPI;
    }

    /**
     * Sugar for streams whose events are sequential, non-overlapping states:
     * each call closes the previous state event (if any) and opens a new one
     * with the given content. The data is both the tentative and the final
     * content of each state event.
     * @param {Object} data - The content of the new state.
     * @example
     * const mood = await ingest.startEventStream("application.game.mood");
     * mood.createStateEvent({ state: "calm" });
     * // ... later:
     * mood.createStateEvent({ state: "frantic" }); // closes "calm", opens "frantic"
     */
    createStateEvent(data){
        if (this.openStateEvent){
            this.openStateEvent.stop();
        }
        this.openStateEvent = this.createDurationEvent(data);
    }

    /**
     * Close the stream's data channel (finalizing any open state event from
     * {@link SCTPEventStream#createStateEvent} first, while the channel can
     * still carry the final update). The recorded events remain in the
     * session history. Safe to call from any state — a channel that never
     * opened, an already-closed stream, a final update that can no longer
     * be sent — and more than once; close never throws.
     */
    close(){
        // Fail a start() that is still waiting for its data channel to
        // open (a no-op if the channel already opened).
        if (this.startReject){
            this.startReject(new Error("The event stream "+this.type+" was closed before its data channel opened"));
            this.startReject = null;
        }

        if (this.openStateEvent){
            try {
                this.openStateEvent.stop();
            } catch (ex){
                // e.g. the channel is already gone; the server finalizes
                // the tentative event when the connection drops
                console.warn("Could not finalize the open state event of stream "+this.type+" while closing it:", ex);
            }
            this.openStateEvent = null;
        }

        if (this.channel){
            try {
                this.channel.close();
            } catch (ex){
                console.warn("Could not close the data channel of stream "+this.type+":", ex);
            }
            this.channel = null;
        }

        // Drop the stream from the session's registry (a no-op if it was
        // never registered or already removed).
        this.parentConnection?.socket?.streams?.delete(this);
    }
}