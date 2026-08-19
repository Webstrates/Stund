import React from 'react';
const { useState, useEffect, useRef, useCallback } = React;

import { useDOMState } from '#CoreHelpers .dom-store';
import { useGlobalEvents } from '#CoreHelpers .global-events';
import {
    AI_CHAT_DOM_STORE_KEY,
    AI_CHAT_ENTRY_EVENT,
    AI_CHAT_STEP_EVENT,
    normalizePromptResult,
    safeClone,
    sanitizeEntriesForSharedPersistence
} from '#AIChatComponent .chat-contract';
import {
    extractImageContextMetadata,
    normalizeImageDataUrl
} from '#AIChatComponent .image-context';
import {
    extractShapeContextMetadata,
    normalizeAndDedupeShapeDescriptors
} from '#AIChatComponent .shape-context';



const buildToolGroupStateMap = (groups, existingState = null) => {
    const nextState = {};
    const previousState = existingState && typeof existingState === 'object' ? existingState : null;
    (Array.isArray(groups) ? groups : []).forEach((group) => {
        if (typeof group?.key === 'string' && group.key.trim()) {
            if (group.alwaysEnabled) {
                nextState[group.key] = true;
                return;
            }
            const previousValue = previousState ? previousState[group.key] : undefined;
            nextState[group.key] = typeof previousValue === 'boolean'
                ? previousValue
                : Boolean(group.enabled);
        }
    });
    return nextState;
};

const buildToolGroupStateFromIds = (groups, activeToolGroupIds) => {
    const enabledKeys = new Set(Array.isArray(activeToolGroupIds) ? activeToolGroupIds : []);
    const nextState = {};
    (Array.isArray(groups) ? groups : []).forEach((group) => {
        if (typeof group?.key === 'string' && group.key.trim()) {
            nextState[group.key] = group.alwaysEnabled ? true : enabledKeys.has(group.key);
        }
    });
    return nextState;
};



export function useChatSession({
    chatId,
    profiles,
    connectors,
    persisted,
    onEntriesChange,
    onProcessingChange,
    onReset
}) {
    const { triggerEvent } = useGlobalEvents();
    const [currentProfile, setCurrentProfile] = useState(null);
    const [currentConnector, setCurrentConnector] = useState(null);
    const [isDisabled, setIsDisabled] = useState(true);
    const [entries, setEntriesInternal] = useState([]);
    const [isProcessing, setIsProcessingInternal] = useState(false);
    const [isLocalProcessing, setIsLocalProcessing] = useState(true);
    const [entryImagePreviews, setEntryImagePreviews] = useState({});
    const [toolGroupDefinitions, setToolGroupDefinitions] = useState([]);

    const [entriesPersisted, setEntriesPersisted] = useDOMState(`chat-entries-${chatId}`, [], AI_CHAT_DOM_STORE_KEY, persisted);
    const [isProcessingPersisted, setIsProcessingPersisted] = useDOMState(`chat-processing-${chatId}`, false, AI_CHAT_DOM_STORE_KEY, persisted);
    const [toolGroupState, setToolGroupState] = useDOMState(`chat-toolgroups-${chatId}`, {}, AI_CHAT_DOM_STORE_KEY, persisted);

    const currentRequestIdRef = useRef(null);
    const progressCallbackRef = useRef(null);
    const activeConnectorRef = useRef(null);
    const pendingEntriesChangeRef = useRef(null);
    const emittedEntryIdsRef = useRef(new Set());
    const toolGroupStateRef = useRef(toolGroupState && typeof toolGroupState === 'object' ? toolGroupState : {});
    const currentProfileRef = useRef(currentProfile);
    const currentConnectorRef = useRef(currentConnector);
    currentProfileRef.current = currentProfile;
    currentConnectorRef.current = currentConnector;

    const clearEntryImagePreviews = useCallback(() => {
        setEntryImagePreviews({});
    }, []);

    const setEntryImagePreviewsForEntry = useCallback((entryId, imagePreviews) => {
        if (!entryId || !Array.isArray(imagePreviews) || imagePreviews.length < 1) {
            return;
        }

        const validPreviews = imagePreviews
            .map((preview) => {
                const normalizedDataUrl = normalizeImageDataUrl(preview?.dataUrl, preview?.mimeType);
                if (!normalizedDataUrl) {
                    return null;
                }

                return {
                    ...preview,
                    dataUrl: normalizedDataUrl
                };
            })
            .filter(Boolean);
        if (validPreviews.length < 1) {
            return;
        }

        setEntryImagePreviews((previousMap) => ({
            ...previousMap,
            [entryId]: validPreviews.map((preview) => ({
                id: preview.id,
                name: preview.name || 'Attached image',
                mimeType: preview.mimeType || 'image/png',
                sizeBytes: preview.sizeBytes || null,
                dataUrl: preview.dataUrl
            }))
        }));
    }, []);

    const setIsProcessing = useCallback((value) => {
        if (persisted) {
            setIsProcessingPersisted(value);
        } else {
            setIsProcessingInternal(value);
        }
    }, [persisted, setIsProcessingPersisted]);

    useEffect(() => {
        if (persisted && isProcessingPersisted !== undefined) {
            setIsProcessingInternal(isProcessingPersisted);
        }
    }, [persisted, isProcessingPersisted]);

    useEffect(() => {
        toolGroupStateRef.current = toolGroupState && typeof toolGroupState === 'object' ? toolGroupState : {};
    }, [toolGroupState]);

    useEffect(() => {
        if (onProcessingChange) {
            const isLocal = currentRequestIdRef.current !== null;
            setIsLocalProcessing(isLocal);
            onProcessingChange(isProcessing, isLocal);
        }
    }, [isProcessing, onProcessingChange]);

    useEffect(() => {
        if (persisted && Array.isArray(entriesPersisted)) {
            setEntriesInternal(entriesPersisted);
        }
    }, [persisted, entriesPersisted]);

    useEffect(() => {
        if (pendingEntriesChangeRef.current && onEntriesChange) {
            onEntriesChange(pendingEntriesChangeRef.current);
            pendingEntriesChangeRef.current = null;
        }
    }, [entries, onEntriesChange]);

    useEffect(() => {
        setEntryImagePreviews((previousMap) => {
            const activeEntryIds = new Set((Array.isArray(entries) ? entries : []).map((entry) => entry?.id).filter(Boolean));
            let didChange = false;
            const nextMap = {};

            Object.entries(previousMap || {}).forEach(([entryId, imagePreviews]) => {
                if (activeEntryIds.has(entryId)) {
                    nextMap[entryId] = imagePreviews;
                } else {
                    didChange = true;
                }
            });

            return didChange ? nextMap : previousMap;
        });
    }, [entries]);

    const emitFinalizedEntries = useCallback((previousEntries, nextEntries) => {
        const previousEntryMap = new Map();
        (Array.isArray(previousEntries) ? previousEntries : []).forEach((entry) => {
            if (entry?.id) {
                previousEntryMap.set(entry.id, entry);
            }
        });

        (Array.isArray(nextEntries) ? nextEntries : []).forEach((entry) => {
            if (!entry?.id || !entry?.hasResult || emittedEntryIdsRef.current.has(entry.id)) {
                return;
            }

            const previousEntry = previousEntryMap.get(entry.id);
            if (previousEntry?.hasResult) {
                return;
            }

            emittedEntryIdsRef.current.add(entry.id);
            triggerEvent(AI_CHAT_ENTRY_EVENT, {
                chatId,
                persisted,
                entry
            });
        });
    }, [triggerEvent, chatId, persisted]);

    const setEntries = useCallback((newEntriesOrUpdater) => {
        if (persisted) {
            setEntriesPersisted((previousValue) => {
                const previousEntries = Array.isArray(previousValue) ? previousValue : [];
                const nextEntriesValue = typeof newEntriesOrUpdater === 'function'
                    ? newEntriesOrUpdater(previousEntries)
                    : newEntriesOrUpdater;
                const nextEntries = sanitizeEntriesForSharedPersistence(nextEntriesValue);

                emitFinalizedEntries(previousEntries, nextEntries);
                if (onEntriesChange) {
                    pendingEntriesChangeRef.current = nextEntries;
                }
                return nextEntries;
            });
            return;
        }

        setEntriesInternal((previousValue) => {
            const previousEntries = Array.isArray(previousValue) ? previousValue : [];
            const nextEntries = typeof newEntriesOrUpdater === 'function'
                ? newEntriesOrUpdater(previousEntries)
                : newEntriesOrUpdater;

            emitFinalizedEntries(previousEntries, nextEntries);
            if (onEntriesChange) {
                pendingEntriesChangeRef.current = nextEntries;
            }
            return nextEntries;
        });
    }, [persisted, setEntriesPersisted, onEntriesChange, emitFinalizedEntries]);

    const setProfile = useCallback(async (profile) => {
        await profile.onInit();

        const connector = profile.connector || connectors[0] || null;
        setIsDisabled(!connector);
        setCurrentProfile(profile);
        setCurrentConnector(connector);
        if (!persisted) {
            setEntries([]);
            clearEntryImagePreviews();
        }
    }, [connectors, persisted, setEntries, clearEntryImagePreviews]);

    useEffect(() => {
        if (profiles.length < 1) {
            return;
        }

        const nextProfile = profiles[0];
        if (!currentProfileRef.current || (nextProfile.connector && nextProfile.connector !== currentConnectorRef.current)) {
            setProfile(nextProfile);
        }
    }, [profiles, setProfile]);

    const cancel = useCallback(() => {
        if (!currentRequestIdRef.current) {
            return;
        }

        currentRequestIdRef.current = null;
        const connector = activeConnectorRef.current;
        if (connector) {
            connector.isCancelled = true;
            if (progressCallbackRef.current) {
                connector.removeExecutionListener(progressCallbackRef.current);
                progressCallbackRef.current = null;
            }
            activeConnectorRef.current = null;
        }

        setEntries((previousEntries) => {
            const updatedEntries = [...previousEntries];
            const lastAssistantIndex = updatedEntries.findLastIndex((entry) => entry.type === 'assistant');
            if (lastAssistantIndex >= 0) {
                const now = new Date();
                updatedEntries[lastAssistantIndex] = {
                    ...updatedEntries[lastAssistantIndex],
                    content: 'Request cancelled',
                    timestamp: now.toLocaleTimeString(),
                    timestampEpoch: now.getTime(),
                    timestampIso: now.toISOString(),
                    hasResult: true,
                    cancelled: true
                };
            }
            return updatedEntries;
        });
        setIsProcessing(false);
    }, [setEntries, setIsProcessing]);

    useEffect(() => {
        return () => {
            if (!currentRequestIdRef.current) {
                return;
            }

            currentRequestIdRef.current = null;
            const connector = activeConnectorRef.current;
            if (connector) {
                connector.isCancelled = true;
                if (progressCallbackRef.current) {
                    connector.removeExecutionListener(progressCallbackRef.current);
                    progressCallbackRef.current = null;
                }
                activeConnectorRef.current = null;
            }
        };
    }, []);

    useEffect(() => {
        if (!currentProfile || typeof currentProfile.getToolGroups !== 'function') {
            setToolGroupDefinitions([]);
            return;
        }

        const groups = currentProfile.getToolGroups() || [];
        setToolGroupDefinitions(groups);
        const normalizedToolGroupState = buildToolGroupStateMap(groups, toolGroupStateRef.current);
        toolGroupStateRef.current = normalizedToolGroupState;
        setToolGroupState(normalizedToolGroupState);
    }, [currentProfile, setToolGroupState]);

    const toggleToolGroup = useCallback((groupKey, enabled) => {
        const targetGroup = toolGroupDefinitions.find((group) => group?.key === groupKey);
        if (targetGroup?.alwaysEnabled) {
            return;
        }

        const previousState = toolGroupStateRef.current && typeof toolGroupStateRef.current === 'object'
            ? toolGroupStateRef.current
            : {};
        if (previousState[groupKey] === enabled) {
            return;
        }

        const nextState = {
            ...previousState,
            [groupKey]: enabled
        };
        toolGroupStateRef.current = nextState;
        setToolGroupState(nextState);
    }, [toolGroupDefinitions, setToolGroupState]);

    const reset = useCallback(async () => {
        if (isProcessing && !confirm('A message is still being processed. Do you want to cancel it and restart?')) {
            return false;
        }

        cancel();
        clearEntryImagePreviews();
        setEntries([]);
        if (currentProfile && typeof currentProfile.onInit === 'function') {
            await currentProfile.onInit();
            if (typeof currentProfile.getToolGroups === 'function') {
                const groups = currentProfile.getToolGroups() || [];
                setToolGroupDefinitions(groups);
                const normalizedToolGroupState = buildToolGroupStateMap(groups, toolGroupStateRef.current);
                toolGroupStateRef.current = normalizedToolGroupState;
                setToolGroupState(normalizedToolGroupState);
            }
        }

        if (onReset) {
            onReset();
        }
        return true;
    }, [isProcessing, cancel, clearEntryImagePreviews, currentProfile, onReset, setEntries, setToolGroupState]);

    const applyExternalToolGroups = useCallback((requestedToolGroups) => {
        if (toolGroupDefinitions.length < 1 || !Array.isArray(requestedToolGroups)) {
            return false;
        }

        const nextState = buildToolGroupStateFromIds(toolGroupDefinitions, requestedToolGroups);
        const previousState = toolGroupStateRef.current && typeof toolGroupStateRef.current === 'object'
            ? toolGroupStateRef.current
            : {};
        const didChange = Object.entries(nextState).some(([key, value]) => previousState[key] !== value);
        if (!didChange) {
            return true;
        }

        const mergedState = {
            ...previousState,
            ...nextState
        };
        toolGroupStateRef.current = mergedState;
        setToolGroupState(mergedState);
        return true;
    }, [toolGroupDefinitions, setToolGroupState]);

    const createProgressEntry = useCallback((state) => {
        // Don't show internal tools
        if ((state.type === 'toolCall' || state.type === 'toolReturn') &&
            ['resolve', 'reject'].includes(state.context.name)) {
            return null;
        }

        let description;
        switch (state.type) {
            case 'stackEntry':
                description = state.context.connector?.name;
                break;
            case 'slopCall':
            case 'toolCall':
                description = state.context.name;
                break;
        }

        const now = new Date();
        const progressEntry = {
            type: state.type,
            description: description || '',
            timestampIso: now.toISOString(),
            timestampEpoch: now.getTime()
        };

        if (state.context.args) {
            progressEntry.arguments = state.context.args.map(arg => {
                try {
                    if (typeof arg === 'function') {
                        if (arg.isInvokableTool) {
                            return `[Tool: ${arg.context?.name}]`;
                        }
                        return arg.toString();
                    }
                    return safeClone(arg, String(arg));
                } catch (e) {
                    return String(arg);
                }
            });
        }

        if (state.context.returnValue !== undefined) {
            try {
                progressEntry.returnValue = safeClone(state.context.returnValue, String(state.context.returnValue));
            } catch (e) {
                progressEntry.returnValue = String(state.context.returnValue);
            }

            if (state.type === 'slopReturn' && state.context.isImplicitResolve &&
                progressEntry.returnValue && typeof progressEntry.returnValue === 'object' && !Array.isArray(progressEntry.returnValue)) {
                progressEntry.returnValue.implicit = true;
            }
        }

        if (state.context.error) {
            progressEntry.error = String(state.context.error);
        }

        return progressEntry;
    }, []);

    const runSubmit = useCallback(async ({ text, images, shapes, onAccepted }) => {
        const requestId = `entry-${crypto.randomUUID()}`;
        currentRequestIdRef.current = requestId;
        activeConnectorRef.current = currentConnector;
        currentConnector.isCancelled = false;
        setIsProcessing(true);

        const isCancelled = () => currentRequestIdRef.current !== requestId;
        const imageContextForPrompt = images.map((contextImage) => ({
            id: contextImage.id,
            name: contextImage.name,
            mimeType: contextImage.mimeType,
            sizeBytes: contextImage.sizeBytes,
            dataUrl: contextImage.dataUrl
        }));
        const shapeContextForPrompt = normalizeAndDedupeShapeDescriptors(shapes)
            .map((descriptor) => descriptor?.shape || null)
            .filter(Boolean);

        if (typeof onAccepted === 'function') {
            onAccepted();
        }

        const now = new Date();
        const userEntryId = `user-${requestId}`;
        const assistantEntryId = `assistant-${requestId}`;

        setEntryImagePreviewsForEntry(userEntryId, imageContextForPrompt);

        const userEntry = {
            id: userEntryId,
            type: 'user',
            content: text,
            author: window.webstrate?.user?.userId || 'User',
            timestamp: now.toLocaleTimeString(),
            timestampEpoch: now.getTime(),
            timestampIso: now.toISOString(),
            hasResult: true,
            progress: [],
            imageContext: extractImageContextMetadata(imageContextForPrompt),
            shapeContext: extractShapeContextMetadata(shapeContextForPrompt)
        };

        const assistantEntry = {
            id: assistantEntryId,
            type: 'assistant',
            content: '',
            author: 'AI Assistant',
            timestamp: '',
            timestampEpoch: null,
            timestampIso: null,
            hasResult: false,
            progress: []
        };

        // Emit user entry event synchronously and directly before anything else
        // This guarantees proper entryIndex ordering in the recorder
        emittedEntryIdsRef.current.add(userEntry.id);
        triggerEvent(AI_CHAT_ENTRY_EVENT, {
            chatId,
            persisted,
            entry: userEntry
        });

        setEntries(prev => [...prev, userEntry, assistantEntry]);

        const progressCallback = (state) => {
            if (isCancelled()) return;

            const progressEntry = createProgressEntry(state);
            if (progressEntry) {
                setEntries(prev => {
                    const updated = [...prev];
                    const assistantIdx = updated.findIndex(e => e.id === assistantEntryId);
                    if (assistantIdx >= 0) {
                        updated[assistantIdx] = {
                            ...updated[assistantIdx],
                            progress: [...updated[assistantIdx].progress, progressEntry]
                        };
                    }
                    return updated;
                });

                // Emit live step event for history recording
                triggerEvent(AI_CHAT_STEP_EVENT, {
                    chatId,
                    entryId: assistantEntryId,
                    step: progressEntry
                });
            }
        };

        // Store callback ref so it can be removed on cancel
        progressCallbackRef.current = progressCallback;
        currentConnector.addExecutionListener(progressCallback, { subtree: true });

        try {
            await currentConnector.run(async () => {
                try {
                    if (isCancelled()) return;

                    const messages = [];

                    entries.forEach(entry => {
                        const messageShapeContext = extractShapeContextMetadata(entry.shapeContext);
                        if (entry.type === 'user') {
                            messages.push({
                                role: 'user',
                                content: entry.content || '',
                                shapeContext: messageShapeContext
                            });
                        } else if (entry.type === 'assistant' && entry.hasResult) {
                            messages.push({
                                role: 'assistant',
                                content: entry.content || '',
                                shapeContext: messageShapeContext
                            });
                        }
                    });

                    messages.push({
                        role: 'user',
                        content: text
                    });

                    const activeToolGroupIds = toolGroupDefinitions
                        .filter((group) => Boolean(group.alwaysEnabled || toolGroupStateRef.current?.[group.key]))
                        .map((group) => group.key);
                    const result = await currentProfile.onPrompt(messages, activeToolGroupIds, imageContextForPrompt, shapeContextForPrompt);
                    const normalizedResult = normalizePromptResult(result);

                    if (isCancelled()) return;

                    const resultTime = new Date();
                    setEntries(prev => {
                        const updated = [...prev];
                        const assistantIdx = updated.findIndex(e => e.id === assistantEntryId);
                        if (assistantIdx >= 0) {
                            updated[assistantIdx] = {
                                ...updated[assistantIdx],
                                content: normalizedResult.content,
                                shapeContext: normalizedResult.shapeContext,
                                timestamp: resultTime.toLocaleTimeString(),
                                timestampEpoch: resultTime.getTime(),
                                timestampIso: resultTime.toISOString(),
                                hasResult: true
                            };
                        }
                        return updated;
                    });

                    return normalizedResult;
                } catch (ex) {
                    if (isCancelled()) return;

                    const errorTime = new Date();
                    setEntries(prev => {
                        const updated = [...prev];
                        const assistantIdx = updated.findIndex(e => e.id === assistantEntryId);
                        if (assistantIdx >= 0) {
                            updated[assistantIdx] = {
                                ...updated[assistantIdx],
                                content: ex.toString(),
                                timestamp: errorTime.toLocaleTimeString(),
                                timestampEpoch: errorTime.getTime(),
                                timestampIso: errorTime.toISOString(),
                                hasResult: true,
                                exception: true
                            };
                        }
                        return updated;
                    });
                }
            });
        } catch (ex) {
            if (!isCancelled()) {
                console.error('Submit error:', ex);
            }
        }

        // Only remove listener if it hasn't been removed by cancel
        if (progressCallbackRef.current) {
            currentConnector.removeExecutionListener(progressCallback);
            progressCallbackRef.current = null;
        }

        if (!isCancelled()) {
            currentRequestIdRef.current = null;
            activeConnectorRef.current = null;
            setIsProcessing(false);
        }
    }, [currentConnector, currentProfile, createProgressEntry, setIsProcessing, entries, toolGroupDefinitions, setEntryImagePreviewsForEntry, triggerEvent, chatId, persisted, setEntries]);

    const submitCommand = useCallback((command = {}, onAccepted = null) => {
        const text = typeof command.text === 'string' ? command.text : '';
        const images = Array.isArray(command.images) ? command.images : [];
        const shapes = Array.isArray(command.shapes) ? command.shapes : [];
        const hasContext = images.length > 0 || shapes.length > 0;
        if (isProcessing || (!text.trim() && !hasContext) || !currentConnector) {
            return false;
        }

        void runSubmit({ text, images, shapes, onAccepted });
        return true;
    }, [isProcessing, currentConnector, runSubmit]);

    const displayedToolGroups = toolGroupDefinitions.map((group) => ({
        ...group,
        enabled: Boolean(group.alwaysEnabled || toolGroupState?.[group.key])
    }));

    return {
        entries,
        entryImagePreviews,
        isProcessing,
        isLocalProcessing,
        isDisabled,
        currentProfile,
        currentConnector,
        displayedToolGroups,
        setProfile,
        setConnector: setCurrentConnector,
        toggleToolGroup,
        applyExternalToolGroups,
        submit: submitCommand,
        cancel,
        reset
    };
}
