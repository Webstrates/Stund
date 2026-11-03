import { useState, useEffect, useCallback } from 'react';

import { useDOMState, useTransientDOMState } from '#CoreHelpers .dom-store';
import {
    SessionHistory,
    DEFAULT_SESSION_HISTORY_SERVER,
    normalizeSessionHistoryServerUrl
} from '#SessionHistory .api';



// Connection and credentials are local to this browser, never synchronized.
const runtime = window.sessionHistory || (window.sessionHistory = {});
const notify = () => window.dispatchEvent(new Event('stund-history-local-change'));
const reportError = (message) => {
    runtime.error = message;
    notify();
};

function clearConnection() {
    runtime.generation = (runtime.generation || 0) + 1;
    const session = runtime.session;
    runtime.session = null;
    runtime.model = null;
    runtime.ingest = null;
    runtime.modelPromise = null;
    runtime.busy = false;
    if (session) {
        session.onDisconnect = null;
        session.dispose();
    }
    notify();
}

export const useSession = () => {
    const [, refresh] = useState(0);
    const [sessionId, setSessionId] = useDOMState('history-session-id', '');
    const [sessionJoinedFlag, setSessionJoined] = useTransientDOMState('history-session-joined', false);
    const [autoJoinEnabled, setAutoJoinEnabled] = useDOMState('history-session-auto-join', false);
    const [historyServerOverride, setHistoryServerOverride] = useDOMState('history-model-server', '');
    const entityId = webstrate.user.userId;
    const effectiveHistoryServer = normalizeSessionHistoryServerUrl(historyServerOverride || DEFAULT_SESSION_HISTORY_SERVER);
    const context = JSON.stringify([effectiveHistoryServer, entityId]);
    const tokenState = entityId
        ? SessionHistory.getTokenState(entityId, effectiveHistoryServer)
        : { status: 'missing', expires: null };
    const hasAccessToken = tokenState.status === 'available';
    const session = runtime.session || null;
    const sessionJoined = !!session;

    useEffect(() => {
        const update = () => refresh((value) => value + 1);
        window.addEventListener('stund-history-local-change', update);
        window.addEventListener('focus', update);
        document.addEventListener('visibilitychange', update);
        const timer = setInterval(update, 30000);
        return () => {
            window.removeEventListener('stund-history-local-change', update);
            window.removeEventListener('focus', update);
            document.removeEventListener('visibilitychange', update);
            clearInterval(timer);
        };
    }, []);

    useEffect(() => {
        if (!hasAccessToken || !tokenState.expires) return;
        const timer = setTimeout(() => refresh((value) => value + 1), Math.min(2147483647, Math.max(0, tokenState.expires - Date.now())));
        return () => clearTimeout(timer);
    }, [hasAccessToken, tokenState.expires]);

    useEffect(() => {
        if (runtime.context !== context) {
            runtime.context = context;
            clearConnection();
            runtime.error = '';
            setSessionJoined(false);
        }
    }, [context]);

    useEffect(() => {
        if (sessionJoinedFlag !== sessionJoined) setSessionJoined(sessionJoined);
    }, [sessionJoined, sessionJoinedFlag]);

    const generateAccessToken = async (password) => {
        if (runtime.busy || !entityId) return;
        runtime.busy = true;
        runtime.error = '';
        const generation = runtime.generation;
        notify();
        try {
            await SessionHistory.generateAccessToken(entityId, password, effectiveHistoryServer);
        } catch (error) {
            if (runtime.generation === generation) runtime.error = error.message.startsWith('Access token generation') || error.message.startsWith('The server returned') ? error.message : 'Access token generation failed. Check the server connection.';
        } finally {
            if (runtime.generation === generation) {
                runtime.busy = false;
                notify();
            }
        }
    };

    const connect = async (create) => {
        if (runtime.busy || runtime.session) return;
        if (!SessionHistory.getCredentials(entityId, effectiveHistoryServer)) {
            reportError('Access Token Required. Generate an access token first.');
            return;
        }
        if (!create && !sessionId) return;
        if (create && !confirm('Creating a new session will overwrite any existing session for this meeting. Do you want to continue?')) return;
        runtime.busy = true;
        runtime.error = '';
        const generation = runtime.generation;
        notify();
        try {
            const connected = create
                ? await SessionHistory.create(entityId, effectiveHistoryServer)
                : await SessionHistory.join(sessionId, entityId, effectiveHistoryServer);
            if (runtime.generation !== generation || runtime.context !== context) {
                connected.dispose();
                return;
            }
            runtime.session = connected;
            connected.onError = reportError;
            connected.onDisconnect = (message) => {
                if (runtime.session !== connected) return;
                clearConnection();
                setSessionJoined(false);
                reportError(message);
            };
            if (create) setSessionId(connected.id);
            setSessionJoined(true);
        } catch (error) {
            if (runtime.generation === generation) {
                // Browser fetch errors may include keyed URLs; only expose our safe messages.
                runtime.error = /^(History |Access Token Required|Session schema|Session creation|The server returned|Could not fetch|The history server)/.test(error.message)
                    ? error.message : 'Could not connect to the history server. Check the connection or generate a new access token.';
            }
        } finally {
            if (runtime.generation === generation) {
                runtime.busy = false;
                notify();
            }
        }
    };

    useEffect(() => {
        if (runtime.autoJoinChecked) return;
        runtime.autoJoinChecked = true;
        if (autoJoinEnabled && sessionId && hasAccessToken && !runtime.session) connect(false);
    }, []);

    return {
        session, sessionId, sessionJoined, autoJoinEnabled, historyServerOverride,
        effectiveHistoryServer, defaultHistoryServer: DEFAULT_SESSION_HISTORY_SERVER,
        setAutoJoinEnabled, setHistoryServerOverride,
        tokenState, hasAccessToken, canGenerateAccessToken: !!entityId,
        busy: !!runtime.busy, error: runtime.error || '',
        generateAccessToken,
        removeAccessToken: () => {
            clearConnection();
            SessionHistory.removeAccessToken(entityId, effectiveHistoryServer);
            setSessionJoined(false);
            runtime.error = '';
            notify();
        },
        createSession: () => connect(true),
        joinSession: () => connect(false),
        clearSessionId: () => {
            if (runtime.busy || runtime.session || !sessionId) return;
            if (!confirm('Clear the session ID for everyone in this workspace?')) return;
            setSessionId('');
        },
        disconnectSession: () => {
            clearConnection();
            setSessionJoined(false);
        }
    };
};

export const useSessionHelpers = () => {
    const { session } = useSession();

    const getAudioUrlFromTranscriptEventId = useCallback(async (eventId) => {
        if (!session) {
            throw new Error('No active session');
        }

        const transcriptEvent = await session.getEvent(eventId, { includeMeta: true });
        const voiceDetectEventId = transcriptEvent?.event?.sourceEvents?.[0];

        if (!voiceDetectEventId) {
            throw new Error(`No source events found for transcript event ID ${eventId}`);
        }

        const voiceDetectEvent = await session.getEvent(voiceDetectEventId, { includeMeta: true });
        const mediaResourceId = voiceDetectEvent?.event?.track?.resource ?? voiceDetectEvent?.event?.track?.ressource;

        if (!mediaResourceId) {
            throw new Error(`No media resource found for event ID ${voiceDetectEventId}`);
        }

        const resourceUrl = await session.resolveMediaResource(mediaResourceId);

        if (!resourceUrl) {
            throw new Error(`Failed to resolve media resource URL for resource ID ${mediaResourceId}`);
        }

        return resourceUrl;
    }, [session]);

    return {
        getAudioUrlFromTranscriptEventId
    };
};

export const useSessionIngest = () => {
    const { session } = useSession();
    const [ingest, setIngest] = useState(null);
    useEffect(() => {
        let active = true;
        setIngest(null);
        if (!session) return;
        session.connectIngest().then((connected) => {
            if (!active || runtime.session !== session) return;
            connected.onIngestError = () => reportError('History media recording failed. Disconnect and reconnect to retry.');
            runtime.ingest = connected;
            setIngest(connected);
        }).catch(() => {
            if (active && runtime.session === session) reportError('History ingest connection failed. Disconnect and reconnect to retry.');
        });
        return () => { active = false; };
    }, [session]);
    return session && runtime.ingest === ingest ? ingest : null;
};

export const useSessionModel = () => {
    const { session } = useSession();
    const [model, setModel] = useState(null);
    useEffect(() => {
        let active = true;
        setModel(null);
        if (!session) return;
        if (!runtime.modelPromise) {
            runtime.modelPromise = session.connectModel('history');
        }
        runtime.modelPromise.then((connected) => {
            if (!active || runtime.session !== session) return;
            runtime.model = connected;
            setModel(connected);
        }).catch(() => {
            if (active && runtime.session === session) {
                runtime.modelPromise = null;
                reportError('History model connection failed. Disconnect and reconnect to retry.');
            }
        });
        return () => { active = false; };
    }, [session]);
    return session && model?.session === session ? model : null;
};

/**
 * Resolves $ref references within a schema object using the provided schemas map.
 * Returns a new object with all $ref replaced by their resolved definitions.
 */
export function resolveSchemaRefs(schema, schemasMap, visited = new Set()) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(item => resolveSchemaRefs(item, schemasMap, visited));

    if (schema.$ref) {
        const refId = schema.$ref;
        if (visited.has(refId)) return { $ref: refId, _circular: true };
        const resolved = schemasMap[refId];
        if (resolved) {
            visited.add(refId);
            return resolveSchemaRefs(resolved, schemasMap, visited);
        }
        return schema;
    }

    const result = {};
    for (const [key, value] of Object.entries(schema)) {
        if (key === '$schema' || key === '$id') continue;
        result[key] = resolveSchemaRefs(value, schemasMap, visited);
    }
    return result;
}
