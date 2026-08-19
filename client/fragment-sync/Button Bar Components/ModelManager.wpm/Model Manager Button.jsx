import React from 'react';

import { useTransientDOMState } from '#CoreHelpers .dom-store';



export function Main() {
    const [visible, setVisible] = useTransientDOMState('model-manager-visible', false);

    return <div
        className={`button ${visible ? 'active' : ''}`}
        style={{
            order: -925
        }}
        onClick={() => setVisible(!visible)}
        title="Model Manager"
    >
        <div className="icon material-icons">memory</div>
    </div>;
}
