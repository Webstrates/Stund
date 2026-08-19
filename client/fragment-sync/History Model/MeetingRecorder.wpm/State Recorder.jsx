import React from 'react';
const { useState, useEffect, useRef } = React;
import { useEditor } from 'tldraw';

import { useCookieState } from '#CoreHelpers .cookie-store';
import { useSessionIngest } from '#SessionHistory .default';
import { cleanShapeData, cleanShapesData } from '#MeetingRecorder .recorder-helpers';



export function Main() {
    const editor = useEditor();
    const ingest = useSessionIngest();
    const previousStateRef = useRef(null);
    const [active] = useCookieState('stateRecorderActive', true);

    useEffect(() => {
        if (!editor || !ingest || !active) return;

        let interval = null;

        const runAsync = async () => {
            const stateEventStream = await ingest.startEventStream('application.state.event');

            const updateState = async () => {
                let currentState = editor.getCurrentPageShapes();
                currentState = cleanShapesData(currentState);

                if (JSON.stringify(previousStateRef.current) === JSON.stringify(currentState)) {
                    return;
                }
                previousStateRef.current = currentState;

                stateEventStream.createStateEvent({ shapes: currentState });
            };

            interval = setInterval(updateState, 5000);
        };

        runAsync();

        return () => {
            if (interval) {
                clearInterval(interval);
            }
        };
    }, [editor, ingest, active]);

    return <div className="state-recorder" style={{ display: 'none' }}></div>;
}
