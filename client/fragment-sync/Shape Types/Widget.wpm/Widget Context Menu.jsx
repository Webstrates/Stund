import React from 'react';
const { useCallback } = React;
import {
    TldrawUiMenuItem,
    TldrawUiMenuGroup,
    useEditor,
    useValue
} from 'tldraw';

import { useCookieState } from '#CoreHelpers .cookie-store';



const WIDGET_FRAGMENT_CONTAINER = '#widget-fragments';
const FULLSCREEN_SHAPE_STATE_KEY = 'fullscreen-shape-id';

export function Main() {
    const editor = useEditor();
    const [fullscreenShapeId, setFullscreenShapeId] = useCookieState(FULLSCREEN_SHAPE_STATE_KEY, null);

    const widgetShape = useValue(
        'selected widget shape',
        () => editor.getSelectedShapes().find(s => s.type === 'Widget') ?? null,
        [editor]
    );

    const reloadWidgetContent = useCallback(() => {
        if (!widgetShape) return;

        const fragment = Fragment.one('#' + widgetShape.props.sourceFragmentId);

        if (!fragment) {
            console.warn('Widget fragment not found:', widgetShape.props.sourceFragmentId);
            return;
        }

        // HACK: Set the raw content to itself to force a reload
        fragment.raw = fragment.raw;
    }, [widgetShape]);

    const openEditor = useCallback(() => {
        if (!widgetShape) return;

        const runAsync = async () => {
            if (typeof Cauldron === "undefined" || typeof Cauldron.Cauldron === "undefined") {
                await WPMv2.require({ package: "Cauldron", repository: "cauldron-repos" });
            }
            if (typeof localCauldronEditor === "undefined") {
                window.localCauldronEditor = new Cauldron.Cauldron();
            }
            localCauldronEditor.open();

            const fragment = Fragment.one('#' + widgetShape.props.sourceFragmentId);

            if (!fragment) {
                console.warn('Widget fragment not found:', widgetShape.props.sourceFragmentId);
                return;
            }

            EventSystem.triggerEvent("Cauldron.Open.FragmentEditor", { fragment });
        };

        runAsync();
    }, [widgetShape]);

    const forkWidget = useCallback(() => {
        if (!widgetShape) return;

        const oldFragmentElement = document.querySelector('#' + widgetShape.props.sourceFragmentId);
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

        setTimeout(() => {
            editor.createShape({
                type: 'Widget',
                props: {
                    ...widgetShape.props,
                    sourceFragmentId: newFragmentId
                },
                x: widgetShape.x + 20,
                y: widgetShape.y + 20,
                rotation: widgetShape.rotation,
                opacity: widgetShape.opacity
            });
        }, 100);
    }, [editor, widgetShape]);

    const toggleFullscreen = useCallback(() => {
        if (!widgetShape) return;

        setFullscreenShapeId((currentShapeId) => {
            return currentShapeId === widgetShape.id ? null : widgetShape.id;
        });
    }, [widgetShape, setFullscreenShapeId]);

    return widgetShape && (
        <TldrawUiMenuGroup id="widget-divider">
            <TldrawUiMenuItem
                id="widget-fullscreen"
                label="Fullscreen Widget"
                onSelect={toggleFullscreen}
            />
            <TldrawUiMenuItem
                id="widget-fork"
                label="Copy Widget"
                icon="duplicate"
                onSelect={forkWidget}
            />
            <TldrawUiMenuItem
                id="widget-edit"
                label="Edit Widget Code"
                icon="edit"
                onSelect={openEditor}
            />
            <TldrawUiMenuItem
                id="widget-reload"
                label="Widget Reload"
                icon="reset"
                onSelect={reloadWidgetContent}
            />
        </TldrawUiMenuGroup>
    );
}
