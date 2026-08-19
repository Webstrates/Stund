import React from 'react';
const { useCallback } = React;
import {
    TldrawUiMenuItem,
    TldrawUiMenuGroup,
    useEditor,
    useValue
} from 'tldraw';

import { useAISidebar } from '#AISidebar .default';
import { createSelectionScreenshotImage } from '#CanvasHelpers .default';

export function Main() {
    const editor = useEditor();
    const { attachImagesToCurrentChat } = useAISidebar();

    const selectedShapes = useValue(
        'selected shapes',
        () => editor.getSelectedShapes(),
        [editor]
    );

    const attachScreenshotToChat = useCallback(async () => {
        try {
            const screenshotImage = await createSelectionScreenshotImage(selectedShapes);
            if (!screenshotImage) return;
            attachImagesToCurrentChat([screenshotImage], {
                autoSend: false,
                createIfMissing: true
            });
        } catch (error) {
            console.error('Could not attach screenshot to current chat:', error);
        }
    }, [selectedShapes, attachImagesToCurrentChat]);

    return selectedShapes.length > 0 && (
        <TldrawUiMenuGroup id="ai-sidebar-divider">
            <TldrawUiMenuItem
                id="ai-sidebar-attach-screenshot"
                label="Attach as Screenshot to Chat"
                icon="image"
                onSelect={attachScreenshotToChat}
            />
        </TldrawUiMenuGroup>
    );
}
