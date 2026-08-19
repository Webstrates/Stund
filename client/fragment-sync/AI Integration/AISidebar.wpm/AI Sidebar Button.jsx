import React from 'react';
import { useCookieState } from '#CoreHelpers .cookie-store';



export function Main() {
    const [minimized, setMinimized] = useCookieState('ai-sidebar-minimized', false);

    return <>
        <div
            className={`button ${minimized ? '' : 'active'}`}
            style={{
                order: -950
            }}
            onClick={() => setMinimized(!minimized)}
            title="Open AI Sidebar"
        >
            <div className="icon material-icons">chat</div>
        </div>
        <hr style={{
            order: -900
        }}></hr>
    </>;
}
