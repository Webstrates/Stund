import React from 'react';

import { useTransientDOMState } from '#CoreHelpers .dom-store';



const MOBILE_BREAKPOINT_PX = 900;

const isMobileDeviceViewport = () => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return false;
    }

    const matchesNarrowWidth = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches;
    const matchesCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
    return matchesNarrowWidth || matchesCoarsePointer;
};

export function Main() {
    const [visible, setVisible] = useTransientDOMState('mobile-interface-menu-visible', isMobileDeviceViewport());

    return <>
        <hr style={{
            order: 499
        }} />
        <div
            className={`button ${visible ? 'active' : ''}`}
            style={{
                order: 500
            }}
            onClick={() => setVisible(!visible)}
            title="Open Mobile Overlay"
        >
            <div className="icon material-icons">mobile</div>
        </div>
    </>;
}
