import { useState, useEffect, useCallback, useRef } from 'react';

import { useDOMState, useTransientDOMState } from '#CoreHelpers .dom-store';
import {
    SessionHistory,
    DEFAULT_SESSION_HISTORY_SERVER,
    normalizeSessionHistoryServerUrl
} from '#SessionHistory .api';



if (!window.sessionHistory) {
    window.sessionHistory = {};
}

export const useSession = () => {
    const [session, setSession] = useState(window.sessionHistory.session || null);
    const [sessionId, setSessionId] = useDOMState('history-session-id', '');
    const [sessionJoined, setSessionJoined] = useTransientDOMState('history-session-joined', false);
    const [autoJoinEnabled, setAutoJoinEnabled] = useDOMState('history-session-auto-join', false);
    const [historyServerOverride, setHistoryServerOverride] = useDOMState('history-model-server', '');
    const configuredHistoryServer = typeof historyServerOverride === 'string' && historyServerOverride.trim()
        ? historyServerOverride.trim()
        : DEFAULT_SESSION_HISTORY_SERVER;
    let effectiveHistoryServer = configuredHistoryServer;

    try {
        effectiveHistoryServer = normalizeSessionHistoryServerUrl(configuredHistoryServer);
    } catch (error) {
        // Preserve an invalid shared value so create/join can report the validation error.
    }
    const autoJoinCheckedOnLoadRef = useRef(false);

    useEffect(() => {
        if (sessionJoined && !session) {
            setSession(window.sessionHistory.session);
        }
    }, [sessionJoined]);

    const createSession = useCallback(async () => {
        if (!webstrate.user.userId) {
            alert('You must be logged in to create a session.');
            return;
        }

        if (sessionJoined) {
            alert('You have already joined a session.');
            return;
        }

        const confirmation = confirm('Creating a new session will overwrite any existing session for this meeting. Do you want to continue?');
        if (!confirmation) {
            return;
        }

        try {
            const newSession = await SessionHistory.create(webstrate.user.userId, effectiveHistoryServer);
            setSessionId(newSession.id);

            window.sessionHistory.session = newSession;
            setSession(newSession);
            setSessionJoined(true);
        } catch (error) {
            console.error('Failed to create session:', error);
            alert(`Failed to create session: ${error?.message || error}`);
        }
    }, [effectiveHistoryServer, sessionJoined, setSessionId, setSessionJoined]);

    const joinSession = useCallback(async () => {
        if (!webstrate.user.userId) {
            alert('You must be logged in to join a session.');
            return;
        }

        if (!sessionId) {
            alert('The meeting does not have a session ID.');
            return;
        }

        if (sessionJoined) {
            alert('You have already joined the session.');
            return;
        }

        try {
            const newSession = await SessionHistory.join(sessionId, webstrate.user.userId, effectiveHistoryServer);

            window.sessionHistory.session = newSession;
            setSession(newSession);
            setSessionJoined(true);
        } catch (error) {
            console.error('Failed to join session:', error);
            alert(`Failed to join session: ${error?.message || error}`);
        }
    }, [effectiveHistoryServer, sessionId, sessionJoined, setSessionJoined]);

    const disconnectSession = useCallback(() => {
        if (!sessionJoined) {
            return;
        }

        const activeSession = session || window.sessionHistory.session;
        if (activeSession && typeof activeSession.dispose === 'function') {
            try {
                activeSession.dispose();
            } catch (error) {
                console.warn('Failed to dispose session cleanly:', error);
            }
        }

        window.sessionHistory.session = null;
        window.sessionHistory.model = null;
        window.sessionHistory.ingest = null;

        setSession(null);
        setSessionJoined(false);
    }, [session, sessionJoined, setSessionJoined]);

    useEffect(() => {
        if (autoJoinCheckedOnLoadRef.current) {
            return;
        }
        autoJoinCheckedOnLoadRef.current = true;

        if (!autoJoinEnabled || !sessionId || sessionJoined) {
            return;
        }

        joinSession();
    }, []);

    return {
        session,
        sessionId,
        sessionJoined,
        autoJoinEnabled,
        historyServerOverride,
        effectiveHistoryServer,
        defaultHistoryServer: DEFAULT_SESSION_HISTORY_SERVER,
        setAutoJoinEnabled,
        setHistoryServerOverride,
        createSession,
        joinSession,
        disconnectSession
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
        const mediaResourceId = voiceDetectEvent?.event?.track?.ressource;

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
    const [ingest, setIngest] = useState(window.sessionHistory.ingest || null);

    useEffect(() => {
        if (!session) {
            setIngest(null);
            return;
        }

        if (session && !ingest) {
            session.connectIngest().then((newIngest) => {
                window.sessionHistory.ingest = newIngest;
                setIngest(newIngest);
            });
        }
    }, [session]);

    return ingest;
};

export const useSessionModel = () => {
    const { session } = useSession();
    const [model, setModel] = useState(window.sessionHistory.model || null);

    useEffect(() => {
        if (!session) {
            setModel(null);
            return;
        }
        if (model) return;

        const runAsync = async () => {
            if (window.sessionHistory.model) {
                setModel(window.sessionHistory.model);
                return;
            }

            const newModel = await session.connectModel('history');
            window.sessionHistory.model = newModel;
            setModel(newModel);
        };

        runAsync();
    }, [session]);

    return model;
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
