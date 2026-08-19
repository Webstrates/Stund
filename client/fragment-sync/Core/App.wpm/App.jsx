import React from 'react';
import { useRef, useEffect } from 'react';
import { ErrorBoundary } from 'react-error-boundary';

import { DynamicComponents } from '#CoreHelpers .dynamic-components';
import { GlobalEventProvider } from '#CoreHelpers .global-events';
import { CanvasView } from '#App .canvas-view';
import { useTransientDOMState } from '#CoreHelpers .dom-store';

import { Main as DocumentShape } from '#Document .dynamic-shape-component';
import { Main as WidgetShape } from '#Widget .dynamic-shape-component';
import { Main as VideoStreamShape } from '#VideoStream .dynamic-shape-component';
import { Main as ScreenStreamShape } from '#ScreenStream .dynamic-shape-component';

import { Main as DocumentTool } from '#Document .dynamic-tool-component';
import { Main as WidgetTool } from '#Widget .dynamic-tool-component';
import { Main as VideoStreamTool } from '#VideoStream .dynamic-tool-component';
import { Main as ScreenStreamTool } from '#ScreenStream .dynamic-tool-component';



const shapeUtils = [DocumentShape, WidgetShape, VideoStreamShape, ScreenStreamShape];
const tools = [DocumentTool, WidgetTool, VideoStreamTool, ScreenStreamTool];



function Canvas() {
    const boundaryRef = useRef();
    const [counter] = useTransientDOMState('canvas-reload-counter', 0);

    useEffect(() => {
        boundaryRef.current?.resetErrorBoundary();
    }, [counter]);

    return <>
        <ErrorBoundary ref={boundaryRef} fallback={null}>
            <CanvasView shapeUtils={shapeUtils} tools={tools} counter={counter} />
        </ErrorBoundary>
    </>;
}

export function App() {
    return <GlobalEventProvider>
        <Canvas />
        <DynamicComponents selector=".dynamic-gui-component" />
    </GlobalEventProvider>;
}
