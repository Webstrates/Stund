import React from 'react';
import { createRoot } from 'react-dom/client';



const defaultReloaderConfig = Object.freeze({
    entryFragmentSelector: '#App .default',
    reloadFragmentSelectors: [
        '#code [data-type="text/javascript+babel"]'
    ],
});

const getDefaultReloaderConfig = () => ({
    entryFragmentSelector: defaultReloaderConfig.entryFragmentSelector,
    reloadFragmentSelectors: [...defaultReloaderConfig.reloadFragmentSelectors],
});

const isNonEmptyString = (value) => {
    return typeof value === 'string' && value.trim().length > 0;
};

const getConfigFragment = () => {
    const configElement = document.querySelector('#Core code-fragment[name="Reloader Config"]');
    if (!configElement) {
        console.warn('React Reloader: Reloader Config fragment not found. Falling back to defaults.');
        return null;
    }

    return Fragment.one(configElement);
};

const loadReloaderConfig = () => {
    const fallbackConfig = getDefaultReloaderConfig();
    const configFragment = getConfigFragment();

    if (!configFragment) {
        return fallbackConfig;
    }

    const rawConfig = (configFragment.raw || '').trim();
    if (!rawConfig) {
        console.warn('React Reloader: Reloader Config is empty. Falling back to defaults.');
        return fallbackConfig;
    }

    try {
        const parsedConfig = JSON.parse(rawConfig);

        if (!parsedConfig || typeof parsedConfig !== 'object' || Array.isArray(parsedConfig)) {
            throw new Error('Configuration must be a JSON object.');
        }

        if (!isNonEmptyString(parsedConfig.entryFragmentSelector)) {
            throw new Error('entryFragmentSelector must be a non-empty string.');
        }

        if (!Array.isArray(parsedConfig.reloadFragmentSelectors)) {
            throw new Error('reloadFragmentSelectors must be an array.');
        }

        if (!parsedConfig.reloadFragmentSelectors.every(isNonEmptyString)) {
            throw new Error('reloadFragmentSelectors must only contain non-empty strings.');
        }

        return {
            entryFragmentSelector: parsedConfig.entryFragmentSelector.trim(),
            reloadFragmentSelectors: parsedConfig.reloadFragmentSelectors.map((selector) => selector.trim()),
        };
    } catch (error) {
        console.warn(`React Reloader: Invalid Reloader Config. Falling back to defaults. ${error.message}`);
        return fallbackConfig;
    }
};

const reloaderConfig = loadReloaderConfig();

async function render() {
    if (!window.cachedAppRoot) {
        let element = document.createElement('transient');
        element.id = 'app-root';
        document.body.appendChild(element);
        window.cachedAppRoot = createRoot(element);
    }

    const appFragment = Fragment.one(reloaderConfig.entryFragmentSelector);
    if (!appFragment) {
        throw new Error(`React Reloader: Could not find entry fragment for selector "${reloaderConfig.entryFragmentSelector}".`);
    }

    let content = await appFragment.require();
    if (!content || typeof content.App !== 'function') {
        throw new Error(`React Reloader: Entry fragment "${reloaderConfig.entryFragmentSelector}" must export an App component.`);
    }

    window.cachedAppRoot.render(React.createElement(content.App));
};

let reloadTimer = null;
const reload = () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async function reloadReact() {
        try {
            await render();
        } catch (ex) {
            console.error(ex);
        }
    }, 1000);
};

const registerReloadHandlers = () => {
    const watchedFragments = new Set();

    reloaderConfig.reloadFragmentSelectors.forEach((fragmentSelector) => {
        let lookedUpFragments = Fragment.find(fragmentSelector);
        lookedUpFragments.forEach((lookedUpFragment) => {
            const fragmentKey = lookedUpFragment?.uuid || lookedUpFragment;
            if (!lookedUpFragment || watchedFragments.has(fragmentKey)) {
                return;
            }

            watchedFragments.add(fragmentKey);
            lookedUpFragment.registerOnFragmentChangedHandler(() => {
                if (fragmentSelfReference.auto) {
                    reload();
                }
            });
        });
    });
};


registerReloadHandlers();
render().catch((error) => {
    console.warn('React Reloader: Initial render failed, retrying in 2 seconds...', error);
    setTimeout(() => {
        render().catch((retryError) => {
            console.error('React Reloader: Retry also failed.', retryError);
        });
    }, 500);
});
clearTimeout(reloadTimer);
