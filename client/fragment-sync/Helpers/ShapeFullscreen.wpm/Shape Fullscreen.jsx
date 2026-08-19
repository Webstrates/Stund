import React from 'react';
const { useState, useEffect, useCallback, useRef } = React;
import { createPortal } from 'react-dom';
import { ErrorBoundary } from 'react-error-boundary';

import { useCookieState } from '#CoreHelpers .cookie-store';
import { useGlobalEvents } from '#CoreHelpers .global-events';
import { ReactPreviewEditor } from '#Document .react-preview-editor';



const FULLSCREEN_SHAPE_STATE_KEY = 'fullscreen-shape-id';
const SUPPORTED_FULLSCREEN_SHAPE_TYPES = ['Widget', 'Document'];
const RELOAD_DEBOUNCE_MS = 1000;
const EDITOR_POLL_INTERVAL_MS = 700;
const DOCUMENT_DEPENDENCY_POLL_INTERVAL_MS = 300;
const FULLSCREEN_DOCUMENT_EDITING_CHANGED_EVENT = 'stund-fullscreen-document-editing-changed';
const FULLSCREEN_DOCUMENT_EDITING_REQUEST_EVENT = 'stund-fullscreen-document-editing-request';
const DEFAULT_DOCUMENT_FONT_SIZE = 14;
const MIN_DOCUMENT_FONT_SIZE = 8;
const MAX_DOCUMENT_FONT_SIZE = 72;
const DOCUMENT_FONT_SIZE_STEP = 2;
const MONACO_SELECTION_EVENT_TYPES = new Set([
    'pointermove',
    'pointerup',
    'pointercancel',
    'touchmove',
    'touchend',
    'touchcancel',
    'mousemove',
    'mouseup'
]);

const isSupportedFullscreenShapeType = (shapeType) => {
    return SUPPORTED_FULLSCREEN_SHAPE_TYPES.includes(shapeType);
};

const getEditorRootNode = (editorInstance) => {
    if (!editorInstance?.html || typeof Node === 'undefined') {
        return null;
    }

    if (editorInstance.html[0] instanceof Node) {
        return editorInstance.html[0];
    }

    if (editorInstance.html instanceof Node) {
        return editorInstance.html;
    }

    return null;
};

const getFragmentById = (fragmentId) => {
    if (!fragmentId || typeof Fragment === 'undefined' || typeof Fragment.one !== 'function') {
        return null;
    }

    try {
        return Fragment.one('#' + fragmentId);
    } catch (error) {
        return null;
    }
};

const getShapeTypeLabel = (shapeType) => {
    if (shapeType === 'Document') {
        return 'Document';
    }

    return 'Widget';
};

const getWidgetDisplayName = (shape, index = 0) => {
    const providedName = typeof shape?.props?.name === 'string' ? shape.props.name.trim() : '';
    if (providedName) {
        return providedName;
    }

    return `Widget ${index + 1}`;
};

const getDocumentDisplayName = (shape, index = 0) => {
    const sourceFragmentId = typeof shape?.props?.sourceFragmentId === 'string' ? shape.props.sourceFragmentId.trim() : '';
    if (sourceFragmentId) {
        const fragmentName = getFragmentById(sourceFragmentId)?.element?.getAttribute('name');
        if (typeof fragmentName === 'string' && fragmentName.trim()) {
            return fragmentName.trim();
        }
    }

    return `Document ${index + 1}`;
};

const createFullscreenShapeOption = (shape, indexByType = { widget: 0, document: 0 }) => {
    if (!shape || !isSupportedFullscreenShapeType(shape.type)) {
        return null;
    }

    if (shape.type === 'Document') {
        return {
            id: shape.id,
            type: shape.type,
            name: getDocumentDisplayName(shape, indexByType.document)
        };
    }

    return {
        id: shape.id,
        type: shape.type,
        name: getWidgetDisplayName(shape, indexByType.widget)
    };
};

const getFullscreenShapeOptionsFromEditor = (editor) => {
    if (!editor || typeof editor.getCurrentPageShapes !== 'function') {
        return [];
    }

    const shapes = editor.getCurrentPageShapes() || [];
    let widgetCount = 0;
    let documentCount = 0;

    const options = [];
    shapes.forEach((shape) => {
        if (!isSupportedFullscreenShapeType(shape?.type)) {
            return;
        }

        const option = createFullscreenShapeOption(shape, {
            widget: widgetCount,
            document: documentCount
        });
        if (!option) {
            return;
        }

        if (shape.type === 'Document') {
            documentCount += 1;
        } else {
            widgetCount += 1;
        }

        options.push(option);
    });

    return options.sort((left, right) => {
        const leftTypeLabel = getShapeTypeLabel(left.type);
        const rightTypeLabel = getShapeTypeLabel(right.type);
        const typeCompare = leftTypeLabel.localeCompare(rightTypeLabel, undefined, { sensitivity: 'base' });
        if (typeCompare !== 0) {
            return typeCompare;
        }

        return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
    });
};

const areFullscreenShapeOptionListsEqual = (left, right) => {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
        return false;
    }

    for (let i = 0; i < left.length; i++) {
        if (
            left[i].id !== right[i].id ||
            left[i].name !== right[i].name ||
            left[i].type !== right[i].type
        ) {
            return false;
        }
    }

    return true;
};

const getFullscreenShapeOptionLabel = (shapeOption) => {
    const typeLabel = getShapeTypeLabel(shapeOption?.type);
    return `[${typeLabel}] ${shapeOption?.name || 'Untitled'}`;
};

function FullscreenError({ error, errorType = 'Runtime', onRetry }) {
    return <div className="widget-fullscreen-error">
        <p className="widget-fullscreen-error-title">
            <span className="icon material-icons">error</span>
            <span>{errorType} Error</span>
        </p>
        <pre className="widget-fullscreen-error-message">{error.message}</pre>
        <button className="dialog-action-button widget-fullscreen-error-button" onClick={onRetry}>
            <span className="icon material-icons">refresh</span>
            <span>Retry</span>
        </button>
    </div>;
}

function ErrorFallback({ error, resetErrorBoundary }) {
    return <FullscreenError error={error} errorType="Runtime" onRetry={resetErrorBoundary} />;
}

function FullscreenWidgetContent({ shape }) {
    const [loadedWidgetComponent, setLoadedWidgetComponent] = useState(null);
    const [reloadKey, setReloadKey] = useState(0);
    const [loadError, setLoadError] = useState(null);

    const sourceFragmentId = shape?.props?.sourceFragmentId || null;

    const reloadWidgetContent = useCallback(async () => {
        if (!sourceFragmentId) {
            setLoadedWidgetComponent(null);
            setLoadError(new Error('Widget source fragment is missing'));
            return;
        }

        try {
            setLoadError(null);

            const fragment = Fragment.one('#' + sourceFragmentId);

            if (!fragment) {
                console.warn('Widget fragment not found:', sourceFragmentId);
                setLoadError(new Error(`Fragment not found: ${sourceFragmentId}`));
                return;
            }

            const { Widget } = await fragment.require();

            if (!Widget) {
                console.warn('Widget component not found in fragment:', sourceFragmentId);
                setLoadError(new Error('Widget component not exported from fragment'));
                return;
            }

            setLoadedWidgetComponent(() => Widget);
            setReloadKey((prev) => prev + 1);
        } catch (error) {
            console.error('Error loading widget for fullscreen:', error);
            setLoadError(error);
            setLoadedWidgetComponent(null);
        }
    }, [sourceFragmentId]);

    useEffect(() => {
        if (!sourceFragmentId) {
            setLoadedWidgetComponent(null);
            setLoadError(new Error('Widget source fragment is missing'));
            return;
        }

        const fragment = Fragment.one('#' + sourceFragmentId);
        if (!fragment) {
            reloadWidgetContent();
            return;
        }

        reloadWidgetContent();

        let debounceTimer = null;
        const handleFragmentChanged = () => {
            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }
            debounceTimer = setTimeout(() => {
                reloadWidgetContent();
            }, RELOAD_DEBOUNCE_MS);
        };

        fragment.registerOnFragmentChangedHandler(handleFragmentChanged);

        return () => {
            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }
            fragment.unRegisterOnFragmentChangedHandler(handleFragmentChanged);
        };
    }, [sourceFragmentId, reloadWidgetContent]);

    if (!shape) {
        return <div className="widget-fullscreen-empty">No fullscreen widget selected.</div>;
    }

    return <ErrorBoundary
        key={reloadKey}
        FallbackComponent={ErrorFallback}
        onReset={reloadWidgetContent}
    >
        {loadedWidgetComponent ? React.createElement(loadedWidgetComponent, { shape }) : null}
        {loadError ? <FullscreenError error={loadError} errorType="Load" onRetry={reloadWidgetContent} /> : null}
    </ErrorBoundary>;
}

function FullscreenDocumentContent({ shape, isEditing }) {
    const [loadError, setLoadError] = useState(null);
    const [reloadKey, setReloadKey] = useState(0);
    const editorContainerRef = useRef(null);
    const editorInstanceRef = useRef(null);

    const sourceFragmentId = shape?.props?.sourceFragmentId || null;
    const fontSize = shape?.props?.fontSize || 14;

    const unloadDocumentEditor = useCallback(() => {
        const activeEditor = editorInstanceRef.current;
        editorInstanceRef.current = null;

        if (activeEditor && typeof activeEditor.unload === 'function') {
            try {
                activeEditor.unload();
            } catch (error) {
                console.warn('Error unloading fullscreen document editor:', error);
            }
        }
    }, []);

    const reloadDocumentContent = useCallback(() => {
        setReloadKey((previous) => previous + 1);
    }, []);

    useEffect(() => {
        if (!isEditing) {
            setLoadError(null);
            return;
        }

        const container = editorContainerRef.current;
        if (!container) {
            return;
        }

        let pollHandle = null;

        const resetContainer = () => {
            unloadDocumentEditor();
            container.replaceChildren();
        };

        const tryMountDocument = () => {
            if (!sourceFragmentId) {
                setLoadError(new Error('Document source fragment is missing'));
                resetContainer();
                return true;
            }

            const fragment = getFragmentById(sourceFragmentId);
            if (!fragment) {
                setLoadError(new Error(`Fragment not found: ${sourceFragmentId}`));
                resetContainer();
                return true;
            }

            if (!window.EditorManager?.createEditor) {
                return false;
            }

            try {
                resetContainer();
                const editors = window.EditorManager.createEditor(fragment, { theme: 'light', mode: 'full' });
                const editorInstance = Array.isArray(editors) ? editors[0] : editors;
                const editorNode = getEditorRootNode(editorInstance);

                if (!editorInstance || !editorNode) {
                    setLoadError(new Error('Unable to create document preview editor'));
                    resetContainer();
                    return true;
                }

                editorInstanceRef.current = editorInstance;
                container.replaceChildren(editorNode);
                setLoadError(null);

                if (typeof editorInstance.focus === 'function') {
                    requestAnimationFrame(() => {
                        try {
                            editorInstance.focus();
                        } catch (focusError) {
                        }
                    });
                }

                return true;
            } catch (error) {
                console.error('Error loading document for fullscreen:', error);
                setLoadError(error);
                resetContainer();
                return true;
            }
        };

        const mounted = tryMountDocument();
        if (!mounted) {
            pollHandle = window.setInterval(() => {
                const mountedInPoll = tryMountDocument();
                if (mountedInPoll && pollHandle) {
                    window.clearInterval(pollHandle);
                    pollHandle = null;
                }
            }, DOCUMENT_DEPENDENCY_POLL_INTERVAL_MS);
        }

        return () => {
            if (pollHandle) {
                window.clearInterval(pollHandle);
            }
            resetContainer();
        };
    }, [sourceFragmentId, reloadKey, unloadDocumentEditor, isEditing]);

    if (!shape) {
        return <div className="widget-fullscreen-empty">No fullscreen document selected.</div>;
    }

    return <div className="shape-fullscreen-document">
        <div
            key={isEditing ? 'fullscreen-document-editor-mode' : 'fullscreen-document-preview-mode'}
            ref={editorContainerRef}
            className="shape-fullscreen-document-editor"
            style={{ '--document-shape-font-size': `${fontSize}px`, touchAction: 'auto' }}
        >
            {!isEditing ? <ReactPreviewEditor fragmentId={sourceFragmentId} /> : null}
        </div>
        {isEditing && loadError ? <FullscreenError error={loadError} errorType="Load" onRetry={reloadDocumentContent} /> : null}
    </div>;
}

function FullscreenShapeContent({ shape, isDocumentEditing }) {
    if (!shape) {
        return <div className="widget-fullscreen-empty">No fullscreen shape selected.</div>;
    }

    if (shape.type === 'Widget') {
        return <FullscreenWidgetContent shape={shape} />;
    }

    if (shape.type === 'Document') {
        return <FullscreenDocumentContent shape={shape} isEditing={isDocumentEditing} />;
    }

    return <div className="widget-fullscreen-empty">Unsupported fullscreen shape type.</div>;
}

export function Main() {
    const [fullscreenShapeId, setFullscreenShapeId] = useCookieState(FULLSCREEN_SHAPE_STATE_KEY, null);
    const { triggerEvent, subscribeEvent } = useGlobalEvents();
    const [fullscreenShape, setFullscreenShape] = useState(null);
    const [fullscreenShapeOptions, setFullscreenShapeOptions] = useState([]);
    const [isFullscreenDocumentEditing, setIsFullscreenDocumentEditing] = useState(false);
    const fullscreenOverlayRef = useRef(null);
    const fullscreenContentRef = useRef(null);
    const fullscreenDocumentEditingStateRef = useRef(null);
    const wasFullscreenRef = useRef(false);
    const connectedEditorRef = useRef(null);
    const storeListenerCleanupRef = useRef(null);

    const detachStoreListener = useCallback(() => {
        if (typeof storeListenerCleanupRef.current === 'function') {
            storeListenerCleanupRef.current();
        }
        storeListenerCleanupRef.current = null;
        connectedEditorRef.current = null;
    }, []);

    const syncFromCanvas = useCallback(() => {
        const editor = window.tldrawEditor;
        if (!editor) {
            setFullscreenShapeOptions([]);
            setFullscreenShape(null);
            return;
        }

        const nextShapeOptions = getFullscreenShapeOptionsFromEditor(editor);
        setFullscreenShapeOptions((previousShapeOptions) => {
            return areFullscreenShapeOptionListsEqual(previousShapeOptions, nextShapeOptions)
                ? previousShapeOptions
                : nextShapeOptions;
        });

        if (!fullscreenShapeId) {
            setFullscreenShape(null);
            return;
        }

        const nextShape = editor.getShape(fullscreenShapeId);
        if (!nextShape || !isSupportedFullscreenShapeType(nextShape.type)) {
            setFullscreenShape(null);
            setFullscreenShapeId(null);
            return;
        }

        setFullscreenShape(nextShape);
    }, [fullscreenShapeId, setFullscreenShapeId]);

    const attachStoreListener = useCallback((editor) => {
        if (!editor || !editor.store || typeof editor.store.listen !== 'function') {
            return;
        }

        if (connectedEditorRef.current === editor && typeof storeListenerCleanupRef.current === 'function') {
            return;
        }

        detachStoreListener();
        connectedEditorRef.current = editor;
        storeListenerCleanupRef.current = editor.store.listen(() => {
            syncFromCanvas();
        });
    }, [detachStoreListener, syncFromCanvas]);

    useEffect(() => {
        if (!fullscreenShapeId) {
            setFullscreenShape(null);
            setFullscreenShapeOptions([]);
            detachStoreListener();
            return;
        }

        const syncFromEditor = () => {
            const editor = window.tldrawEditor;
            if (!editor) {
                return;
            }

            attachStoreListener(editor);
            syncFromCanvas();
        };

        syncFromEditor();
        const pollHandle = window.setInterval(syncFromEditor, EDITOR_POLL_INTERVAL_MS);

        return () => {
            window.clearInterval(pollHandle);
            detachStoreListener();
        };
    }, [fullscreenShapeId, attachStoreListener, detachStoreListener, syncFromCanvas]);

    const closeFullscreen = useCallback(() => {
        setFullscreenShapeId(null);
    }, [setFullscreenShapeId]);

    const isFullscreenDocument = fullscreenShape?.type === 'Document';
    const fullscreenDocumentFragmentId = isFullscreenDocument && typeof fullscreenShape?.props?.sourceFragmentId === 'string'
        ? fullscreenShape.props.sourceFragmentId.trim()
        : '';
    const fullscreenDocumentEditingState = {
        isEditing: Boolean(
            fullscreenShapeId
            && isFullscreenDocument
            && isFullscreenDocumentEditing
            && fullscreenShape?.id
            && fullscreenDocumentFragmentId
        ),
        shapeId: fullscreenShape?.id || null,
        fragmentId: fullscreenDocumentFragmentId || null
    };
    fullscreenDocumentEditingStateRef.current = fullscreenDocumentEditingState;
    const fullscreenDocumentFontSize = isFullscreenDocument
        ? (fullscreenShape?.props?.fontSize ?? DEFAULT_DOCUMENT_FONT_SIZE)
        : DEFAULT_DOCUMENT_FONT_SIZE;

    const adjustFullscreenDocumentFontSize = useCallback((delta) => {
        if (!fullscreenShape || fullscreenShape.type !== 'Document') {
            return;
        }

        const editor = window.tldrawEditor;
        if (!editor || typeof editor.updateShape !== 'function') {
            return;
        }

        const currentFontSize = fullscreenShape.props?.fontSize ?? DEFAULT_DOCUMENT_FONT_SIZE;
        const nextFontSize = Math.max(MIN_DOCUMENT_FONT_SIZE, Math.min(MAX_DOCUMENT_FONT_SIZE, currentFontSize + delta));
        if (nextFontSize === currentFontSize) {
            return;
        }

        editor.updateShape({
            id: fullscreenShape.id,
            type: 'Document',
            props: {
                fontSize: nextFontSize
            }
        });
    }, [fullscreenShape]);

    const toggleFullscreenDocumentEditor = useCallback(() => {
        if (!fullscreenShape || fullscreenShape.type !== 'Document') {
            return;
        }

        const sourceFragmentId = typeof fullscreenShape.props?.sourceFragmentId === 'string'
            ? fullscreenShape.props.sourceFragmentId.trim()
            : '';
        if (!sourceFragmentId) {
            return;
        }

        setIsFullscreenDocumentEditing((previous) => !previous);
    }, [fullscreenShape]);

    const handleFullscreenShapeChange = useCallback((event) => {
        const selectedShapeId = event?.target?.value;
        if (typeof selectedShapeId !== 'string' || !selectedShapeId.trim()) {
            return;
        }

        setFullscreenShapeId(selectedShapeId);
    }, [setFullscreenShapeId]);

    const stopFullscreenEventPropagation = useCallback((event) => {
        if (isFullscreenDocumentEditing && MONACO_SELECTION_EVENT_TYPES.has(event.type)) {
            return;
        }

        event.stopPropagation();
    }, [isFullscreenDocumentEditing]);

    const handleFullscreenKeyDownCapture = useCallback((event) => {
        if (event.key !== 'Escape') return;

        event.preventDefault();
        event.stopPropagation();
        closeFullscreen();
    }, [closeFullscreen]);

    useEffect(() => {
        if (!fullscreenShapeId) {
            return;
        }

        const editor = window.tldrawEditor;
        if (editor && typeof editor.blur === 'function') {
            editor.blur();
        }

        const focusHandle = requestAnimationFrame(() => {
            fullscreenOverlayRef.current?.focus();
        });

        const handleGlobalKeyDown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closeFullscreen();
            }
        };

        document.addEventListener('keydown', handleGlobalKeyDown, true);

        return () => {
            cancelAnimationFrame(focusHandle);
            document.removeEventListener('keydown', handleGlobalKeyDown, true);
        };
    }, [fullscreenShapeId, closeFullscreen]);

    useEffect(() => {
        if (fullscreenShapeId) {
            wasFullscreenRef.current = true;
            return;
        }

        if (!wasFullscreenRef.current) {
            return;
        }

        wasFullscreenRef.current = false;

        const focusHandle = requestAnimationFrame(() => {
            const editor = window.tldrawEditor;
            if (!editor) {
                return;
            }

            if (typeof editor.focus === 'function') {
                editor.focus();
                return;
            }

            if (typeof editor.getContainer === 'function') {
                const editorContainer = editor.getContainer();
                if (editorContainer && typeof editorContainer.focus === 'function') {
                    editorContainer.focus();
                }
            }
        });

        return () => {
            cancelAnimationFrame(focusHandle);
        };
    }, [fullscreenShapeId]);

    useEffect(() => {
        if (!fullscreenShapeId) return;

        const container = fullscreenContentRef.current;
        if (!container) return;

        const stopPropagation = (event) => {
            if (isFullscreenDocumentEditing && MONACO_SELECTION_EVENT_TYPES.has(event.type)) {
                return;
            }

            event.stopPropagation();
        };

        const eventTypes = [
            'pointerdown',
            'pointermove',
            'pointerup',
            'pointercancel',
            'touchstart',
            'touchmove',
            'touchend',
            'touchcancel',
            'mousedown',
            'mousemove',
            'mouseup',
            'wheel'
        ];
        const useCapture = !isFullscreenDocumentEditing;

        eventTypes.forEach((type) => {
            container.addEventListener(type, stopPropagation, { capture: useCapture });
        });

        return () => {
            eventTypes.forEach((type) => {
                container.removeEventListener(type, stopPropagation, { capture: useCapture });
            });
        };
    }, [fullscreenShapeId, isFullscreenDocumentEditing]);

    useEffect(() => {
        if (!isFullscreenDocument) {
            setIsFullscreenDocumentEditing(false);
            return;
        }

        const sourceFragmentId = typeof fullscreenShape?.props?.sourceFragmentId === 'string'
            ? fullscreenShape.props.sourceFragmentId.trim()
            : '';
        if (!sourceFragmentId) {
            setIsFullscreenDocumentEditing(false);
        }
    }, [fullscreenShape?.id, fullscreenShape?.props?.sourceFragmentId, isFullscreenDocument]);

    useEffect(() => {
        if (typeof triggerEvent !== 'function') {
            return;
        }

        triggerEvent(FULLSCREEN_DOCUMENT_EDITING_CHANGED_EVENT, fullscreenDocumentEditingState);
    }, [
        triggerEvent,
        fullscreenDocumentEditingState.isEditing,
        fullscreenDocumentEditingState.shapeId,
        fullscreenDocumentEditingState.fragmentId
    ]);

    useEffect(() => {
        if (typeof subscribeEvent !== 'function') {
            return () => { };
        }

        const unsubscribe = subscribeEvent(FULLSCREEN_DOCUMENT_EDITING_REQUEST_EVENT, () => {
            if (typeof triggerEvent !== 'function') {
                return;
            }

            triggerEvent(FULLSCREEN_DOCUMENT_EDITING_CHANGED_EVENT, fullscreenDocumentEditingStateRef.current);
        });

        return () => {
            unsubscribe();
        };
    }, [triggerEvent, subscribeEvent]);

    useEffect(() => {
        return () => {
            if (typeof triggerEvent !== 'function') {
                return;
            }

            triggerEvent(FULLSCREEN_DOCUMENT_EDITING_CHANGED_EVENT, { isEditing: false, shapeId: null, fragmentId: null });
        };
    }, [triggerEvent]);

    if (!fullscreenShapeId || !fullscreenShape) {
        return null;
    }

    const fallbackShapeOption = createFullscreenShapeOption(fullscreenShape);
    const fullscreenShapeOptionList = fullscreenShapeOptions.length > 0
        ? fullscreenShapeOptions
        : fallbackShapeOption
            ? [fallbackShapeOption]
            : [];

    const fullscreenOverlay = <div
        className="widget-fullscreen-overlay"
        ref={fullscreenOverlayRef}
        tabIndex={-1}
        onPointerDown={stopFullscreenEventPropagation}
        onPointerMove={stopFullscreenEventPropagation}
        onPointerUp={stopFullscreenEventPropagation}
        onMouseDown={stopFullscreenEventPropagation}
        onMouseMove={stopFullscreenEventPropagation}
        onMouseUp={stopFullscreenEventPropagation}
        onTouchStart={stopFullscreenEventPropagation}
        onTouchMove={stopFullscreenEventPropagation}
        onTouchEnd={stopFullscreenEventPropagation}
        onWheel={stopFullscreenEventPropagation}
        onClick={stopFullscreenEventPropagation}
        onDoubleClick={stopFullscreenEventPropagation}
        onContextMenu={stopFullscreenEventPropagation}
        onKeyDownCapture={handleFullscreenKeyDownCapture}
    >
        <div className="widget-fullscreen-header">
            <label className="widget-fullscreen-switcher">
                <span className="icon material-icons">swap_horiz</span>
                <select
                    value={fullscreenShape.id}
                    onChange={handleFullscreenShapeChange}
                    title="Switch Fullscreen Shape"
                >
                    {fullscreenShapeOptionList.map((shapeOption) => {
                        return <option key={shapeOption.id} value={shapeOption.id}>
                            {getFullscreenShapeOptionLabel(shapeOption)}
                        </option>;
                    })}
                </select>
            </label>
            <div className="widget-fullscreen-header-actions">
                {isFullscreenDocument ? <div className="widget-fullscreen-document-controls">
                    <button
                        className="widget-fullscreen-document-font-button"
                        onClick={() => adjustFullscreenDocumentFontSize(-DOCUMENT_FONT_SIZE_STEP)}
                        title="Decrease Font Size"
                    >
                        <span className="icon material-icons">text_decrease</span>
                    </button>
                    <span className="widget-fullscreen-document-font-label">{fullscreenDocumentFontSize}px</span>
                    <button
                        className="widget-fullscreen-document-font-button"
                        onClick={() => adjustFullscreenDocumentFontSize(DOCUMENT_FONT_SIZE_STEP)}
                        title="Increase Font Size"
                    >
                        <span className="icon material-icons">text_increase</span>
                    </button>
                    <button
                        className="dialog-action-button widget-fullscreen-header-button"
                        onClick={toggleFullscreenDocumentEditor}
                        title={isFullscreenDocumentEditing ? 'Switch To Preview' : 'Switch To Editor'}
                    >
                        <span className="icon material-icons">{isFullscreenDocumentEditing ? 'visibility' : 'edit'}</span>
                        <span>{isFullscreenDocumentEditing ? 'Switch To Preview' : 'Switch To Editor'}</span>
                    </button>
                </div> : null}
                <button className="dialog-action-button widget-fullscreen-header-button" onClick={closeFullscreen} title="Close Fullscreen">
                    <span className="icon material-icons">close_fullscreen</span>
                    <span>Close Fullscreen</span>
                </button>
            </div>
        </div>

        <div className="widget-fullscreen-content" ref={fullscreenContentRef} style={{ touchAction: 'auto' }}>
            <div className="widget-fullscreen-mount">
                <FullscreenShapeContent shape={fullscreenShape} isDocumentEditing={isFullscreenDocumentEditing} />
            </div>
        </div>
    </div>;

    const portalTarget = document.querySelector('#app-root') || document.body;
    if (!portalTarget) {
        return fullscreenOverlay;
    }

    return createPortal(fullscreenOverlay, portalTarget);
}
