import React from 'react';

import { useTransientDOMState } from '#CoreHelpers .dom-store';



export function Main() {
    const [visible, setVisible] = useTransientDOMState('widget-repository-visible', false);

    return <>
        <div
            className={`button ${visible ? 'active' : ''}`}
            style={{
                order: -90
            }}
            onClick={() => setVisible(!visible)}
            title="Widget Repository"
        >
            <div className="icon material-icons">widgets</div>
        </div>
        <hr style={{
            order: -90
        }}></hr>
    </>;
}
