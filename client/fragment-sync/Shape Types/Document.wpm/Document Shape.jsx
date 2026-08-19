import React from 'react';
const { useRef, useState, useCallback, useEffect } = React;
import { T, HTMLContainer, BaseBoxShapeUtil, useEditor, useValue, stopEventPropagation } from 'tldraw';

import { ReactPreviewEditor } from '#Document .react-preview-editor';
import { useCookieState } from '#CoreHelpers .cookie-store';

const DEFAULT_WIDTH = 320;
const DEFAULT_HEIGHT = 300;
const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 72;
const FONT_SIZE_STEP = 2;
const DOCUMENT_FRAGMENT_CONTAINER = '#document-fragments';
const FULLSCREEN_SHAPE_STATE_KEY = 'fullscreen-shape-id';
const EDITOR_DEPENDENCY_POLL_INTERVAL_MS = 300;
const EDITOR_NODE_POLL_INTERVAL_MS = 120;
const DEFAULT_DOCUMENT_NAME = 'Untitled Document';
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

function getEditorRootNode(editorInstance) {
    if (!editorInstance?.html) return null;
    if (editorInstance.html[0] instanceof Node) return editorInstance.html[0];
    if (editorInstance.html instanceof Node) return editorInstance.html;
    return null;
}

function getFragmentById(fragmentId) {
    if (!fragmentId || typeof Fragment?.one !== 'function') return null;
    try {
        return Fragment.one('#' + fragmentId);
    } catch (error) {
        return null;
    }
}

function configureMonacoEditorInDocumentShape(editorInstance) {
    if (!editorInstance || editorInstance.constructor?.name !== 'MonacoEditor') {
        return () => { };
    }

    let stopped = false;
    const cleanups = [];
    const stop = () => {
        if (stopped) return;
        stopped = true;
        cleanups.forEach((cleanup) => {
            try {
                cleanup();
            } catch (error) { }
        });
    };

    const applyConfiguration = () => {
        if (stopped) return true;

        try {
            if (typeof editorInstance.setWordwrap === 'function') {
                editorInstance.setWordwrap(true);
            }
        } catch (error) { }

        const monacoEditor = editorInstance.editor;
        if (!monacoEditor || typeof monacoEditor.updateOptions !== 'function') {
            return false;
        }

        try {
            monacoEditor.updateOptions({
                hover: { enabled: false },
                quickSuggestions: false,
                suggestOnTriggerCharacters: false,
                parameterHints: { enabled: false },
                wordBasedSuggestions: 'off',
                snippetSuggestions: 'none',
                tabCompletion: 'off'
            });
        } catch (error) { }

        return true;
    };

    if (applyConfiguration()) {
        return stop;
    }

    const checkAndStopWhenReady = () => {
        if (applyConfiguration()) {
            stop();
        }
    };

    const intervalId = setInterval(checkAndStopWhenReady, 200);
    cleanups.push(() => clearInterval(intervalId));

    if (window.EventSystem?.registerEventCallback) {
        const openedHandle = window.EventSystem.registerEventCallback('Codestrates.Editor.Opened', (eventData) => {
            const openedEditor = eventData?.editor || eventData?.detail?.editor;
            if (openedEditor && openedEditor !== editorInstance) return;
            checkAndStopWhenReady();
        });
        cleanups.push(() => openedHandle?.delete?.());

        const monacoLoadedHandle = window.EventSystem.registerEventCallback('Codestrates.Editor.Monaco.Loaded', checkAndStopWhenReady);
        cleanups.push(() => monacoLoadedHandle?.delete?.());
    }

    const rootNode = getEditorRootNode(editorInstance);
    if (rootNode && typeof MutationObserver !== 'undefined') {
        const observer = new MutationObserver(checkAndStopWhenReady);
        observer.observe(rootNode.ownerDocument.documentElement, {
            childList: true,
            subtree: true
        });
        cleanups.push(() => observer.disconnect());
    }

    checkAndStopWhenReady();
    return stop;
}

function ensureDocumentContainer() {
    let container = document.querySelector(DOCUMENT_FRAGMENT_CONTAINER);
    if (!container) {
        container = document.createElement('code-folder');
        container.id = 'document-fragments';
        container.setAttribute('name', 'Document Fragments');
        document.body.appendChild(container);
        WPMv2.stripProtection(container);
    }
    return container;
}

function DocumentShapeComponent({ shape, isEditing }) {
    const editor = useEditor();
    const [fullscreenShapeId, setFullscreenShapeId] = useCookieState(FULLSCREEN_SHAPE_STATE_KEY, null);
    const editorContainerRef = useRef(null);
    const pickerContainerRef = useRef(null);
    const editorInstanceRef = useRef(null);
    const renameInputRef = useRef(null);

    const isSelected = useValue('is selected', () =>
        editor.getSelectedShapeIds().includes(shape.id),
        [editor, shape.id]
    );
    const isDragging = useValue('is dragging', () => {
        if (!editor.getSelectedShapeIds().includes(shape.id)) {
            return false;
        }

        return (
            editor.isIn('select.translating') ||
            editor.isIn('select.dragging_handle') ||
            editor.isIn('select.rotating')
        );
    }, [editor, shape.id]);

    const sourceFragmentId = shape.props.sourceFragmentId;
    const fontSize = shape.props.fontSize ?? DEFAULT_FONT_SIZE;
    const hasFragment = sourceFragmentId && sourceFragmentId.length > 0;
    const isFullscreen = fullscreenShapeId === shape.id;

    const [fragmentName, setFragmentName] = useState('Document');
    const [availableFragments, setAvailableFragments] = useState([]);
    const [isRenaming, setIsRenaming] = useState(false);
    const [renameDraft, setRenameDraft] = useState('');

    const syncShapeNameToFragmentName = useCallback((nextName) => {
        const normalizedName = typeof nextName === 'string' && nextName.trim()
            ? nextName.trim()
            : DEFAULT_DOCUMENT_NAME;
        const currentShape = editor.getShape(shape.id);
        if (currentShape?.type !== 'Document' || currentShape?.props?.name === normalizedName) {
            return;
        }

        editor.updateShape({
            id: shape.id,
            type: 'Document',
            props: { name: normalizedName }
        });
    }, [editor, shape.id]);

    // Track fragment name via live attribute
    useEffect(() => {
        if (!hasFragment) return;
        const fragment = Fragment.one('#' + sourceFragmentId);
        if (!fragment) return;

        const applyFragmentName = () => {
            const nextName = fragment.element.getAttribute('name') || DEFAULT_DOCUMENT_NAME;
            setFragmentName(nextName);
            syncShapeNameToFragmentName(nextName);
        };

        applyFragmentName();
        const query = cQuery(fragment.element).liveAttribute('name', applyFragmentName);

        return () => query.stop();
    }, [sourceFragmentId, hasFragment, syncShapeNameToFragmentName]);

    // Keep rename draft in sync with current fragment name
    useEffect(() => {
        setRenameDraft(fragmentName || '');
    }, [fragmentName]);

    useEffect(() => {
        if (!isRenaming) return;
        requestAnimationFrame(() => {
            if (!renameInputRef.current) return;
            renameInputRef.current.focus();
            renameInputRef.current.select();
        });
    }, [isRenaming]);

    // Load available fragments for picker
    useEffect(() => {
        if (hasFragment) return;

        const container = document.querySelector(DOCUMENT_FRAGMENT_CONTAINER);
        if (!container) return;

        const refresh = () => {
            const fragments = Array.from(container.querySelectorAll(':scope > code-fragment'));
            setAvailableFragments(fragments.map(el => ({
                id: el.id,
                name: el.getAttribute('name') || 'Untitled'
            })));
        };

        refresh();
        const query = cQuery(container).liveQuery('code-fragment', {
            added: refresh,
            removed: refresh
        });

        return () => query.stop();
    }, [hasFragment]);

    // Mount/unmount the regular Codestrates editor for edit mode only.
    useEffect(() => {
        if (!hasFragment || !isEditing) return;

        const container = editorContainerRef.current;
        if (!container) return;

        let dependencyPollHandle = null;
        let nodePollHandle = null;
        let pendingEditorInstance = null;
        let stopMonacoEditorSync = () => { };

        const stopDependencyPoll = () => {
            if (!dependencyPollHandle) return;
            clearInterval(dependencyPollHandle);
            dependencyPollHandle = null;
        };

        const stopNodePoll = () => {
            if (!nodePollHandle) return;
            clearInterval(nodePollHandle);
            nodePollHandle = null;
        };

        const unloadEditorInstance = (editorInstance) => {
            if (!editorInstance || typeof editorInstance.unload !== 'function') {
                return;
            }

            setTimeout(() => {
                try {
                    editorInstance.unload();
                } catch (error) { }
            }, 0);
        };

        const clearMountedEditor = () => {
            stopMonacoEditorSync();
            stopMonacoEditorSync = () => { };

            const activeEditor = editorInstanceRef.current;
            editorInstanceRef.current = null;
            unloadEditorInstance(activeEditor);
            container.replaceChildren();
        };

        const tryMountPendingEditor = () => {
            if (!pendingEditorInstance) {
                stopNodePoll();
                return;
            }

            const editorNode = getEditorRootNode(pendingEditorInstance);
            if (!editorNode) return;

            editorInstanceRef.current = pendingEditorInstance;
            pendingEditorInstance = null;
            container.replaceChildren(editorNode);
            stopNodePoll();

            stopMonacoEditorSync = configureMonacoEditorInDocumentShape(editorInstanceRef.current);
            requestAnimationFrame(() => {
                try {
                    editorInstanceRef.current?.focus?.();
                } catch (focusError) { }
            });
        };

        const tryCreateEditor = () => {
            if (pendingEditorInstance || editorInstanceRef.current) {
                return;
            }

            const fragment = getFragmentById(sourceFragmentId);
            if (!fragment) {
                return;
            }

            if (!window.EditorManager?.createEditor) {
                return;
            }

            try {
                const editors = window.EditorManager.createEditor(fragment, { theme: 'light', mode: 'full' });
                const editorInstance = Array.isArray(editors) ? editors[0] : editors;
                if (!editorInstance) return;

                pendingEditorInstance = editorInstance;
                tryMountPendingEditor();

                if (pendingEditorInstance && !nodePollHandle) {
                    nodePollHandle = setInterval(tryMountPendingEditor, EDITOR_NODE_POLL_INTERVAL_MS);
                }

                stopDependencyPoll();
            } catch (error) {
                console.warn('DocumentShape: failed to create editor:', error);
            }
        };

        const ensureDependencyPoll = () => {
            if (dependencyPollHandle) {
                return;
            }

            dependencyPollHandle = setInterval(tryCreateEditor, EDITOR_DEPENDENCY_POLL_INTERVAL_MS);
        };

        clearMountedEditor();
        tryCreateEditor();

        if (!pendingEditorInstance && !editorInstanceRef.current) {
            ensureDependencyPoll();
        } else if (pendingEditorInstance && !nodePollHandle) {
            nodePollHandle = setInterval(tryMountPendingEditor, EDITOR_NODE_POLL_INTERVAL_MS);
        }

        return () => {
            stopDependencyPoll();
            stopNodePoll();

            const pendingEditor = pendingEditorInstance;
            pendingEditorInstance = null;
            if (pendingEditor && pendingEditor !== editorInstanceRef.current) {
                unloadEditorInstance(pendingEditor);
            }

            clearMountedEditor();
        };
    }, [sourceFragmentId, isEditing, hasFragment]);

    useEffect(() => {
        const interactiveContainer = hasFragment ? editorContainerRef.current : pickerContainerRef.current;
        if (!interactiveContainer) return;

        const stopPropagation = (event) => {
            if (isEditing) {
                if (MONACO_SELECTION_EVENT_TYPES.has(event.type)) {
                    return;
                }

                event.stopPropagation();
                return;
            }

            if (
                editor.isIn('select.brushing') ||
                editor.isIn('select.pointing_canvas') ||
                editor.isIn('select.translating') ||
                editor.isIn('select.dragging_handle') ||
                editor.isIn('select.rotating') ||
                editor.isIn('select.pointing_shape')
            ) {
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
            'mouseup'
        ];
        const useCapture = !isEditing;

        eventTypes.forEach((type) => {
            interactiveContainer.addEventListener(type, stopPropagation, { capture: useCapture });
        });

        return () => {
            eventTypes.forEach((type) => {
                interactiveContainer.removeEventListener(type, stopPropagation, { capture: useCapture });
            });
        };
    }, [editor, hasFragment, isEditing]);

    useEffect(() => {
        const interactiveContainer = hasFragment ? editorContainerRef.current : pickerContainerRef.current;
        if (!interactiveContainer) return;

        const handleWheel = (event) => {
            if (!editor.getSelectedShapeIds().includes(shape.id) && !isEditing) return;
            event.stopPropagation();
        };

        interactiveContainer.addEventListener('wheel', handleWheel);
        return () => {
            interactiveContainer.removeEventListener('wheel', handleWheel);
        };
    }, [editor, shape.id, hasFragment, isEditing]);

    const commitRename = useCallback(() => {
        if (!hasFragment) {
            setIsRenaming(false);
            return;
        }

        const fragment = Fragment.one('#' + sourceFragmentId);
        if (!fragment?.element) {
            setIsRenaming(false);
            return;
        }

        const nextName = (renameDraft || '').trim() || DEFAULT_DOCUMENT_NAME;
        fragment.element.setAttribute('name', nextName);
        setFragmentName(nextName);
        syncShapeNameToFragmentName(nextName);
        setIsRenaming(false);
    }, [hasFragment, sourceFragmentId, renameDraft, syncShapeNameToFragmentName]);

    const cancelRename = useCallback(() => {
        setRenameDraft(fragmentName || '');
        setIsRenaming(false);
    }, [fragmentName]);

    const adjustFontSize = useCallback((delta) => {
        const newSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, fontSize + delta));
        editor.updateShape({
            id: shape.id,
            type: 'Document',
            props: { fontSize: newSize }
        });
    }, [editor, shape.id, fontSize]);

    const toggleFullscreen = useCallback(() => {
        setFullscreenShapeId((currentShapeId) => {
            return currentShapeId === shape.id ? null : shape.id;
        });
    }, [setFullscreenShapeId, shape.id]);

    useEffect(() => {
        return () => {
            setFullscreenShapeId((currentShapeId) => {
                return currentShapeId === shape.id ? null : currentShapeId;
            });
        };
    }, [setFullscreenShapeId, shape.id]);

    const handleCreateNew = useCallback(() => {
        const container = ensureDocumentContainer();
        const fragmentId = `document-fragment-${crypto.randomUUID()}`;
        const nextName = 'New Document';
        const fragment = Fragment.create('text/markdown');
        fragment.element.id = fragmentId;
        fragment.element.setAttribute('name', nextName);
        fragment.raw = '# New Document\n\nStart writing here...';
        container.appendChild(fragment.element);
        WPMv2.stripProtection(fragment.element);

        editor.updateShape({
            id: shape.id,
            type: 'Document',
            props: {
                sourceFragmentId: fragmentId,
                name: nextName
            }
        });
    }, [editor, shape.id]);

    const handleAssignFragment = useCallback((fragmentId) => {
        const nextName = getFragmentById(fragmentId)?.element?.getAttribute('name') || DEFAULT_DOCUMENT_NAME;
        editor.updateShape({
            id: shape.id,
            type: 'Document',
            props: {
                sourceFragmentId: fragmentId,
                name: nextName
            }
        });
        setFragmentName(nextName);
    }, [editor, shape.id]);

    const handleDeleteFragment = useCallback((fragmentId) => {
        if (typeof fragmentId !== 'string' || fragmentId.trim() === '') {
            return;
        }

        const fragment = getFragmentById(fragmentId);
        const fragmentElement = fragment?.element;
        if (!fragmentElement || !fragmentElement.parentElement) {
            return;
        }

        const fragmentName = fragmentElement.getAttribute('name') || 'Untitled Document';
        const shouldDelete = window.confirm(`Delete document "${fragmentName}"?`);
        if (!shouldDelete) {
            return;
        }

        fragmentElement.parentElement.removeChild(fragmentElement);
    }, []);

    const documentContainerClassName = [
        'document-shape-html-container',
        isSelected ? 'document-shape-html-container-selected' : '',
        isDragging ? 'document-shape-html-container-dragging' : ''
    ].filter(Boolean).join(' ');

    return (
        <HTMLContainer
            className={documentContainerClassName}
            style={{
                width: shape.props.w + 'px',
                height: shape.props.h + 'px',
                pointerEvents: (isSelected || isEditing || !hasFragment) ? 'all' : 'none'
            }}
        >
            <div className='document-shape-topbar'>
                <div
                    className={`document-shape-title-group${isRenaming ? ' document-shape-title-group-renaming' : ''}`}
                    onPointerDown={isRenaming ? stopEventPropagation : undefined}
                >
                    {hasFragment && isRenaming ? (
                        <input
                            ref={renameInputRef}
                            className='document-shape-title-input'
                            value={renameDraft}
                            onChange={(event) => setRenameDraft(event.target.value)}
                            onBlur={commitRename}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                    event.preventDefault();
                                    commitRename();
                                } else if (event.key === 'Escape') {
                                    event.preventDefault();
                                    cancelRename();
                                }
                            }}
                            onPointerDown={stopEventPropagation}
                            aria-label='Document Name'
                        />
                    ) : (
                        <span className='document-shape-topbar-title'>{hasFragment ? fragmentName : 'Select Document'}</span>
                    )}
                </div>
                {hasFragment && (
                    <div
                        className={`document-shape-topbar-controls${isSelected ? ' document-shape-topbar-controls-visible' : ''}`}
                        onPointerDown={stopEventPropagation}
                    >
                        <button className='document-shape-icon-btn'
                            onPointerDown={stopEventPropagation}
                            onClick={(event) => {
                                stopEventPropagation(event);
                                setIsRenaming(true);
                            }}
                            title='Rename Document'
                        >
                            <span className='material-icons'>edit</span>
                        </button>
                        {!isEditing ? <>
                            <button className='document-shape-font-btn'
                                onPointerDown={stopEventPropagation}
                                onClick={(e) => { stopEventPropagation(e); adjustFontSize(-FONT_SIZE_STEP); }}
                                title='Decrease Font Size'
                            >
                                <span className='material-icons'>text_decrease</span>
                            </button>
                            <button className='document-shape-font-btn'
                                onPointerDown={stopEventPropagation}
                                onClick={(e) => { stopEventPropagation(e); adjustFontSize(FONT_SIZE_STEP); }}
                                title='Increase Font Size'
                            >
                                <span className='material-icons'>text_increase</span>
                            </button>
                        </> : null}
                        <button className='document-shape-icon-btn'
                            onPointerDown={stopEventPropagation}
                            onClick={(event) => {
                                stopEventPropagation(event);
                                toggleFullscreen();
                            }}
                            title={isFullscreen ? 'Exit Fullscreen' : 'Open Fullscreen'}
                        >
                            <span className='material-icons'>{isFullscreen ? 'close_fullscreen' : 'open_in_full'}</span>
                        </button>
                    </div>
                )}
            </div>
            {hasFragment ? (
                isEditing ? (
                    <div
                        key='document-shape-editor-mode'
                        ref={editorContainerRef}
                        className='document-shape-editor-container'
                        style={{ '--document-shape-font-size': `${fontSize}px`, touchAction: 'auto' }}
                    />
                ) : (
                    <div
                        key='document-shape-preview-mode'
                        ref={editorContainerRef}
                        className='document-shape-editor-container'
                        style={{ '--document-shape-font-size': `${fontSize}px`, touchAction: 'auto' }}
                    >
                        <ReactPreviewEditor fragmentId={sourceFragmentId} />
                    </div>
                )
            ) : (
                <div
                    ref={pickerContainerRef}
                    className='document-shape-picker'
                    onPointerDown={stopEventPropagation}
                    style={{ touchAction: 'auto' }}
                >
                    <div className='document-shape-picker-header'>
                        <span>Select a document or create a new one</span>
                    </div>
                    <div className='document-shape-picker-list'>
                        {availableFragments.map((frag) => {
                            return <div key={frag.id} className='document-shape-picker-item'>
                                <button
                                    className='document-shape-picker-select-btn'
                                    onClick={() => handleAssignFragment(frag.id)}
                                    onPointerDown={stopEventPropagation}
                                    title='Select Document'
                                >
                                    <span className='material-icons'>description</span>
                                    <span>{frag.name}</span>
                                </button>
                                <button
                                    className='document-shape-picker-delete-btn'
                                    onClick={(event) => {
                                        stopEventPropagation(event);
                                        handleDeleteFragment(frag.id);
                                    }}
                                    onPointerDown={stopEventPropagation}
                                    title='Delete Document'
                                >
                                    <span className='material-icons'>delete</span>
                                </button>
                            </div>;
                        })}
                    </div>
                    <button
                        className='document-shape-picker-create-btn'
                        onClick={handleCreateNew}
                        onPointerDown={stopEventPropagation}
                    >
                        <span className='material-icons'>add</span>
                        New Document
                    </button>
                </div>
            )}
        </HTMLContainer>
    );
}

class DocumentShapeUtil extends BaseBoxShapeUtil {
    static type = 'Document';
    static props = {
        w: T.positiveNumber,
        h: T.positiveNumber,
        sourceFragmentId: T.string,
        fontSize: T.positiveNumber,
        name: T.string
    };

    getDefaultProps() {
        return {
            w: DEFAULT_WIDTH,
            h: DEFAULT_HEIGHT,
            sourceFragmentId: '',
            fontSize: DEFAULT_FONT_SIZE,
            name: 'Untitled Document'
        };
    }

    canBind = () => true;
    canEdit = () => true;
    canResize = () => true;
    canCrop = () => false;
    canScroll = () => true;
    hideRotateHandle = () => false;

    getIndicatorPath(shape) {
        const path = new Path2D();
        path.roundRect(0, 0, shape.props.w, shape.props.h, 8);
        return path;
    }

    component(shape) {
        const isEditing = this.editor.getEditingShapeId() === shape.id;
        return <DocumentShapeComponent shape={shape} isEditing={isEditing} />;
    }
}

export const Main = DocumentShapeUtil;
