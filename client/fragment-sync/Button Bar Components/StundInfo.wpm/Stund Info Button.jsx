import React from 'react';

import { useTransientDOMState } from '#CoreHelpers .dom-store';



export function Main() {
    const [visible, setVisible] = useTransientDOMState('stund-info-visible', false);

    return <>
        <hr style={{
            order: 997
        }} />
        <div
            className={`button ${visible ? 'active' : ''}`}
            style={{
                order: 998
            }}
            onClick={() => setVisible(!visible)}
            title="Stund Info"
        >
            <div className="icon material-icons">info</div>
        </div>
    </>;
}
