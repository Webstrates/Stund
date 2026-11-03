import React from 'react';
const { useEffect, useRef } = React;
import { useEditor } from 'tldraw';

import { useCookieState } from '#CoreHelpers .cookie-store';
import { useGlobalEvents } from '#CoreHelpers .global-events';
import { useSessionIngest } from '#SessionHistory .default';
import { cleanShapeData } from '#MeetingRecorder .recorder-helpers';



const START_SUFFIX = 'Start';
const END_SUFFIX = 'End';
const DEFAULT_DOCUMENT_NAME = 'Untitled Document';
const FULLSCREEN_DOCUMENT_EDITING_CHANGED_EVENT = 'stund-fullscreen-document-editing-changed';
const FULLSCREEN_DOCUMENT_EDITING_REQUEST_EVENT = 'stund-fullscreen-document-editing-request';

/**
 * Helper class for tracking changes with timeout-based duration events.
 * Automatically batches rapid changes into a single duration event that
 * ends after a period of inactivity.
 */
class DurationChangeTracker {
    constructor(stream, options = {}) {
        this.stream = stream;
        this.timeout = options.timeout ?? 1500;
        this.activeEvents = new Map();
    }

    track(key, startData, getEndData) {
        let active = this.activeEvents.get(key);

        if (active) {
            // Clear existing timeout, keep the duration event
            clearTimeout(active.timeoutId);
            // Update the event with current state
            active.durationEvent.update(getEndData());
        } else {
            // Create new duration event
            const durationEvent = this.stream.createDurationEvent(startData);
            active = { durationEvent, timeoutId: null, getEndData };
            this.activeEvents.set(key, active);
        }

        // Update getEndData in case it references new state
        active.getEndData = getEndData;

        // Set new timeout to end the duration event after inactivity
        active.timeoutId = setTimeout(() => {
            this.stop(key);
        }, this.timeout);
    }

    stop(key, endDataOverride = null) {
        const active = this.activeEvents.get(key);
        if (active) {
            clearTimeout(active.timeoutId);
            const endData = endDataOverride ?? active.getEndData();
            active.durationEvent.stop(endData);
            this.activeEvents.delete(key);
        }
    }

    stopAll(endDataOrFn) {
        for (const [key, active] of this.activeEvents) {
            clearTimeout(active.timeoutId);
            const endData = typeof endDataOrFn === 'function'
                ? endDataOrFn(key)
                : endDataOrFn;
            active.durationEvent.stop(endData);
        }
        this.activeEvents.clear();
    }

    cleanup(cleanupData = { reason: 'cleanup' }) {
        this.stopAll(cleanupData);
    }
}

export function Main() {
    const editor = useEditor();
    const ingest = useSessionIngest();
    const { subscribeEvent, triggerEvent } = useGlobalEvents();
    const [active] = useCookieState('interactionRecorderActive', true);

    const moveTrackerRef = useRef(null);
    const textTrackerRef = useRef(null);
    const documentTextTrackerRef = useRef(null);

    useEffect(() => {
        if (!editor || !ingest || !active || typeof subscribeEvent !== 'function' || typeof triggerEvent !== 'function') return;

        let isCancelled = false;
        let storeListener = null;
        let sessionListener = null;
        let unsubscribeFullscreenEditing = null;
        let stopTrackedDocumentEditing = null;

        const runAsync = async () => {
            const shapeCreatedStream = await ingest.startEventStream('application.interaction.shape.created');
            const shapeDeletedStream = await ingest.startEventStream('application.interaction.shape.deleted');
            const shapeMovedStream = await ingest.startEventStream('application.interaction.shape.moved');
            const shapeColorChangedStream = await ingest.startEventStream('application.interaction.shape.colorChanged');
            const shapeTextChangedStream = await ingest.startEventStream('application.interaction.shape.textChanged');
            const documentTextChangedStream = await ingest.startEventStream('application.interaction.document.textChanged');
            if (isCancelled) return;

            // Initialize trackers with their respective streams and timeouts
            const moveTracker = new DurationChangeTracker(shapeMovedStream, { timeout: 1500 });
            const textTracker = new DurationChangeTracker(shapeTextChangedStream, { timeout: 1500 });
            const documentTextTracker = new DurationChangeTracker(documentTextChangedStream, { timeout: 1500 });
            moveTrackerRef.current = moveTracker;
            textTrackerRef.current = textTracker;
            documentTextTrackerRef.current = documentTextTracker;

            let activeDocumentTarget = null;
            let fullscreenDocumentEditingState = { isEditing: false, shapeId: null };

            const stopCurrentDocumentEditTracking = (reason) => {
                if (activeDocumentTarget) {
                    const shapeId = activeDocumentTarget.shapeId;
                    const trackedEvent = documentTextTracker.activeEvents.get(shapeId);
                    if (trackedEvent) {
                        documentTextTracker.stop(shapeId, { ...trackedEvent.getEndData(), reason });
                    }
                }
                activeDocumentTarget = null;
            };
            stopTrackedDocumentEditing = stopCurrentDocumentEditTracking;

            const syncDocumentEditTracking = () => {
                const editingShapeId = editor.getEditingShapeId();
                const editingShape = editingShapeId ? editor.getShape(editingShapeId) : null;
                const fullscreenShape = fullscreenDocumentEditingState.isEditing
                    ? editor.getShape(fullscreenDocumentEditingState.shapeId)
                    : null;
                const target = editingShape?.type === 'Document'
                    ? { shapeId: editingShape.id, source: 'canvas' }
                    : fullscreenShape?.type === 'Document'
                        ? { shapeId: fullscreenShape.id, source: 'fullscreen' }
                        : null;

                if (target?.shapeId === activeDocumentTarget?.shapeId
                    && target?.source === activeDocumentTarget?.source) return;
                stopCurrentDocumentEditTracking(target ? 'edit-target-changed' : 'edit-mode-exit');
                activeDocumentTarget = target;
            };

            unsubscribeFullscreenEditing = subscribeEvent(FULLSCREEN_DOCUMENT_EDITING_CHANGED_EVENT, (state) => {
                fullscreenDocumentEditingState = {
                    isEditing: Boolean(state?.isEditing && state?.shapeId),
                    shapeId: state?.shapeId || null
                };
                syncDocumentEditTracking();
            });
            triggerEvent(FULLSCREEN_DOCUMENT_EDITING_REQUEST_EVENT, { source: 'interaction-recorder' });

            storeListener = editor.store.listen((change) => {

                // Handle added shapes
                for (const record of Object.values(change.changes.added)) {
                    if (record.typeName === 'shape') {
                        shapeCreatedStream.createInstantEvent({
                            shape: cleanShapeData(record)
                        });
                    }
                }

                // Handle removed shapes
                for (const record of Object.values(change.changes.removed)) {
                    if (record.typeName === 'shape') {

                        // Stop any active shape moved event
                        moveTracker.stop(record.id, {
                            reason: 'deleted',
                            ['x' + END_SUFFIX]: record.x,
                            ['y' + END_SUFFIX]: record.y
                        });

                        // Stop any active text editing duration event
                        textTracker.stop(record.id, {
                            reason: 'deleted',
                            ['richText' + END_SUFFIX]: record.props?.richText
                        });

                        if (record.type === 'Document') {
                            documentTextTracker.stop(record.id, {
                                documentName: record.props?.name || DEFAULT_DOCUMENT_NAME,
                                textEnd: record.props?.text ?? '',
                                reason: 'deleted'
                            });
                            if (activeDocumentTarget?.shapeId === record.id) activeDocumentTarget = null;
                        }

                        shapeDeletedStream.createInstantEvent({
                            shape: cleanShapeData(record)
                        });
                    }
                }

                // Handle updated shapes
                for (const [from, to] of Object.values(change.changes.updated)) {
                    if (from.typeName === 'shape' && to.typeName === 'shape') {

                        if (to.type === 'Document' && from.props?.text !== to.props?.text) {
                            documentTextTracker.track(to.id, {
                                shapeId: to.id,
                                documentName: to.props?.name || DEFAULT_DOCUMENT_NAME,
                                editSource: activeDocumentTarget?.shapeId === to.id
                                    ? activeDocumentTarget.source
                                    : 'canvas',
                                textStart: from.props?.text ?? ''
                            }, () => {
                                const currentShape = editor.getShape(to.id);
                                return {
                                    documentName: currentShape?.props?.name || to.props?.name || DEFAULT_DOCUMENT_NAME,
                                    textEnd: currentShape?.props?.text ?? to.props?.text ?? ''
                                };
                            });
                        }

                        if (from.props?.color !== to.props?.color) {
                            shapeColorChangedStream.createInstantEvent({
                                shapeId: to.id,
                                shapeType: to.type,
                                ['color' + START_SUFFIX]: from.props?.color,
                                ['color' + END_SUFFIX]: to.props?.color
                            });
                        }

                        if (from.x !== to.x || from.y !== to.y) {
                            moveTracker.track(
                                to.id,
                                {
                                    shapeId: to.id,
                                    shapeType: to.type,
                                    ['x' + START_SUFFIX]: from.x,
                                    ['y' + START_SUFFIX]: from.y
                                },
                                () => {
                                    const shape = editor.getShape(to.id);
                                    return {
                                        ['x' + END_SUFFIX]: shape?.x ?? to.x,
                                        ['y' + END_SUFFIX]: shape?.y ?? to.y
                                    };
                                }
                            );
                        }

                        if (JSON.stringify(from.props?.richText) !== JSON.stringify(to.props?.richText)) {
                            textTracker.track(
                                to.id,
                                {
                                    shapeId: to.id,
                                    shapeType: to.type,
                                    ['richText' + START_SUFFIX]: from.props?.richText
                                },
                                () => {
                                    const shape = editor.getShape(to.id);
                                    return {
                                        ['richText' + END_SUFFIX]: shape?.props?.richText ?? to.props?.richText
                                    };
                                }
                            );
                        }
                    }
                }

                syncDocumentEditTracking();
            }, { source: 'user', scope: 'document' });

            sessionListener = editor.store.listen(() => {
                syncDocumentEditTracking();
            }, { source: 'user', scope: 'session' });

            syncDocumentEditTracking();
        };

        runAsync();

        return () => {
            isCancelled = true;
            stopTrackedDocumentEditing?.('cleanup');

            // Cleanup trackers
            moveTrackerRef.current?.cleanup();
            textTrackerRef.current?.cleanup();
            documentTextTrackerRef.current?.activeEvents.forEach((event, shapeId) => {
                documentTextTrackerRef.current.stop(shapeId, { ...event.getEndData(), reason: 'cleanup' });
            });
            moveTrackerRef.current = null;
            textTrackerRef.current = null;
            documentTextTrackerRef.current = null;

            // Cleanup listeners
            storeListener?.();
            sessionListener?.();
            unsubscribeFullscreenEditing?.();
        };
    }, [editor, ingest, active, subscribeEvent, triggerEvent]);

    return <div className="interaction-recorder" style={{ display: 'none' }}></div>;
}
