import React from 'react';

import { useTransientDOMState } from '#CoreHelpers .dom-store';



export function Main() {
    const [visible, setVisible] = useTransientDOMState('session-history-visible', false);
    const [sessionJoined] = useTransientDOMState('history-session-joined', false);

    return <>
        <div
            className={`button ${sessionJoined ? 'green' : visible ? 'active' : ''}`}
            style={{
                order: -100
            }}
            onClick={() => setVisible(!visible)}
            title="Activity Session"
        >
            <div className="icon material-icons">history</div>
        </div>
    </>;
}
