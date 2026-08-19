import React from 'react';
const { useEffect, useRef, useCallback } = React;

import { useGlobalEvents } from '#CoreHelpers .global-events';
import { useCookieState } from '#CoreHelpers .cookie-store';
import { useSessionIngest } from '#SessionHistory .default';
import { AI_CHAT_ENTRY_EVENT, AI_CHAT_STEP_EVENT } from '#AIChatComponent .default';



const CHAT_ENTRY_EVENT_STREAM = 'application.chat.entry';
const CHAT_STEP_EVENT_STREAM = 'application.chat.step';

const mapChatStep = (chatId, entryId, step, entryIndex, stepIndex) => {
    const mappedStep = {
        chatId: chatId,
        entryId: entryId,
        entryIndex: entryIndex,
        stepIndex: stepIndex,
        type: step.type,
        description: step.description
    };

    if (Array.isArray(step.arguments)) {
        mappedStep.arguments = step.arguments;
    }

    if (step.returnValue !== undefined) {
        mappedStep.returnValue = step.returnValue;
    }

    if (typeof step.error === 'string') {
        mappedStep.exception = step.error;
    }

    return mappedStep;
};

const mapChatEntry = (chatId, persisted, entry, entryIndex) => {
    const imageContext = entry.imageContext?.map((image) => ({
        id: image.id,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes
    })) || [];

    const shapeContext = entry.shapeContext?.map((shape) => ({
        id: shape.id,
        type: shape.type,
        x: shape.x,
        y: shape.y,
        rotation: shape.rotation,
        opacity: shape.opacity,
        props: shape.props
    })) || [];

    return {
        chatId: chatId,
        chatShared: persisted,
        entryId: entry.id,
        entryIndex: entryIndex,
        type: entry.type,
        status: entry.cancelled ? 'cancelled' : entry.exception ? 'exception' : 'completed',
        author: entry.author,
        content: entry.content,
        imageContext: imageContext,
        shapeContext: shapeContext,
        stepCount: entry.progress.length
    };
};

export function Main() {
    const ingest = useSessionIngest();
    const { subscribeEvent } = useGlobalEvents();
    const [active] = useCookieState('chatRecorderActive', true);

    // Track event indices per chat and step indices per entry
    const entryIndexCountersRef = useRef(new Map()); // chatId -> entryIndex
    const stepCountersRef = useRef(new Map()); // entryId -> stepIndex
    const entryIndexRef = useRef(new Map()); // entryId -> pre-allocated entryIndex

    const getNextEntryIndex = useCallback((chatId) => {
        const counters = entryIndexCountersRef.current;
        const current = counters.get(chatId) || 0;
        const next = current + 1;
        counters.set(chatId, next);
        return next;
    }, []);

    const getNextStepIndex = useCallback((entryId) => {
        const counters = stepCountersRef.current;
        const current = counters.get(entryId) || 0;
        const next = current + 1;
        counters.set(entryId, next);
        return next;
    }, []);

    const getOrAllocateEntryIndex = useCallback((chatId, entryId) => {
        // Pre-allocate an event index for an entry when we first see it
        // This ensures steps get the same event index as their parent entry
        const entryIndices = entryIndexRef.current;
        if (entryIndices.has(entryId)) {
            return entryIndices.get(entryId);
        }
        const idx = getNextEntryIndex(chatId);
        entryIndices.set(entryId, idx);
        return idx;
    }, [getNextEntryIndex]);

    useEffect(() => {
        if (!ingest || !active || !subscribeEvent) return;

        let isUnmounted = false;
        let unsubscribe = null;

        const runAsync = async () => {
            const [chatEntryStream, chatStepStream] = await Promise.all([
                ingest.startEventStream(CHAT_ENTRY_EVENT_STREAM),
                ingest.startEventStream(CHAT_STEP_EVENT_STREAM)
            ]);
            if (isUnmounted) return;

            const unsubscribeSteps = subscribeEvent(AI_CHAT_STEP_EVENT, ({ chatId, entryId, step }) => {
                const stepIndex = getNextStepIndex(entryId);
                // Pre-allocate event index for parent entry if we haven't seen it yet
                const entryIndex = getOrAllocateEntryIndex(chatId, entryId);
                const stepData = mapChatStep(chatId, entryId, step, entryIndex, stepIndex);
                chatStepStream.createInstantEvent(stepData);
            });

            const unsubscribeEntries = subscribeEvent(AI_CHAT_ENTRY_EVENT, ({ chatId, persisted, entry }) => {
                // Use pre-allocated event index if steps already claimed one, otherwise get next
                const entryIndex = getOrAllocateEntryIndex(chatId, entry.id);
                const eventData = mapChatEntry(chatId, persisted, entry, entryIndex);
                chatEntryStream.createInstantEvent(eventData);
            });

            unsubscribe = () => {
                unsubscribeSteps?.();
                unsubscribeEntries?.();
            };
        };

        runAsync();

        return () => {
            isUnmounted = true;
            unsubscribe?.();
        };
    }, [ingest, active, subscribeEvent, getNextStepIndex, getOrAllocateEntryIndex]);

    return <div className="chat-recorder" style={{ display: 'none' }}></div>;
}
