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

            // Initialize trackers with their respective streams and timeouts
            const moveTracker = new DurationChangeTracker(shapeMovedStream, { timeout: 1500 });
            const textTracker = new DurationChangeTracker(shapeTextChangedStream, { timeout: 1500 });
            const documentTextTracker = new DurationChangeTracker(documentTextChangedStream, { timeout: 1500 });
            moveTrackerRef.current = moveTracker;
            textTrackerRef.current = textTracker;
            documentTextTrackerRef.current = documentTextTracker;

            let activeDocumentShapeId = null;
            let activeDocumentFragmentId = null;
            let activeDocumentEditSource = null;
            let activeDocumentFragment = null;
            let activeDocumentFragmentChangedHandler = null;
            let activeDocumentText = '';
            let activeDocumentName = '';
            let fullscreenDocumentEditingState = { isEditing: false, shapeId: null, fragmentId: null };

            const unbindDocumentFragmentChangeListener = () => {
                if (!activeDocumentFragment || !activeDocumentFragmentChangedHandler) {
                    return;
                }

                try {
                    activeDocumentFragment.unRegisterOnFragmentChangedHandler(activeDocumentFragmentChangedHandler);
                } catch (error) {
                }

                activeDocumentFragment = null;
                activeDocumentFragmentChangedHandler = null;
            };

            const getDocumentNameFromFragment = (fragment) => {
                return typeof fragment?.element?.getAttribute === 'function'
                    ? (fragment.element.getAttribute('name') || '').trim()
                    : '';
            };

            const stopCurrentDocumentEditTracking = (reason) => {
                if (activeDocumentShapeId && activeDocumentFragmentId) {
                    let liveFragment = null;
                    try {
                        liveFragment = Fragment.one('#' + activeDocumentFragmentId);
                    } catch (error) {
                    }
                    const fragmentDocumentName = getDocumentNameFromFragment(liveFragment ?? activeDocumentFragment);
                    const documentName = fragmentDocumentName || activeDocumentName || DEFAULT_DOCUMENT_NAME;

                    documentTextTracker.stop(activeDocumentShapeId, {
                        reason,
                        editSource: activeDocumentEditSource,
                        shapeId: activeDocumentShapeId,
                        documentFragmentId: activeDocumentFragmentId,
                        documentName,
                        ['text' + END_SUFFIX]: (liveFragment ?? activeDocumentFragment)?.raw ?? ''
                    });
                }

                unbindDocumentFragmentChangeListener();
                activeDocumentShapeId = null;
                activeDocumentFragmentId = null;
                activeDocumentEditSource = null;
                activeDocumentText = '';
                activeDocumentName = '';
            };
            stopTrackedDocumentEditing = stopCurrentDocumentEditTracking;

            const getCanvasDocumentEditTarget = () => {
                const editingShapeId = editor.getEditingShapeId();
                if (!editingShapeId) {
                    return null;
                }

                const editingShape = editor.getShape(editingShapeId);
                if (!editingShape || editingShape.type !== 'Document') {
                    return null;
                }

                const fragmentId = editingShape.props?.sourceFragmentId || '';
                if (!fragmentId) {
                    return null;
                }

                return {
                    shapeId: editingShapeId,
                    fragmentId,
                    source: 'canvas'
                };
            };

            const getFullscreenDocumentEditTarget = () => {
                if (!fullscreenDocumentEditingState.isEditing) {
                    return null;
                }

                const shapeId = fullscreenDocumentEditingState.shapeId || '';
                const fragmentId = fullscreenDocumentEditingState.fragmentId || '';
                if (!shapeId || !fragmentId) {
                    return null;
                }

                const shape = editor.getShape(shapeId);
                if (!shape || shape.type !== 'Document') {
                    return null;
                }

                const shapeFragmentId = shape.props?.sourceFragmentId || '';
                if (shapeFragmentId && shapeFragmentId !== fragmentId) {
                    return null;
                }

                return {
                    shapeId,
                    fragmentId: shapeFragmentId || fragmentId,
                    source: 'fullscreen'
                };
            };

            const getActiveDocumentEditTarget = () => {
                return getCanvasDocumentEditTarget() || getFullscreenDocumentEditTarget();
            };

            const isActiveDocumentEditTargetStillValid = () => {
                if (!activeDocumentShapeId || !activeDocumentFragmentId || !activeDocumentEditSource) {
                    return false;
                }

                const currentShape = editor.getShape(activeDocumentShapeId);
                if (!currentShape || currentShape.type !== 'Document') {
                    return false;
                }

                const currentFragmentId = currentShape.props?.sourceFragmentId || '';
                if (currentFragmentId && currentFragmentId !== activeDocumentFragmentId) {
                    return false;
                }

                if (activeDocumentEditSource === 'canvas') {
                    return editor.getEditingShapeId() === activeDocumentShapeId;
                }

                if (activeDocumentEditSource === 'fullscreen') {
                    const shapeId = fullscreenDocumentEditingState.shapeId || '';
                    const fragmentId = fullscreenDocumentEditingState.fragmentId || '';
                    return Boolean(
                        fullscreenDocumentEditingState.isEditing
                        && shapeId === activeDocumentShapeId
                        && fragmentId === activeDocumentFragmentId
                    );
                }

                return false;
            };

            const syncDocumentEditTracking = () => {
                const target = getActiveDocumentEditTarget();
                if (!target) {
                    stopCurrentDocumentEditTracking('edit-mode-exit');
                    return;
                }

                let fragment = null;
                try {
                    fragment = Fragment.one('#' + target.fragmentId);
                } catch (error) {
                }
                const hasFragmentListenerApi = fragment
                    && typeof fragment.registerOnFragmentChangedHandler === 'function'
                    && typeof fragment.unRegisterOnFragmentChangedHandler === 'function';
                if (!hasFragmentListenerApi) {
                    stopCurrentDocumentEditTracking('missing-fragment');
                    return;
                }

                if (
                    activeDocumentShapeId === target.shapeId
                    && activeDocumentFragmentId === target.fragmentId
                    && activeDocumentEditSource === target.source
                ) {
                    return;
                }

                stopCurrentDocumentEditTracking('edit-target-changed');
                activeDocumentShapeId = target.shapeId;
                activeDocumentFragmentId = target.fragmentId;
                activeDocumentEditSource = target.source;
                activeDocumentFragment = fragment;
                activeDocumentText = fragment.raw;
                const fragmentDocumentName = getDocumentNameFromFragment(fragment);
                activeDocumentName = fragmentDocumentName || DEFAULT_DOCUMENT_NAME;

                activeDocumentFragmentChangedHandler = () => {
                    if (!isActiveDocumentEditTargetStillValid()) {
                        stopCurrentDocumentEditTracking('edit-mode-exit');
                        return;
                    }

                    const currentShape = editor.getShape(activeDocumentShapeId);
                    if (!currentShape || currentShape.type !== 'Document') {
                        stopCurrentDocumentEditTracking('edit-mode-exit');
                        return;
                    }

                    const currentText = activeDocumentFragment.raw;
                    if (currentText === activeDocumentText) {
                        return;
                    }

                    const previousText = activeDocumentText;
                    activeDocumentText = currentText;
                    const fragmentDocumentName = getDocumentNameFromFragment(activeDocumentFragment);
                    const documentName = fragmentDocumentName || activeDocumentName || DEFAULT_DOCUMENT_NAME;
                    activeDocumentName = documentName;

                    documentTextTracker.track(
                        activeDocumentShapeId,
                        {
                            shapeId: activeDocumentShapeId,
                            editSource: activeDocumentEditSource,
                            documentFragmentId: activeDocumentFragmentId,
                            documentName,
                            ['text' + START_SUFFIX]: previousText
                        },
                        () => {
                            let liveFragment = null;
                            try {
                                liveFragment = Fragment.one('#' + activeDocumentFragmentId);
                            } catch (error) {
                            }
                            const liveFragmentDocumentName = getDocumentNameFromFragment(liveFragment ?? activeDocumentFragment);
                            return {
                                documentName: liveFragmentDocumentName || activeDocumentName || DEFAULT_DOCUMENT_NAME,
                                ['text' + END_SUFFIX]: (liveFragment ?? activeDocumentFragment)?.raw ?? ''
                            };
                        }
                    );
                };

                try {
                    fragment.registerOnFragmentChangedHandler(activeDocumentFragmentChangedHandler);
                } catch (error) {
                    stopCurrentDocumentEditTracking('fragment-listener-error');
                }
            };

            unsubscribeFullscreenEditing = subscribeEvent(FULLSCREEN_DOCUMENT_EDITING_CHANGED_EVENT, (state) => {
                const shapeId = state?.shapeId || null;
                const fragmentId = state?.fragmentId || null;

                fullscreenDocumentEditingState = {
                    isEditing: Boolean(state?.isEditing && shapeId && fragmentId),
                    shapeId,
                    fragmentId
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

                        if (record.id === activeDocumentShapeId) {
                            stopCurrentDocumentEditTracking('deleted');
                        }

                        shapeDeletedStream.createInstantEvent({
                            shape: cleanShapeData(record)
                        });
                    }
                }

                // Handle updated shapes
                for (const [from, to] of Object.values(change.changes.updated)) {
                    if (from.typeName === 'shape' && to.typeName === 'shape') {

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
            stopTrackedDocumentEditing?.('cleanup');

            // Cleanup trackers
            moveTrackerRef.current?.cleanup();
            textTrackerRef.current?.cleanup();
            documentTextTrackerRef.current?.cleanup();
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
