import React from 'react';
const { useState, useEffect, useCallback, useRef } = React;
import { ErrorBoundary } from 'react-error-boundary';
import { T, HTMLContainer, BaseBoxShapeUtil, stopEventPropagation, useEditor, useValue } from 'tldraw';

import { useCookieState } from '#CoreHelpers .cookie-store';
import { forwardShapeZoomWheel } from '#CanvasHelpers .default';



const DEFAULT_SIZE = 300;
const WIDGET_FRAGMENT_CONTAINER = '#widget-fragments';
const FULLSCREEN_SHAPE_STATE_KEY = 'fullscreen-shape-id';
const RELOAD_DEBOUNCE_MS = 1000;
const WIDGET_SKELETON_SOURCE = `/**
 * Changelog:
 * v1: Widget created
 */

import React from 'react';

export function Widget({ shape }) {
    return <div style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
        background: '#f5f5f5',
        color: '#424242'
    }}>
        <span className='material-icons' style={{ fontSize: '32px' }}>widgets</span>
        <div style={{ fontSize: '16px', fontWeight: '600' }}>New Widget</div>
    </div>;
}`;

function WidgetError({ error, errorType = 'Runtime', onRetry }) {
    return <div className="widget-error">
        <p className="error-title">
            <span className="icon material-icons">error</span>
            <span>{errorType} Error</span>
        </p>
        <pre className="error-message">{error.message}</pre>
        <button className="button" onClick={onRetry}>
            <span className="icon material-icons">refresh</span>
            <span>Retry</span>
        </button>
    </div>;
}

function ErrorFallback({ error, resetErrorBoundary }) {
    return <WidgetError error={error} errorType="Runtime" onRetry={resetErrorBoundary} />;
}

function WidgetComponent({ shape, isEditing }) {
    const editor = useEditor();
    const isSelected = useValue('is selected', () => {
        return editor.getSelectedShapeIds().includes(shape.id);
    }, [editor, shape.id]);
    const currentShape = useValue('current shape', () => {
        return editor.getShape(shape.id);
    }, [editor, shape.id]);

    const [loadedWidgetComponent, setLoadedWidgetComponent] = useState(null);
    const [reloadKey, setReloadKey] = useState(0);
    const [loadError, setLoadError] = useState(null);
    const [isRenaming, setIsRenaming] = useState(false);
    const [renameDraft, setRenameDraft] = useState('');
    const [fullscreenShapeId, setFullscreenShapeId] = useCookieState(FULLSCREEN_SHAPE_STATE_KEY, null);
    const widgetContainerRef = useRef(null);
    const renameInputRef = useRef(null);
    const isFullscreen = fullscreenShapeId === shape.id;

    useEffect(() => {
        if (document.querySelector('#' + shape.props.sourceFragmentId)) return;

        const sourceFragment = Fragment.create('text/javascript+babel');
        sourceFragment.element.id = shape.props.sourceFragmentId;
        sourceFragment.raw = WIDGET_SKELETON_SOURCE;

        document.querySelector(WIDGET_FRAGMENT_CONTAINER).appendChild(sourceFragment.element);
        WPMv2.stripProtection(sourceFragment.element);
    }, [shape.props.sourceFragmentId]);

    const reloadWidgetName = useCallback(() => {
        const fragmentElement = Fragment.one('#' + shape.props.sourceFragmentId)?.element;

        if (!fragmentElement) return;

        editor.updateShape({
            id: shape.id,
            props: {
                name: fragmentElement.getAttribute('name') || 'Untitled Widget'
            }
        });
    }, [editor, shape.id, shape.props.sourceFragmentId]);

    const reloadWidgetContent = useCallback(async () => {
        try {
            setLoadError(null);

            const fragment = Fragment.one('#' + shape.props.sourceFragmentId);

            if (!fragment) {
                console.warn('Widget fragment not found:', shape.props.sourceFragmentId);
                setLoadError(new Error(`Fragment not found: ${shape.props.sourceFragmentId}`));
                return;
            }

            const { Widget } = await fragment.require();

            if (!Widget) {
                console.warn('Widget component not found in fragment:', shape.props.sourceFragmentId);
                setLoadError(new Error('Widget component not exported from fragment'));
                return;
            }

            setLoadedWidgetComponent(() => Widget);
            setReloadKey((prev) => prev + 1);
        } catch (error) {
            console.error('Error loading widget:', error);
            setLoadError(error);
            setLoadedWidgetComponent(null);
        }
    }, [shape.props.sourceFragmentId]);

    useEffect(() => {
        if (!shape.props.sourceFragmentId) return;

        const fragment = Fragment.one('#' + shape.props.sourceFragmentId);
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
                console.log('Fragment changed, reloading widget:', shape.props.sourceFragmentId);
                reloadWidgetContent();
            }, RELOAD_DEBOUNCE_MS);
        };

        fragment.registerOnFragmentChangedHandler(handleFragmentChanged);
        const query = cQuery(fragment.element).liveAttribute('name', reloadWidgetName);

        return () => {
            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }
            fragment.unRegisterOnFragmentChangedHandler(handleFragmentChanged);
            query.stop();
        };
    }, [shape.props.sourceFragmentId, reloadWidgetContent, reloadWidgetName]);

    useEffect(() => {
        if (isRenaming) {
            return;
        }

        setRenameDraft(currentShape?.props?.name || shape.props.name || '');
    }, [currentShape?.props?.name, shape.props.name, isRenaming]);

    useEffect(() => {
        if (!isRenaming) return;

        requestAnimationFrame(() => {
            if (!renameInputRef.current) return;
            renameInputRef.current.focus();
            renameInputRef.current.select();
        });
    }, [isRenaming]);

    const commitRename = useCallback(() => {
        const nextName = (renameDraft || '').trim() || 'Untitled Widget';
        const fragmentElement = Fragment.one('#' + shape.props.sourceFragmentId)?.element;

        if (fragmentElement) {
            fragmentElement.setAttribute('name', nextName);
        }

        editor.updateShape({
            id: shape.id,
            props: {
                name: nextName
            }
        });
        setIsRenaming(false);
    }, [editor, shape.id, shape.props.sourceFragmentId, renameDraft]);

    const cancelRename = useCallback(() => {
        setRenameDraft(currentShape?.props?.name || shape.props.name || '');
        setIsRenaming(false);
    }, [currentShape?.props?.name, shape.props.name]);

    const openEditor = useCallback(() => {
        const runAsync = async () => {
            if (typeof Cauldron === 'undefined' || typeof Cauldron.Cauldron === 'undefined') {
                await WPMv2.require({ package: 'Cauldron', repository: 'cauldron-repos' });
            }
            if (typeof localCauldronEditor === 'undefined') {
                window.localCauldronEditor = new Cauldron.Cauldron();
            }
            localCauldronEditor.open();

            const fragment = Fragment.one('#' + shape.props.sourceFragmentId);

            if (!fragment) {
                console.warn('Widget fragment not found:', shape.props.sourceFragmentId);
                return;
            }

            EventSystem.triggerEvent('Cauldron.Open.FragmentEditor', { fragment });
        };

        runAsync();
    }, [shape.props.sourceFragmentId]);

    const forkWidget = useCallback(() => {
        const oldFragmentElement = document.querySelector('#' + shape.props.sourceFragmentId);
        if (!oldFragmentElement) {
            alert('Cannot copy widget: source fragment not found.');
            return;
        }

        const newFragmentElement = oldFragmentElement.cloneNode(true);
        const newFragmentId = `widget-fragment-${crypto.randomUUID()}`;
        newFragmentElement.id = newFragmentId;
        newFragmentElement.setAttribute('name', newFragmentElement.getAttribute('name') + ' (Copy)');
        document.querySelector(WIDGET_FRAGMENT_CONTAINER).appendChild(newFragmentElement);
        WPMv2.stripProtection(newFragmentElement);

        window.tldrawEditor.createShape({
            type: 'Widget',
            props: {
                ...shape.props,
                sourceFragmentId: newFragmentId
            },
            x: shape.x + 20,
            y: shape.y + 20,
            rotation: shape.rotation,
            opacity: shape.opacity
        });
    }, [shape]);

    const openFullscreen = useCallback(() => {
        setFullscreenShapeId(shape.id);
    }, [setFullscreenShapeId, shape.id]);

    const closeFullscreen = useCallback(() => {
        setFullscreenShapeId((currentShapeId) => {
            return currentShapeId === shape.id ? null : currentShapeId;
        });
    }, [setFullscreenShapeId, shape.id]);

    useEffect(() => {
        return () => {
            setFullscreenShapeId((currentShapeId) => {
                return currentShapeId === shape.id ? null : currentShapeId;
            });
        };
    }, [setFullscreenShapeId, shape.id]);

    useEffect(() => {
        const container = widgetContainerRef.current;
        if (!container) return;

        const stopPropagationCapture = (event) => {
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

        eventTypes.forEach((type) => {
            container.addEventListener(type, stopPropagationCapture, { capture: true });
        });

        return () => {
            eventTypes.forEach((type) => {
                container.removeEventListener(type, stopPropagationCapture, { capture: true });
            });
        };
    }, [editor]);

    useEffect(() => {
        const interactiveContainer = widgetContainerRef.current;
        if (!interactiveContainer) return;

        // Capture zoom before the embedded widget consumes it.
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

    const activeShape = currentShape || shape;
    const widgetName = activeShape?.props?.name || 'Untitled Widget';

    return (
        <HTMLContainer data-is-editing={isEditing} style={{
            width: shape.props.w + 'px',
            height: shape.props.h + 'px',
            pointerEvents: (isSelected || isEditing) ? 'all' : 'none'
        }}>
            {isEditing ? <div className="editing-menu"
                onPointerDown={stopEventPropagation}
                onPointerMove={stopEventPropagation}>
                <div className="widget-source-fragment-id">{shape.props.sourceFragmentId}</div>
                <button className="button" onClick={isFullscreen ? closeFullscreen : openFullscreen}>
                    <span className="icon material-icons">{isFullscreen ? 'close_fullscreen' : 'open_in_full'}</span>
                    <span>{isFullscreen ? 'Exit Fullscreen' : 'Open Fullscreen'}</span>
                </button>
                <button className="button" onClick={forkWidget}>
                    <span className="icon material-icons">fork_right</span>
                    <span>Copy Widget</span>
                </button>
                <button className="button" onClick={openEditor}>
                    <span className="icon material-icons">code</span>
                    <span>Edit Widget Code</span>
                </button>
                <button className="button" onClick={reloadWidgetContent}>
                    <span className="icon material-icons">refresh</span>
                    <span>Manual Reload</span>
                </button>
            </div> : null}

            <div className="widget-drag-bar">
                <div
                    className={`widget-title-group${isRenaming ? ' widget-title-group-renaming' : ''}`}
                    onPointerDown={isRenaming ? stopEventPropagation : undefined}
                >
                    {isRenaming ? <input
                        ref={renameInputRef}
                        className="widget-title-input"
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
                        aria-label="Widget Name"
                    /> : <span className="widget-title">{widgetName}</span>}
                </div>
                <div
                    className={`widget-topbar-controls${isSelected ? ' widget-topbar-controls-visible' : ''}`}
                    onPointerDown={stopEventPropagation}
                >
                        <button
                            className="widget-topbar-icon-btn"
                            onPointerDown={stopEventPropagation}
                            onClick={(event) => {
                                stopEventPropagation(event);
                                setIsRenaming(true);
                            }}
                            title="Rename Widget"
                        >
                            <span className="material-icons">edit</span>
                        </button>
                        <button
                            className="widget-topbar-icon-btn"
                            onPointerDown={stopEventPropagation}
                            onClick={(event) => {
                                stopEventPropagation(event);
                                openEditor();
                            }}
                            title="Edit Widget Code"
                        >
                            <span className="material-icons">code</span>
                        </button>
                        <button
                            className="widget-topbar-icon-btn"
                            onPointerDown={stopEventPropagation}
                            onClick={(event) => {
                                stopEventPropagation(event);
                                isFullscreen ? closeFullscreen() : openFullscreen();
                            }}
                            title={isFullscreen ? 'Exit Fullscreen' : 'Open Fullscreen'}
                        >
                            <span className="material-icons">{isFullscreen ? 'close_fullscreen' : 'open_in_full'}</span>
                        </button>
                </div>
            </div>

            <div className="widget-container"
                ref={widgetContainerRef}
                style={{ pointerEvents: 'all', touchAction: 'auto' }}
            >
                <div className="widget-render-mount">
                    <ErrorBoundary
                        key={reloadKey}
                        FallbackComponent={ErrorFallback}
                        onReset={reloadWidgetContent}
                    >
                        {loadedWidgetComponent ? React.createElement(loadedWidgetComponent, { shape: activeShape }) : null}
                        {loadError ? <WidgetError error={loadError} errorType="Load" onRetry={reloadWidgetContent} /> : null}
                    </ErrorBoundary>
                </div>
                {isFullscreen ? <div className="widget-fullscreen-indicator">
                    <span className="icon material-icons">open_in_full</span>
                    <span>Fullscreen Active</span>
                </div> : null}
            </div>
        </HTMLContainer>
    );
}

class WidgetShapeUtil extends BaseBoxShapeUtil {
    static type = 'Widget';
    static props = {
        w: T.positiveNumber,
        h: T.positiveNumber,
        sourceFragmentId: T.string,
        name: T.string
    };

    getDefaultProps() {
        return {
            w: DEFAULT_SIZE,
            h: DEFAULT_SIZE,
            sourceFragmentId: `widget-fragment-${crypto.randomUUID()}`,
            name: 'Untitled Widget'
        };
    }

    canBind = () => true;
    canEdit = () => true;

    canResize = () => true;
    canCrop = () => false;
    canScroll = () => false;
    hideRotateHandle = () => false;

    getIndicatorPath(shape) {
        const path = new Path2D();
        path.roundRect(0, 0, shape.props.w, shape.props.h, 8);
        return path;
    }

    component(shape) {
        const isEditing = this.editor.getEditingShapeId() === shape.id;
        return <WidgetComponent shape={shape} isEditing={isEditing} />;
    }
}

export const Main = WidgetShapeUtil;
