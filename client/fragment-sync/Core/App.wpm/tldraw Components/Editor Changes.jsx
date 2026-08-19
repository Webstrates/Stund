import React from 'react';
import {
    DefaultToolbar,
    DefaultToolbarContent,
    DefaultContextMenu,
    DefaultContextMenuContent,
    TldrawUiMenuItem,
    useIsToolSelected,
    useTools,
} from 'tldraw';

import { Main as DocumentContextMenu } from '#Document .dynamic-context-menu-component';
import { Main as WidgetContextMenu } from '#Widget .dynamic-context-menu-component';
import { Main as AISidebarContextMenu } from '#AISidebar .dynamic-context-menu-component';



function createSvgIconDataUrl(pathData) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#1f1f1f"><path d="${pathData}"/></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const toolbarIconUrls = {
    document: createSvgIconDataUrl('M280-280h280v-80H280v80Zm0-160h400v-80H280v80Zm0-160h400v-80H280v80Zm-80 480q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm0-80h560v-560H200v560Zm0-560v560-560Z'),
    widget: createSvgIconDataUrl('M666-440 440-666l226-226 226 226-226 226Zm-546-80v-320h320v320H120Zm400 400v-320h320v320H520Zm-400 0v-320h320v320H120Zm80-480h160v-160H200v160Zm467 48 113-113-113-113-113 113 113 113Zm-67 352h160v-160H600v160Zm-400 0h160v-160H200v160Zm160-400Zm194-65ZM360-360Zm240 0Z'),
    videoStream: createSvgIconDataUrl('M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h480q33 0 56.5 23.5T720-720v180l160-160v440L720-420v180q0 33-23.5 56.5T640-160H160Zm0-80h480v-480H160v480Zm0 0v-480 480Z'),
    screenStream: createSvgIconDataUrl('M320-400h80v-80q0-17 11.5-28.5T440-520h80v80l120-120-120-120v80h-80q-50 0-85 35t-35 85v80ZM160-240q-33 0-56.5-23.5T80-320v-440q0-33 23.5-56.5T160-840h640q33 0 56.5 23.5T880-760v440q0 33-23.5 56.5T800-240H160Zm0-80h640v-440H160v440Zm0 0v-440 440ZM40-120v-80h880v80H40Z')
};



export const uiOverrides = {
    tools(editor, tools) {
        tools.Document = {
            id: 'Document',
            icon: 'tool-document',
            label: 'Document',
            onSelect: () => {
                editor.setCurrentTool('Document');
            }
        };
        tools.Widget = {
            id: 'Widget',
            icon: 'tool-widget',
            label: 'Widget',
            onSelect: () => {
                editor.setCurrentTool('Widget');
            }
        };
        tools.VideoStream = {
            id: 'VideoStream',
            icon: 'tool-video-stream',
            label: 'Video Stream',
            onSelect: () => {
                editor.setCurrentTool('VideoStream');
            }
        };
        tools.ScreenStream = {
            id: 'ScreenStream',
            icon: 'tool-screen-stream',
            label: 'Screen Stream',
            onSelect: () => {
                editor.setCurrentTool('ScreenStream');
            }
        };
        return tools;
    }
};

function CustomContextMenu(props) {
    return (
        <DefaultContextMenu {...props}>
            <DocumentContextMenu />
            <WidgetContextMenu />
            <AISidebarContextMenu />
            <DefaultContextMenuContent />
        </DefaultContextMenu>
    );
}

function CustomToolbar(props) {
    const tools = useTools();
    const isDocumentSelected = useIsToolSelected(tools['Document']);
    const isWidgetSelected = useIsToolSelected(tools['Widget']);
    const isVideoStreamSelected = useIsToolSelected(tools['VideoStream']);
    const isScreenStreamSelected = useIsToolSelected(tools['ScreenStream']);

    return (
        <DefaultToolbar {...props}>
            <TldrawUiMenuItem {...tools['Document']} isSelected={isDocumentSelected} />
            <TldrawUiMenuItem {...tools['Widget']} isSelected={isWidgetSelected} />
            <TldrawUiMenuItem {...tools['VideoStream']} isSelected={isVideoStreamSelected} />
            <TldrawUiMenuItem {...tools['ScreenStream']} isSelected={isScreenStreamSelected} />
            <DefaultToolbarContent />
        </DefaultToolbar>
    );
}

export const components = {
    ContextMenu: CustomContextMenu,
    // ActionsMenu: null,
    // HelpMenu: null,
    // ZoomMenu: null,
    // MainMenu: null,
    // Minimap: null,
    // StylePanel: null,
    PageMenu: null,
    // NavigationPanel: null,
    Toolbar: CustomToolbar,
    // KeyboardShortcutsDialog: null,
    // QuickActions: null,
    // HelperButtons: null,
    DebugPanel: null,
    DebugMenu: null,
    SharePanel: null,
    // MenuPanel: null,
    // TopPanel: null,
    // CursorChatBubble: null,
    // RichTextToolbar: null,
    // Dialogs: null,
    // Toasts: null
};

export const assetUrls = {
    icons: {
        'tool-document': toolbarIconUrls.document,
        'tool-widget': toolbarIconUrls.widget,
        'tool-video-stream': toolbarIconUrls.videoStream,
        'tool-screen-stream': toolbarIconUrls.screenStream
    }
};
