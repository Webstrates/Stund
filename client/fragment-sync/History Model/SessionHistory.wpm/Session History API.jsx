export const DEFAULT_SESSION_HISTORY_SERVER = 'https://my-activity-session-server.com';

export const normalizeSessionHistoryServerUrl = (serverUrl = DEFAULT_SESSION_HISTORY_SERVER) => {
    const trimmedServerUrl = typeof serverUrl === 'string' ? serverUrl.trim() : '';
    const resolvedServerUrl = new URL(trimmedServerUrl || DEFAULT_SESSION_HISTORY_SERVER);

    if (!['http:', 'https:'].includes(resolvedServerUrl.protocol)) {
        throw new Error('History server URL must use HTTP or HTTPS.');
    }

    if (resolvedServerUrl.search || resolvedServerUrl.hash) {
        throw new Error('History server URL cannot contain a query string or fragment.');
    }

    resolvedServerUrl.pathname = resolvedServerUrl.pathname.replace(/\/+$/, '') || '/';
    return resolvedServerUrl.toString().replace(/\/+$/, '');
};

export class SessionHistory {
    static async join(sessionId, entityId, serverUrl = DEFAULT_SESSION_HISTORY_SERVER) {
        const session = new SessionHistory(sessionId, entityId, serverUrl);
        await session.waitForWebsocket();
        return session;
    }

    static async create(entityId, serverUrl = DEFAULT_SESSION_HISTORY_SERVER) {
        const normalizedServerUrl = normalizeSessionHistoryServerUrl(serverUrl);

        // Request a new session
        const response = await fetch(normalizedServerUrl + '/session', {
            method: 'POST', // The HTTP method for creation
            headers: {
                // Must specify that you are sending JSON
                'Content-Type': 'application/json'
            },
            // Convert the JavaScript object to a JSON string
            body: JSON.stringify({
                entity: entityId
            })
        });

        // Check if the response status is 201 Created (or 200 OK)
        if (response.ok) {
            // Parse the JSON body of the response
            const sessionData = await response.json();
            const sessionId = sessionData.sessionId;
            console.log('Generated Session ID:', sessionId);

            return await SessionHistory.join(sessionId, entityId, normalizedServerUrl);
        } else {
            // Handle HTTP error status codes
            console.error(`Error creating session. Status: ${response.status}`);
            const errorText = await response.text();
            throw new Error(errorText);
        }
    }

    constructor(sessionId, entityId, serverUrl = DEFAULT_SESSION_HISTORY_SERVER) {
        const self = this;
        this.pendingOps = {};
        this.opCounter = 0;
        this.ingest = null;
        this.serverBase = normalizeSessionHistoryServerUrl(serverUrl);
        const websocketUrl = this.serverBase + '/session/' + sessionId + '/' + entityId;
        this.models = {};
        this.id = sessionId;

        this.websocketOpen = false;
        this.onOpenPromise = new Promise((resolve, reject) => {
            self.websocket = new WebSocket(websocketUrl);

            self.websocket.onopen = () => {
                console.log("Websocket open!");
                self.websocketOpen = true;
                resolve();
            };

            self.websocket.onclose = (event) => {
                console.log("SessionHistory Websocket closed", event);
                self.websocketOpen = false;
                reject('Unable to connect to: ' + websocketUrl);
            };

            self.websocket.onmessage = (msg) => {
                self.handleMessage(JSON.parse(msg.data));
            };
        });
    }

    getId() {
        return this.id;
    }

    async connectIngest(userICEConfig = {}) {
        if (!this.ingestPromise) {
            this.ingestPromise = (async () => {
                await this.waitForWebsocket();
                this.ingest = new WebRTCIngestConnection(this, userICEConfig);
                await this.ingest.start();
                return this.ingest;
            })();
        } else {
            console.log("Notice: connectIngest called more than once? Using existing connection");
        }

        return await this.ingestPromise;
    }

    async connectModel(modelName) {
        await this.waitForWebsocket();
        let subscriptionInfo = await this.sendWithReply({ cmd: "connectModel", model: modelName });
        this.models[subscriptionInfo.subscription] = new HistoryModel(this, modelName, subscriptionInfo.subscription);
        return this.models[subscriptionInfo.subscription];
    }

    async start() {
        return await this.sendWithReply({ cmd: "start" });
    }

    async stop() {
        return await this.sendWithReply({ cmd: "stop" });
    }

    async removeProcessor(processorId) {
        return await this.sendWithReply({ cmd: "removeProcessor", processor: processorId });
    }

    async addProcessor(processorId, type, config) {
        return await this.sendWithReply({ config: config, cmd: "addProcessor", name: processorId, type: type });
    }

    async getSupportedProcessors() {
        return await this.sendWithReply({ cmd: "getSupportedProcessors" });
    }

    /**
     * Fetches the current state of an event id from the raw model, optionally including additional data
     * @param {*} eventId Ids for which to fetch the corresponding event data
     * @param {*} options Object with serialization parameters, if includeMeta is true then additional event generation information is included
     * @returns
     */
    async getEvent(id, options = { includeMeta: false }) {
        return await this.sendWithReply({ cmd: "getEvent", options, id });
    }

    async resolveMediaResource(relativePath) {
        return this.serverBase + '/session/' + this.id + '/media/' + relativePath;
    }


    dispose() {
        if (this.websocketOpen) {
            //Stop all streams
            for (let [name, streamData] of Array.from(this.streams.entries())) {
                // TODO: Cleanup
            }
        }
        this.websocket = null;
    }

    waitForWebsocket() {
        return this.onOpenPromise;
    }

    handleMessage(msg) {
        switch (msg.cmd) {
            case "status":
                break;
            case "return":
                if (this.pendingOps[msg.op]) {
                    this.pendingOps[msg.op](msg);
                    delete this.pendingOps[msg.op];
                } else {
                    console.warn("Unmatched op", msg);
                }
                break;
            case "iceCandidate":
                if (!this.ingest) throw new Error("Unknown ice candidate offer, no ingest requested?", msg.session);
                this.ingest.onRemoteICECandidate(msg);
                break;
            case "modelChange":
                this.models[msg.subscription].handleChangeMessage(msg);
                break;
            case "schemaChange":
                this.schema = msg.schema;

                // Notify model listeners
                for (let [subscription, model] of Object.entries(this.models)) {
                    model.handleSchemaChange(this.schema);
                }
                break;
            default:
                console.log("Unhandled cmd:", msg);
        }
    }

    sendMessage(msg) {
        if (!this.websocketOpen) {
            throw new Error("Trying to send over closed websocket");
        }
        this.opCounter++;
        msg.op = this.opCounter;
        this.websocket.send(JSON.stringify(msg));
    }

    sendWithReply(msg) {
        let self = this;
        let stack = new Error("Failed network operation and failed to provide a reason why");
        return new Promise((resolve, reject) => {
            self.sendMessage(msg);
            // TODO: timeout
            self.pendingOps[this.opCounter] = msg => {
                if (msg.status) {
                    resolve(msg);
                } else {
                    if (msg.message) stack.message = msg.message;
                    reject(stack);
                }
            };
        });
    }

    /**
     * Returns the schema definition for the data field of events from a specific processor and schemaId.
     * @param {string} processorId - The ID of the processor (e.g., "transcription0").
     * @param {string} schemaId - The URI/ID of the schema (e.g., "stund://openAITranscription.json").
     * @returns {Object|null} The schema definition or null if not found.
     */
    getEventDataSchema(processorId, schemaId) {
        const processor = this.schema.processors[processorId];

        if (!processor || !processor.config || !processor.config.schemas) {
            throw Error("No such processor " + processorId);
        }

        const schema = processor.config.schemas[schemaId];
        if (!schema) throw Error("No such schema URI for processor " + processorId + ": " + schemaId);
        return schema;
    }

    /**
     * The basic structure of all timed events in the system
     * @returns The schema for all timed events
     */
    getBaseEventSchema() {
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

class HistoryModel {
    constructor(session, name, channel) {
        this.session = session;
        this.name = name;
        this.channel = channel;
        this.events = [];
        this.hasWarnedCoalesce = false;
        this.eventMap = {};
        this.listeners = {
            modelChanged: [],
            eventAdded: [],
            eventUpdated: [],
            eventRemoved: [],
            eventTypesChanged: []
        };
    }

    handleChangeMessage(msg) {
        // Merge changes into event array
        let newEvents = [];
        let sortedAddedEvents = msg.add.sort((a, b) => {
            return b.start - a.start; // Descending order
        });
        let addNextAndNotify = (a) => {
            let addedEvent = sortedAddedEvents.pop();
            newEvents.push(addedEvent);
            this.eventMap[addedEvent.id] = addedEvent;
            this.dispatchEvent("eventAdded", addedEvent);
        };
        for (let event of this.events) {
            if (msg.remove.includes(event.id)) {
                // Remove it
                delete eventMap[event.id];
                this.dispatchEvent("eventRemoved", event.id);
                continue;
            }

            // First get all added events earlier than this one
            while (sortedAddedEvents.length > 0 && sortedAddedEvents[sortedAddedEvents.length - 1].start < event.start) {
                addNextAndNotify();
            }

            // Then add this one
            newEvents.push(event);
        }
        // Finally add remaining new ones
        while (sortedAddedEvents.length > 0) {
            addNextAndNotify();
        }
        this.events = newEvents;

        // In-place merge updated old event
        msg.update.forEach(event => {
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
     * Registers an event listener.
     * @param {string} eventName - The name of the event to listen for.
     * @param {function} callback - The function to execute when the event fires.
     */
    addEventListener(eventName, callback) {
        // Check if the eventName is one of the supported types
        if (this.listeners[eventName] && typeof callback === 'function') {
            this.listeners[eventName].push(callback);

            // Pre-feed with initial data on event listener hooking for some types
            switch (eventName) {
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
    dispatchEvent(eventName, data = {}, allowCoalescing = false) {
        const callbacks = this.listeners[eventName];

        if (allowCoalescing && !this.hasWarnedCoalesce) {
            console.log("FIXME: dispatchEvent with coalescing=true but no code supports this yet");
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
     * Handles schema change events.
     * @param {Object} schema - The new schema.
     */
    handleSchemaChange(schema) {
        this.dispatchEvent("eventTypesChanged", this.getOutputs());
    }

    getOutputs() {
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
                        getSchema: () => {
                            return this.session.getEventDataSchema(processorId, outputValue.schemaId);
                        }
                    };
                }
            }
        }

        return result;
    }
}

class WebRTCIngestConnection {
    constructor(socket, userICEConfig = {}) {
        this.socket = socket;
        let defaultICEConfig = {
            iceTransportPolicy: "all",
            iceServers: [
                { "urls": "stun:stun.l.google.com:19302" }
            ]
        };

        // Combine defaults, webstrate defaults and user config
        this.iceConfig = Object.assign({}, defaultICEConfig, window.webstrate?.config?.peerConnectionConfig, userICEConfig);
    }

    async start() {
        let self = this;
        if (this.peerConnection) {
            throw new Error("Cannot start a WebRTCIngestConnection more than once");
        }

        console.log("Establishing history ingest connection");

        console.log("Preparing ingest ICE", this.iceConfig);
        this.peerConnection = new RTCPeerConnection(this.iceConfig);
        this.peerConnection.onicecandidate = (ice) => {
            console.log("Sending ingest ICE candidate", ice.candidate);
            if (ice.candidate !== null) {
                this.socket.sendMessage({
                    cmd: 'ingestICECandidate',
                    candidate: ice.candidate.candidate,
                    sdpMLineIndex: ice.candidate.sdpMLineIndex
                });
            }
        };

        this.peerConnection.ontrack = function gotTrack(track) {
            console.log("Added Track", track);
        };
        let baseChannelPromise = new Promise((resolve, reject) => {
            self.peerConnection.ondatachannel = (e) => {
                console.log("Data channel event", e);
                if (e.channel?.label === "__historybasechannel") {
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

        console.log("Waiting for initial ingest offer", this.peerConnection);
        let initialOffer = await this.socket.sendWithReply({ cmd: "requestIngestNegotiation" });

        console.log("Got initial ingest offer", initialOffer);
        this.peerConnection.setRemoteDescription({ type: "offer", sdp: initialOffer.offer }); // TODO: check it
        this.peerConnection.restartIce();
        const answer = await this.peerConnection.createAnswer();
        await this.peerConnection.setLocalDescription(answer);
        console.log("Sending finalized ingest answer", answer);
        this.socket.sendMessage({
            cmd: 'completeIngestNegotiation',
            sdp: answer.sdp
        });

        this.peerConnection.onnegotiationneeded = async () => {
            console.log("Requesting ingest renegotiation");
            const offer = await this.peerConnection.createOffer();
            await this.peerConnection.setLocalDescription(offer);

            // Check for any new streams that need to send metadata
            this.peerConnection.getTransceivers().forEach(transceiver => {
                if (transceiver.ingestStartStreamEvent) {
                    transceiver.ingestStartStreamEvent.mid = transceiver.mid;
                    console.log("Sending startStream event", transceiver, transceiver.ingestStartStreamEvent);
                    this.baseChannel.send(JSON.stringify(transceiver.ingestStartStreamEvent));
                    transceiver.ingestStartStreamEvent = false;
                }
            });

            console.log("Sending ingest renegotiate offer", offer);
            let answer = await this.socket.sendWithReply({ cmd: "requestIngestRenegotiation", sdp: offer.sdp });

            console.log("Got ingest renegotiate answer", answer);
            this.peerConnection.setRemoteDescription({ type: "answer", sdp: answer.answer }); // TODO: check it
        };

        await baseChannelPromise;
        return this.peerConnection;
    }

    onRemoteICECandidate(candidate) {
        console.log("Adding remote ICE candidate ", candidate);
        this.peerConnection.addIceCandidate(candidate);
    }

    async startEventStream(type) {
        let stream = new SCTPEventStream(this, type);
        await stream.start(this.peerConnection);
        return stream;
    }

    async startMediaStream(type, media, extraData = null) {
        media.getTracks().forEach(track => {
            console.log("Adding track", track);
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
    }

    async stopMediaStream(media) {
        media.getTracks().forEach(track => {
            console.log("Removing track", track);
            track.stop();
            const transceiver = this.peerConnection.getSenders().find(sender => {
                return sender.track === track;
            });
            if (transceiver) {
                console.log("Removing WebRTC transceiver", transceiver);
                this.peerConnection.removeTrack(transceiver);
            }
        });
    }
}

class SCTPEventStream {
    constructor(parentConnection, type) {
        this.localTrackStartTimestamp = 0;
        this.parentConnection = parentConnection;
        this.type = type;
        this.danglingRegistry = new FinalizationRegistry(({ type, stack }) => {
            console.warn("Dangling event for " + type + " was garbage collected without being stop()ed.", stack);
        });
    }

    async start(connection, extraData = {}) {
        let self = this;
        await new Promise((resolve, reject) => {
            self.parentConnection.baseChannel.send(JSON.stringify({
                streamType: this.type,
                clientTimestampPerformance: performance.now(),
                clientTimestamp: new Date().getTime(),
                cmd: 'startEventStream',
                data: extraData
            }));
            self.channel = connection.createDataChannel(this.type);
            self.channel.onopen = () => {
                console.log("New stream " + this.type + " open");
                this.localTrackStartTimestamp = Date.now();
                resolve();
            };
        });
    }

    getCurrentTimetamp() {
        // STUB: Use session NTP/timestamp here instead
        return Date.now() - this.localTrackStartTimestamp;
    }

    /**
     * Create an instantaneous event with the timestamp set to now.
     * The supplied data is used as the content of the event
     * @param {*} data
     */
    createInstantEvent(data = {}) {
        if (!typeof data === "object") throw new Error("Illegal data type provided to createInstantEvent(...), must be serializable object");
        this.channel.send(JSON.stringify({
            start: this.getCurrentTimetamp(),
            data: data
        }));
    }

    /**
     * Start an event that carries both start and stop timestamps with the start set to now.
     * The supplied data is used as the tentative content of the event.
     * @param {*} data
     * @returns an object that allows updating or stopping the event: update(data) updates the tentative content, stop(data) stops the event
     */
    createDurationEvent(data = {}) {
        if (!typeof data === "object") throw new Error("Illegal data type provided to createDurationEvent(...), must be serializable object");
        let event = {
            id: crypto.randomUUID(),
            start: this.getCurrentTimetamp(),
            tentative: true,
            data: data
        };
        this.channel.send(JSON.stringify(event));
        let hasStopped = false;
        let durationAPI = {
            update: (data = {}) => {
                if (!typeof data === "object") throw new Error("Illegal data type provided to durationEvent.update(...), must be serializable object");
                if (hasStopped) throw new Error("Cannot update an event that has been stopped", this.type, data);
                event.end = this.getCurrentTimetamp(),
                    event.data = { ...event.data, ...data };
                this.channel.send(JSON.stringify(event));
            },
            stop: (data = {}) => {
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
        } catch (ex) {
            this.danglingRegistry.register(durationAPI, { type: this.type, stack: ex }, durationAPI);
        }
        return durationAPI;
    }

    /**
     * If a stream contains only non-overlapping segments
     * then replaceState can provide the sugar for opening and closing the durationEvents
     * Every new replaceState simply ends the previous one (if any).
     * The supplied data is used as the tentative and final content of the event.
     * @param {*} data
     */
    createStateEvent(data) {
        if (this.openStateEvent) {
            this.openStateEvent.stop();
        }
        this.openStateEvent = this.createDurationEvent(data);
    }

    close() {
        if (this.openStateEvent) {
            this.openStateEvent.stop();
        }

        this.channel.close();
    }
}
