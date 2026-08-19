import React from 'react';

import { DynamicComponents } from '#CoreHelpers .dynamic-components';



export function Main() {
    return <div className="button-bar">
        <DynamicComponents selector=".dynamic-button-bar-component" />
    </div>;
}
