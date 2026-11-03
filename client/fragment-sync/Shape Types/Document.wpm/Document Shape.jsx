import React from 'react';
const { useRef, useState, useCallback, useEffect } = React;
import { T, HTMLContainer, BaseBoxShapeUtil, useEditor, useValue, stopEventPropagation } from 'tldraw';

import { ReactPreviewEditor, ReactDocumentEditor } from '#Document .react-preview-editor';
import { useDocumentFragment, DEFAULT_DOCUMENT_NAME, DEFAULT_DOCUMENT_CONTENT } from '#Document .helpers';
import { useCookieState } from '#CoreHelpers .cookie-store';
import { forwardShapeZoomWheel } from '#CanvasHelpers .default';

const DEFAULT_WIDTH = 320;
const DEFAULT_HEIGHT = 300;
const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 72;
const FONT_SIZE_STEP = 2;
const FULLSCREEN_SHAPE_STATE_KEY = 'fullscreen-shape-id';
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

function DocumentShapeComponent({ shape, isEditing }) {
    const editor = useEditor();
    const [fullscreenShapeId, setFullscreenShapeId] = useCookieState(FULLSCREEN_SHAPE_STATE_KEY, null);
    const editorContainerRef = useRef(null);
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

    const fragment = useDocumentFragment(editor, shape.id);
    const documentName = shape.props.name || DEFAULT_DOCUMENT_NAME;
    const fontSize = shape.props.fontSize ?? DEFAULT_FONT_SIZE;
    const isFullscreen = fullscreenShapeId === shape.id;

    const [isRenaming, setIsRenaming] = useState(false);
    const [renameDraft, setRenameDraft] = useState('');

    useEffect(() => {
        setRenameDraft(documentName);
    }, [documentName]);

    useEffect(() => {
        if (!isRenaming) return;
        const focusFrame = requestAnimationFrame(() => {
            if (!renameInputRef.current) return;
            renameInputRef.current.focus();
            renameInputRef.current.select();
        });
        return () => cancelAnimationFrame(focusFrame);
    }, [isRenaming]);

    useEffect(() => {
        const interactiveContainer = editorContainerRef.current;
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
    }, [editor, isEditing]);

    useEffect(() => {
        const interactiveContainer = editorContainerRef.current;
        if (!interactiveContainer) return;

        // Capture zoom before the embedded editor or preview consumes it.
        const handleZoomWheelCapture = (event) => {
            if (!editor.getSelectedShapeIds().includes(shape.id) && !isEditing) return;
            forwardShapeZoomWheel(editor, event);
        };

        const handleWheel = (event) => {
            if (!editor.getSelectedShapeIds().includes(shape.id) && !isEditing) return;
            event.stopPropagation();
        };

        interactiveContainer.addEventListener('wheel', handleZoomWheelCapture, { capture: true, passive: false });
        interactiveContainer.addEventListener('wheel', handleWheel);
        return () => {
            interactiveContainer.removeEventListener('wheel', handleZoomWheelCapture, { capture: true });
            interactiveContainer.removeEventListener('wheel', handleWheel);
        };
    }, [editor, shape.id, isEditing]);

    const commitRename = useCallback(() => {
        if (editor.getShape(shape.id)?.type === 'Document') {
            editor.updateShape({
                id: shape.id,
                type: 'Document',
                props: { name: renameDraft.trim() || DEFAULT_DOCUMENT_NAME }
            });
        }
        setIsRenaming(false);
    }, [editor, shape.id, renameDraft]);

    const cancelRename = useCallback(() => {
        setRenameDraft(documentName);
        setIsRenaming(false);
    }, [documentName]);

    const toggleEditing = useCallback(() => {
        if (isEditing) {
            editor.complete();
            editor.setEditingShape(null);
            editor.setCurrentTool('select');
            editor.select(shape.id);
            return;
        }

        if (!editor.canEditShape(shape.id)) return;

        setFullscreenShapeId(null);
        editor.setCurrentTool('select');
        editor.setEditingShape(shape.id);
        editor.setCurrentTool('select.editing_shape', {});
    }, [editor, shape.id, isEditing, setFullscreenShapeId]);

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

    const documentContainerClassName = [
        'document-shape-html-container',
        isSelected ? 'document-shape-html-container-selected' : '',
        (isSelected || isEditing) ? 'document-shape-html-container-controls-visible' : '',
        isDragging ? 'document-shape-html-container-dragging' : ''
    ].filter(Boolean).join(' ');

    return (
        <HTMLContainer
            className={documentContainerClassName}
            style={{
                width: shape.props.w + 'px',
                height: shape.props.h + 'px',
                pointerEvents: (isSelected || isEditing) ? 'all' : 'none'
            }}
        >
            <div
                className='document-shape-topbar'
                onPointerDownCapture={() => editor.cancelDoubleClick()}
                onDoubleClick={stopEventPropagation}
            >
                <div
                    className={`document-shape-title-group${isRenaming ? ' document-shape-title-group-renaming' : ''}`}
                    onPointerDown={isRenaming ? stopEventPropagation : undefined}
                >
                    {isRenaming ? (
                        <input
                            ref={renameInputRef}
                            className='document-shape-title-input'
                            value={renameDraft}
                            onChange={(event) => setRenameDraft(event.target.value)}
                            onBlur={commitRename}
                            onKeyDown={(event) => {
                                stopEventPropagation(event);
                                if (event.key === 'Enter') {
                                    event.preventDefault();
                                    commitRename();
                                } else if (event.key === 'Escape') {
                                    event.preventDefault();
                                    cancelRename();
                                }
                            }}
                            onKeyUp={stopEventPropagation}
                            onPointerDown={stopEventPropagation}
                            onPointerUp={stopEventPropagation}
                            onDoubleClick={stopEventPropagation}
                            aria-label='Document Name'
                        />
                    ) : (
                        <span
                            className='document-shape-topbar-title'
                            title='Double-Click To Rename'
                            onPointerDown={(event) => {
                                stopEventPropagation(event);
                                if (event.button === 0) editor.select(shape.id);
                            }}
                            onPointerUp={stopEventPropagation}
                            onDoubleClick={(event) => {
                                stopEventPropagation(event);
                                editor.complete();
                                editor.setEditingShape(null);
                                editor.setCurrentTool('select');
                                setRenameDraft(documentName);
                                setIsRenaming(true);
                            }}
                        >
                            {documentName}
                        </span>
                    )}
                </div>
                <div
                    className={`document-shape-topbar-controls${isSelected ? ' document-shape-topbar-controls-visible' : ''}`}
                    onPointerDown={stopEventPropagation}
                >
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
            </div>
            <div
                ref={editorContainerRef}
                className='document-shape-editor-container'
                style={{ '--document-shape-font-size': `${fontSize}px`, touchAction: 'auto' }}
            >
                {isEditing
                    ? <ReactDocumentEditor fragment={fragment} />
                    : <ReactPreviewEditor fragment={fragment} />}
            </div>
            {(isSelected || isEditing) && (
                <button
                    type='button'
                    className='document-shape-edit-button'
                    onPointerDown={stopEventPropagation}
                    onPointerUp={stopEventPropagation}
                    onKeyDown={stopEventPropagation}
                    onKeyUp={stopEventPropagation}
                    onDoubleClick={stopEventPropagation}
                    onClick={(event) => {
                        stopEventPropagation(event);
                        toggleEditing();
                    }}
                    title={isEditing ? 'Done Editing' : 'Edit Document'}
                    aria-label={isEditing ? 'Done Editing' : 'Edit Document'}
                >
                    <span className='material-icons' aria-hidden='true'>{isEditing ? 'check' : 'edit'}</span>
                </button>
            )}
        </HTMLContainer>
    );
}

class DocumentShapeUtil extends BaseBoxShapeUtil {
    static type = 'Document';
    static props = {
        w: T.positiveNumber,
        h: T.positiveNumber,
        text: T.string,
        fontSize: T.positiveNumber,
        name: T.string
    };

    getDefaultProps() {
        return {
            w: DEFAULT_WIDTH,
            h: DEFAULT_HEIGHT,
            text: DEFAULT_DOCUMENT_CONTENT,
            fontSize: DEFAULT_FONT_SIZE,
            name: DEFAULT_DOCUMENT_NAME
        };
    }

    canBind = () => true;
    canEdit = (shape, info) => !info?.type?.startsWith('double-click');
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
