import { buildSessionSpec } from '#SessionHistory .session-spec';

export const DEFAULT_SESSION_HISTORY_SERVER = 'https://your-stund-session-server.com';

export const normalizeSessionHistoryServerUrl = (serverUrl = DEFAULT_SESSION_HISTORY_SERVER) => {
    const trimmedServerUrl = (typeof serverUrl === 'string' ? serverUrl.trim() : '') || DEFAULT_SESSION_HISTORY_SERVER;
    const serverUrlWithScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmedServerUrl)
        ? trimmedServerUrl
        : `http://${trimmedServerUrl}`;
    return serverUrlWithScheme.replace(/\/+$/, '');
};

// The server owns the client implementation. Load its classic script once;
// subsequent server selections configure that client's supported serverBase.
const clientState =
    window.stundHistoryClient ||
    (window.stundHistoryClient = {
        promise: null,
        queue: Promise.resolve(),
        server: null,
        credentials: new Map()
    });

function clearUnscopedStorage() {
    // The upstream client mirrors its current key under these global names.
    // Stund persists only the server/entity-scoped copy below.
    try {
        window.localStorage.removeItem('shsEntityKey');
        window.localStorage.removeItem('shsEntityKeyEntity');
    } catch {
        /* Browser storage can be unavailable. */
    }
}

function loadClient(serverUrl) {
    if (!clientState.promise) {
        clientState.promise = new Promise((resolve, reject) => {
            const container = document.createElement('transient');
            const script = document.createElement('script');
            script.src = normalizeSessionHistoryServerUrl(serverUrl) + '/session.js';
            script.async = true;
            script.onload = () => {
                const client = window.SessionHistory;
                if (!client?.login || !client?.defaultSpec) {
                    reject(
                        new Error(
                            'The history server client is incompatible. Reload after checking the server version.'
                        )
                    );
                    return;
                }
                client.DEBUG = false;
                client.clearEntityKey();
                resolve(client);
            };
            script.onerror = () => {
                container.remove();
                clientState.promise = null;
                reject(new Error('Could not load the history server client. Check the server connection.'));
            };
            container.appendChild(script);
            document.body.appendChild(container);
        });
    }
    return clientState.promise;
}

function withClient(serverUrl, operation) {
    const serverBase = normalizeSessionHistoryServerUrl(serverUrl);
    const result = clientState.queue.then(async () => {
        const client = await loadClient(serverBase);
        if (clientState.server !== serverBase) {
            client.clearEntityKey();
            client._defaultSpec = null;
            clientState.server = serverBase;
        }
        client.serverBase = serverBase + '/';
        return operation(client);
    });
    clientState.queue = result.catch(() => {});
    return result;
}

function adaptSession(session, entityId, serverUrl) {
    // Keep upstream transports and lifecycle intact. Convert its synthetic
    // timeout replies to rejections expected by Stund's existing callers.
    const sendWithReply = session.sendWithReply.bind(session);
    session.sendWithReply = async (...args) => {
        const reply = await sendWithReply(...args);
        if (reply?.timedOut) throw new Error('History command timed out or the connection closed.');
        return reply;
    };
    session.serverBase = normalizeSessionHistoryServerUrl(serverUrl);
    session.websocket.addEventListener('close', () => {
        session.onDisconnect?.(
            'History connection closed. Check the server and session ID, or generate a new access token.'
        );
    });
    // Native media resolution uses global configuration; reject stale instances
    // instead of resolving their recordings against a newly selected server.
    const resolveMediaResource = session.resolveMediaResource.bind(session);
    session.resolveMediaResource = async (path) => {
        if (session.disposed || clientState.server !== session.serverBase)
            throw new Error('History session is disconnected.');
        SessionHistory.requireCredentials(entityId, serverUrl);
        return resolveMediaResource(path);
    };
    return session;
}

const credentials = clientState.credentials;

const credentialId = (entityId, serverUrl) =>
    `stund-history-auth:${JSON.stringify([normalizeSessionHistoryServerUrl(serverUrl), entityId])}`;
export class SessionHistory {
    static getTokenState(entityId, serverUrl = DEFAULT_SESSION_HISTORY_SERVER) {
        const id = credentialId(entityId, serverUrl);
        if (!credentials.has(id)) {
            try {
                credentials.set(id, JSON.parse(window.localStorage.getItem(id)));
            } catch {
                credentials.set(id, null);
            }
        }
        const auth = credentials.get(id);
        if (!auth || auth.entity !== entityId || !Number.isFinite(auth.expires)) {
            return { status: 'missing', expires: null };
        }
        if (auth.status === 'rejected') return { status: 'rejected', expires: auth.expires };
        if (auth.expires <= Date.now()) {
            if (auth.entityKey) SessionHistory.invalidateToken(entityId, serverUrl, 'expired');
            return { status: 'expired', expires: auth.expires };
        }
        return { status: auth.entityKey ? 'available' : 'missing', expires: auth.expires };
    }

    static getCredentials(entityId, serverUrl = DEFAULT_SESSION_HISTORY_SERVER) {
        if (SessionHistory.getTokenState(entityId, serverUrl).status !== 'available') return null;
        return credentials.get(credentialId(entityId, serverUrl));
    }

    static invalidateToken(entityId, serverUrl, status) {
        const id = credentialId(entityId, serverUrl);
        const previous = credentials.get(id);
        if (!previous) return;
        const metadata = { entity: previous.entity, expires: previous.expires, status };
        credentials.set(id, metadata);
        if (
            clientState.server === normalizeSessionHistoryServerUrl(serverUrl) &&
            window.SessionHistory?.getEntity() === entityId
        ) {
            window.SessionHistory.clearEntityKey();
        }
        try {
            window.localStorage.setItem(id, JSON.stringify(metadata));
        } catch {
            /* Memory-only storage. */
        }
    }

    static removeAccessToken(entityId, serverUrl = DEFAULT_SESSION_HISTORY_SERVER) {
        const id = credentialId(entityId, serverUrl);
        credentials.set(id, null);
        if (
            clientState.server === normalizeSessionHistoryServerUrl(serverUrl) &&
            window.SessionHistory?.getEntity() === entityId
        ) {
            window.SessionHistory.clearEntityKey();
        }
        try {
            window.localStorage.removeItem(id);
        } catch {
            /* Memory-only storage. */
        }
    }

    static async generateAccessToken(entityId, masterPassword, serverUrl = DEFAULT_SESSION_HISTORY_SERVER) {
        return withClient(serverUrl, async (client) => {
            let reply;
            try {
                reply = await client.login(entityId, masterPassword);
            } catch {
                throw new Error('Access token generation failed. Check the password and server configuration.');
            } finally {
                clearUnscopedStorage();
            }
            if (
                !reply.entityKey ||
                reply.entity !== entityId ||
                !Number.isFinite(reply.expires) ||
                reply.expires <= Date.now()
            ) {
                client.clearEntityKey();
                throw new Error('The server returned an invalid access token.');
            }
            const auth = { entityKey: reply.entityKey, entity: reply.entity, expires: reply.expires };
            const id = credentialId(entityId, serverUrl);
            credentials.set(id, auth);
            try {
                window.localStorage.setItem(id, JSON.stringify(auth));
            } catch {
                /* Memory-only storage. */
            }
            return { entity: auth.entity, expires: auth.expires };
        });
    }

    static requireCredentials(entityId, serverUrl) {
        const auth = SessionHistory.getCredentials(entityId, serverUrl);
        if (!auth) throw new Error('Access Token Required. Generate an access token first.');
        return auth;
    }

    static async create(entityId, serverUrl = DEFAULT_SESSION_HISTORY_SERVER) {
        return SessionHistory.connect(null, entityId, serverUrl);
    }

    static async join(sessionId, entityId, serverUrl = DEFAULT_SESSION_HISTORY_SERVER) {
        return SessionHistory.connect(sessionId, entityId, serverUrl);
    }

    static async connect(sessionId, entityId, serverUrl) {
        return withClient(serverUrl, async (client) => {
            const auth = SessionHistory.requireCredentials(entityId, serverUrl);
            client.setEntityKey(auth.entityKey, entityId);
            clearUnscopedStorage();
            const spec = sessionId ? null : buildSessionSpec(await client.defaultSpec());
            try {
                const session = sessionId ? await client.join(sessionId) : await client.create(spec);
                return adaptSession(session, entityId, serverUrl);
            } catch {
                if (!client.getEntityKey()) SessionHistory.invalidateToken(entityId, serverUrl, 'rejected');
                throw new Error(
                    'History connection failed. Check the server and session ID or spec, or generate a new access token.'
                );
            } finally {
                clearUnscopedStorage();
            }
        });
    }
}
