import React from 'react';
const { useEffect, useState } = React;

import { useTransientDOMState } from '#CoreHelpers .dom-store';



export function Main() {
    const [, setCounter] = useTransientDOMState('canvas-reload-counter', 0);
    const [cauldronOpen, setCauldronOpen] = useState(false);

    useEffect(() => {
        const openEvent = EventSystem.registerEventCallback('Cauldron.OnOpen', () => {
            setCauldronOpen(true);
        });

        const closeEvent = EventSystem.registerEventCallback('Cauldron.OnClose', () => {
            setCauldronOpen(false);
        });

        return () => {
            openEvent.delete();
            closeEvent.delete();
        };
    }, []);

    const toggleCauldron = () => {
        if (typeof localCauldronEditor !== 'undefined') {
            if (localCauldronEditor.isOpen()) {
                localCauldronEditor.close();
                setCauldronOpen(false);
            } else {
                localCauldronEditor.open();
                setCauldronOpen(true);
            }
        } else {
            cauldronEditor();
        }
    };

    return <>
        <div
            className={`button ${cauldronOpen ? 'active' : ''}`}
            style={{
                order: -1000,
                marginBottom: 'auto'
            }}
            onClick={toggleCauldron}
            title="Open Cauldron"
        >
            <div className="icon material-icons">construction</div>
        </div>
        <div
            className="button"
            style={{
                order: 1000,
                marginTop: 'auto'
            }}
            onClick={() => setCounter(c => c + 1)}
            title="Reload Canvas"
        >
            <div className="icon material-icons">bug_report</div>
        </div>
    </>;
}
