import React from 'react';
const { useState, useEffect, useRef } = React;

import { useTransientDOMState } from '#CoreHelpers .dom-store';
import { useCookieState } from '#CoreHelpers .cookie-store';
import { Dialog, DialogHeader } from '#Dialog .default';



const FULLSCREEN_SHAPE_STATE_KEY = 'fullscreen-shape-id';
const MOBILE_INTERFACE_MENU_VISIBLE_KEY = 'mobile-interface-menu-visible';
const MOBILE_BREAKPOINT_PX = 900;
const EDITOR_POLL_INTERVAL_MS = 700;
const SUPPORTED_FULLSCREEN_SHAPE_TYPES = ['Widget', 'Document'];

const getShapeTypeLabel = (shapeType) => {
    return shapeType === 'Document' ? 'Document' : 'Widget';
};

const getShapeTypeIcon = (shapeType) => {
    return shapeType === 'Document' ? 'description' : 'widgets';
};

const getWidgetDisplayName = (shape, index = 0) => {
    const providedName = typeof shape?.props?.name === 'string' ? shape.props.name.trim() : '';
    if (providedName) {
        return providedName;
    }

    return `Widget ${index + 1}`;
};

const getDocumentDisplayName = (shape, index = 0) => {
    const name = shape?.props?.name?.trim();
    if (name) return name;

    return `Document ${index + 1}`;
};

const getFullscreenShapeListFromEditor = (editor) => {
    if (!editor || typeof editor.getCurrentPageShapes !== 'function') {
        return [];
    }

    const shapes = editor.getCurrentPageShapes() || [];
    let widgetCount = 0;
    let documentCount = 0;

    const fullscreenShapes = [];
    shapes.forEach((shape) => {
        if (!SUPPORTED_FULLSCREEN_SHAPE_TYPES.includes(shape?.type)) {
            return;
        }

        const shapeType = shape.type;
        const shapeName = shapeType === 'Document'
            ? getDocumentDisplayName(shape, documentCount++)
            : getWidgetDisplayName(shape, widgetCount++);

        fullscreenShapes.push({
            id: shape.id,
            type: shapeType,
            name: shapeName,
            sourceFragmentId: shapeType === 'Widget' ? (shape?.props?.sourceFragmentId || '') : ''
        });
    });

    return fullscreenShapes.sort((left, right) => {
        const typeCompare = getShapeTypeLabel(left.type).localeCompare(getShapeTypeLabel(right.type), undefined, { sensitivity: 'base' });
        if (typeCompare !== 0) {
            return typeCompare;
        }

        return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
    });
};

const areFullscreenShapeListsEqual = (left, right) => {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
        return false;
    }

    for (let i = 0; i < left.length; i++) {
        if (
            left[i].id !== right[i].id ||
            left[i].name !== right[i].name ||
            left[i].type !== right[i].type ||
            left[i].sourceFragmentId !== right[i].sourceFragmentId
        ) {
            return false;
        }
    }

    return true;
};

const isMobileDeviceViewport = () => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return false;
    }

    const matchesNarrowWidth = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches;
    const matchesCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
    return matchesNarrowWidth || matchesCoarsePointer;
};

export function Main() {
    const [fullscreenShapes, setFullscreenShapes] = useState([]);
    const [, setFullscreenShapeId] = useCookieState(FULLSCREEN_SHAPE_STATE_KEY, null);
    const [visible, setVisible] = useTransientDOMState(MOBILE_INTERFACE_MENU_VISIBLE_KEY, isMobileDeviceViewport());
    const isListeningRef = useRef(false);

    useEffect(() => {
        const syncFullscreenShapes = () => {
            const editor = window.tldrawEditor;
            if (!editor) return;

            const nextFullscreenShapes = getFullscreenShapeListFromEditor(editor);
            setFullscreenShapes((prev) => areFullscreenShapeListsEqual(prev, nextFullscreenShapes) ? prev : nextFullscreenShapes);
            setFullscreenShapeId((currentId) => {
                if (!currentId) return currentId;
                return nextFullscreenShapes.some((shape) => shape.id === currentId) ? currentId : null;
            });

            if (!isListeningRef.current) {
                isListeningRef.current = true;
                editor.store.listen(() => syncFullscreenShapes());
            }
        };

        const pollHandle = window.setInterval(syncFullscreenShapes, EDITOR_POLL_INTERVAL_MS);
        return () => window.clearInterval(pollHandle);
    }, [setFullscreenShapeId]);

    const openShapeFullscreen = (shapeId) => {
        if (typeof shapeId !== 'string' || !shapeId.trim()) {
            return;
        }

        setFullscreenShapeId(shapeId);
    };

    return (
        <Dialog
            className="mobile-interface-dialog"
            visible={visible}
            setVisible={setVisible}
        >
            <DialogHeader title="Mobile Overlay" icon="mobile" onClose={() => setVisible(false)} />
            <div className="mobile-interface-panel">
                <div className="mobile-interface-widget-list">
                    <h2>Available Fullscreen Shapes</h2>
                    {fullscreenShapes.length > 0 ? fullscreenShapes.map((shape) => {
                        const shapeTypeLabel = getShapeTypeLabel(shape.type);

                        return <div key={shape.id} className="mobile-interface-widget-list-item">
                            <div className="mobile-interface-widget-list-item-main">
                                <span className="material-icons mobile-interface-widget-list-item-icon">
                                    {getShapeTypeIcon(shape.type)}
                                </span>
                                <div className="mobile-interface-widget-list-item-label">
                                    <span className="mobile-interface-widget-list-item-type">{shapeTypeLabel}</span>
                                    <span className="mobile-interface-widget-list-item-name">{shape.name}</span>
                                </div>
                            </div>
                            <button
                                className="dialog-action-button mobile-interface-secondary-button"
                                onClick={() => openShapeFullscreen(shape.id)}
                                title={`Open ${shapeTypeLabel} Fullscreen`}
                            >
                                <span className="material-icons">open_in_full</span>
                                <span>Open Fullscreen</span>
                            </button>
                        </div>;
                    }) : <div className="mobile-interface-empty-state">
                        <span className="material-icons">view_compact_alt</span>
                        <span>No fullscreen shapes available on this board yet.</span>
                    </div>}
                </div>
            </div>
        </Dialog>
    );
}
