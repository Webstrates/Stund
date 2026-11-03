import React from 'react';
import { createShapeId } from 'tldraw';

export const DEFAULT_DOCUMENT_NAME = 'New Document';
export const DEFAULT_DOCUMENT_CONTENT = '# New Document\n\nStart writing here...';

const normalizeText = (value) => typeof value === 'string' ? value : String(value ?? '');
const getDocument = (shapeId) => {
    if (typeof shapeId !== 'string' || !shapeId.trim()) return null;
    const shape = window.tldrawEditor?.getShape(shapeId);
    return shape?.type === 'Document' ? shape : null;
};

export const createDocument = (name = DEFAULT_DOCUMENT_NAME, text = DEFAULT_DOCUMENT_CONTENT) => {
    const editor = window.tldrawEditor;
    if (!editor) {
        throw new Error('The canvas editor is unavailable.');
    }

    const id = createShapeId();
    const center = editor.getViewportPageBounds().center;
    editor.createShapes([{
        id,
        type: 'Document',
        x: center.x - 160,
        y: center.y - 150,
        props: {
            name: normalizeText(name).trim() || DEFAULT_DOCUMENT_NAME,
            text: normalizeText(text)
        }
    }]);
    return id;
};

export const getDocumentText = (shapeId) => getDocument(shapeId)?.props.text ?? null;
export const getDocumentName = (shapeId) => getDocument(shapeId)?.props.name ?? null;

export const setDocumentText = (shapeId, text) => {
    if (!getDocument(shapeId)) return false;
    window.tldrawEditor.updateShape({ id: shapeId, type: 'Document', props: { text: normalizeText(text) } });
    return true;
};

export const setDocumentName = (shapeId, name) => {
    if (!getDocument(shapeId)) return false;
    window.tldrawEditor.updateShape({
        id: shapeId,
        type: 'Document',
        props: { name: normalizeText(name).trim() || DEFAULT_DOCUMENT_NAME }
    });
    return true;
};

// The shape remains the persisted source of truth. Each mounted view owns only
// a local fragment for the existing Codestrates preview and source editors.
export const useDocumentFragment = (editor, shapeId) => {
    const [fragment, setFragment] = React.useState(null);

    React.useEffect(() => {
        if (!editor || !shapeId) return;

        let adapter = null;
        let container = null;
        let pollHandle = null;
        let applyingShape = false;
        const shapeSyncContext = {};

        const handleFragmentChanged = (context) => {
            if (applyingShape || context === shapeSyncContext || !adapter) return;
            const shape = editor.getShape(shapeId);
            if (shape?.type === 'Document' && shape.props.text !== adapter.raw) {
                editor.updateShape({ id: shapeId, type: 'Document', props: { text: adapter.raw } });
            }
        };

        const disposeAdapter = () => {
            if (adapter) {
                adapter.unRegisterOnFragmentChangedHandler(handleFragmentChanged);
                adapter.unload();
                adapter = null;
            }
            container?.remove();
            container = null;
        };

        const syncFromShape = () => {
            const shape = editor.getShape(shapeId);
            if (shape?.type !== 'Document') {
                clearInterval(pollHandle);
                pollHandle = null;
                disposeAdapter();
                setFragment(null);
                return;
            }
            if (!adapter) return;

            const text = shape.props.text ?? '';
            const name = shape.props.name || DEFAULT_DOCUMENT_NAME;
            if (adapter.raw === text && adapter.element.getAttribute('name') === name) return;

            applyingShape = true;
            try {
                // Notify editors now, while the origin guard is active, rather
                // than replaying these writes later as fragment text deltas.
                adapter.executeObserverless(() => {
                    if (adapter.raw !== text) adapter.raw = text;
                    if (adapter.element.getAttribute('name') !== name) {
                        adapter.element.setAttribute('name', name);
                    }
                }, shapeSyncContext);
            } finally {
                applyingShape = false;
            }
        };

        const tryCreateAdapter = () => {
            if (adapter || !window.Fragment?.create || editor.getShape(shapeId)?.type !== 'Document') return;
            adapter = window.Fragment.create('text/markdown');
            if (!adapter) return;

            // Codestrates change callbacks need a parent, but it can stay detached.
            container = document.createElement('transient');
            container.appendChild(adapter.element);
            syncFromShape();
            adapter.registerOnFragmentChangedHandler(handleFragmentChanged);
            setFragment(adapter);
            clearInterval(pollHandle);
            pollHandle = null;
        };

        const stopListening = editor.store.listen(syncFromShape, { scope: 'document' });
        tryCreateAdapter();
        if (!adapter) pollHandle = setInterval(tryCreateAdapter, 300);

        return () => {
            clearInterval(pollHandle);
            stopListening();
            disposeAdapter();
        };
    }, [editor, shapeId]);

    return fragment;
};
