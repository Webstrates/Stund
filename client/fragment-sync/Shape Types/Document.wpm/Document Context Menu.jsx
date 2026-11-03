import React from 'react';
const { useCallback } = React;
import {
    TldrawUiMenuItem,
    TldrawUiMenuGroup,
    useEditor,
    useValue
} from 'tldraw';

import { useCookieState } from '#CoreHelpers .cookie-store';



const FULLSCREEN_SHAPE_STATE_KEY = 'fullscreen-shape-id';

export function Main() {
    const editor = useEditor();
    const [fullscreenShapeId, setFullscreenShapeId] = useCookieState(FULLSCREEN_SHAPE_STATE_KEY, null);

    const documentShape = useValue(
        'selected document shape',
        () => editor.getSelectedShapes().find(s => s.type === 'Document') ?? null,
        [editor]
    );

    const openEditor = useCallback(() => {
        if (!documentShape) return;

        setFullscreenShapeId(null);
        editor.setCurrentTool('select');
        editor.setEditingShape(documentShape.id);
        editor.setCurrentTool('select.editing_shape', {});
    }, [editor, documentShape, setFullscreenShapeId]);

    const toggleFullscreen = useCallback(() => {
        if (!documentShape) return;

        setFullscreenShapeId((currentShapeId) => {
            return currentShapeId === documentShape.id ? null : documentShape.id;
        });
    }, [documentShape, setFullscreenShapeId]);

    return documentShape && (
        <TldrawUiMenuGroup id="document-divider">
            <TldrawUiMenuItem
                id="document-fullscreen"
                label="Fullscreen Document"
                onSelect={toggleFullscreen}
            />
            <TldrawUiMenuItem
                id="document-edit"
                label="Edit Document Source"
                icon="code"
                onSelect={openEditor}
            />
        </TldrawUiMenuGroup>
    );
}
