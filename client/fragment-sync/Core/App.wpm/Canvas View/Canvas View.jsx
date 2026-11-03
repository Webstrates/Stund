import React from 'react';
const { useMemo } = React;
import { Tldraw, createTLStore, defaultShapeUtils } from 'tldraw';

import { DynamicComponents } from '#CoreHelpers .dynamic-components';
import { uiOverrides, components, assetUrls } from '#App .editor-changes';
import { useDOMSync } from '#App .dom-sync';
import { WebstrateAssetStore } from '#App .webstrate-asset-store';

// Paste your tldraw license key here. Watermark visibility depends on the license type.
const tldrawLicenseKey = '';


export function CanvasView({ shapeUtils, tools, counter }) {
    const tlStore = useMemo(() => createTLStore({
        shapeUtils: [...defaultShapeUtils, ...shapeUtils],
        assets: new WebstrateAssetStore()
    }), [shapeUtils, counter]);
    const [store, migrationError] = useDOMSync({
        store: tlStore,
        node: document.querySelector('tldraw-document')
    });

    const tldraw = useMemo(() => (
        <Tldraw key={shapeUtils.map(s => s.type).join(',') + counter}
            licenseKey={tldrawLicenseKey || undefined}
            store={store}
            shapeUtils={shapeUtils}
            tools={tools}
            overrides={uiOverrides}
            components={components}
            assetUrls={assetUrls}
            options={{ maxPages: 1 }}
            onMount={(editor) => {
                window.tldrawEditor = editor;

                const currentPreferences = editor.user.getUserPreferences();
                const webstrateUserId = webstrate.user?.userId || '';
                const isAuthenticated = Boolean(webstrateUserId && webstrateUserId !== 'anonymous:');
                editor.user.updateUserPreferences({
                    id: isAuthenticated ? webstrateUserId : currentPreferences.id,
                    name: webstrate.user?.displayName || (isAuthenticated ? webstrateUserId : 'Anonymous')
                });

                setTimeout(() => {
                    editor.zoomToFit();

                    const camera = editor.getCamera();
                    if (camera.z > 1.5) {
                        const viewportCenter = editor.getViewportScreenCenter();
                        const pageCenter = editor.screenToPage(viewportCenter);

                        editor.setCamera({
                            ...camera,
                            z: 1.5
                        });
                        editor.centerOnPoint(pageCenter);
                    }
                }, 100);
            }}>
            <DynamicComponents selector=".dynamic-canvas-component" />
        </Tldraw>
    ), [shapeUtils, tools, counter]);

    if (migrationError === undefined) {
        return <div className="tldraw-canvas tldraw-migration-status">
            <span className="material-icons">hourglass_top</span>
            <span>Loading Canvas</span>
        </div>;
    }

    if (migrationError) {
        return <div className="tldraw-canvas tldraw-migration-status error">
            <span className="material-icons">error</span>
            <div>
                <strong>Canvas Migration Failed</strong>
                <p>{migrationError.message}</p>
                <p>The persisted canvas was left unchanged. Restore the pre-upgrade state before retrying.</p>
            </div>
        </div>;
    }

    return <div className="tldraw-canvas">
        {tldraw}
    </div>;
}
