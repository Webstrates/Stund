import React from 'react';

import { useTransientDOMState } from '#CoreHelpers .dom-store';



export function Main() {
    const [visible, setVisible] = useTransientDOMState('processor-repository-visible', false);

    return <>
        <div
            className={`button ${visible ? 'active' : ''}`}
            style={{
                order: -100
            }}
            onClick={() => setVisible(!visible)}
            title="Processor Repository"
        >
            <div className="icon material-icons">conversion_path</div>
        </div>
        <hr style={{
            order: -100
        }}></hr>
    </>;
}
