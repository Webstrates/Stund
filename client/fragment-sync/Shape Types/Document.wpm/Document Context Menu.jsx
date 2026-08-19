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

        const runAsync = async () => {
            if (typeof Cauldron === "undefined" || typeof Cauldron.Cauldron === "undefined") {
                await WPMv2.require({ package: "Cauldron", repository: "cauldron-repos" });
            }
            if (typeof localCauldronEditor === "undefined") {
                window.localCauldronEditor = new Cauldron.Cauldron();
            }
            localCauldronEditor.open();

            const fragment = Fragment.one('#' + documentShape.props.sourceFragmentId);

            if (!fragment) {
                console.warn('Document fragment not found:', documentShape.props.sourceFragmentId);
                return;
            }

            EventSystem.triggerEvent("Cauldron.Open.FragmentEditor", { fragment });
        };

        runAsync();
    }, [documentShape]);

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
