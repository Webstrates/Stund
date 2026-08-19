import React from 'react';
const { useEffect, useMemo, useRef, useState } = React;

function getFragmentById(fragmentId) {
    if (typeof fragmentId !== 'string' || fragmentId.trim() === '') {
        return null;
    }

    const trimmedFragmentId = fragmentId.trim();
    const selector = trimmedFragmentId.startsWith('#') ? trimmedFragmentId : '#' + trimmedFragmentId;

    try {
        return Fragment.one(selector);
    } catch (error) {
        return null;
    }
}

function getRenderableOutput(requiredModule) {
    if (requiredModule === null || requiredModule === undefined) {
        return '';
    }

    if (typeof requiredModule === 'object') {
        const preferredKeys = ['html', 'default', 'Main', 'Widget'];
        for (const key of preferredKeys) {
            if (!Object.prototype.hasOwnProperty.call(requiredModule, key)) {
                continue;
            }

            const candidateValue = requiredModule[key];
            if (candidateValue !== null && candidateValue !== undefined) {
                return candidateValue;
            }
        }

        const moduleValues = Object.values(requiredModule);
        const firstDefinedValue = moduleValues.find((value) => value !== null && value !== undefined);
        if (firstDefinedValue !== undefined) {
            return firstDefinedValue;
        }
    }

    return requiredModule;
}

function isReactElement(value) {
    if (React.isValidElement(value)) {
        return true;
    }

    return Boolean(
        value &&
        typeof value === 'object' &&
        Object.prototype.hasOwnProperty.call(value, '$$typeof') &&
        Object.prototype.hasOwnProperty.call(value, 'props')
    );
}

function isReactRenderable(value) {
    if (isReactElement(value)) {
        return true;
    }

    if (typeof value === 'function') {
        return true;
    }

    if (Array.isArray(value)) {
        return value.some((item) => isReactRenderable(item));
    }

    return false;
}

function normalizeReactOutput(value) {
    if (typeof value === 'function') {
        return React.createElement(value);
    }

    if (!Array.isArray(value)) {
        return value;
    }

    return <React.Fragment>{value}</React.Fragment>;
}

function nodeToHtml(node) {
    if (typeof Node === 'undefined' || !(node instanceof Node)) {
        return '';
    }

    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        const wrapper = document.createElement('div');
        wrapper.appendChild(node.cloneNode(true));
        return wrapper.innerHTML;
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
        return node.outerHTML || '';
    }

    if (node.nodeType === Node.TEXT_NODE) {
        const wrapper = document.createElement('div');
        wrapper.textContent = node.textContent || '';
        return wrapper.innerHTML;
    }

    return node.textContent || '';
}

function serializeToHtml(value) {
    if (value === null || value === undefined || value === false) {
        return '';
    }

    if (typeof value === 'string') {
        return value;
    }

    if (typeof value === 'number' || typeof value === 'bigint') {
        return String(value);
    }

    if (typeof Node !== 'undefined' && value instanceof Node) {
        return nodeToHtml(value);
    }

    if (Array.isArray(value)) {
        return value.map((item) => serializeToHtml(item)).join('');
    }

    if (typeof value === 'object' && typeof value.outerHTML === 'string') {
        return value.outerHTML;
    }

    return String(value);
}

export function ReactPreviewEditor({ fragmentId, className = '', style }) {
    const [renderMode, setRenderMode] = useState('html');
    const [htmlContent, setHtmlContent] = useState('');
    const [reactContent, setReactContent] = useState(null);
    const requestVersionRef = useRef(0);

    const rootClassName = useMemo(() => {
        return ['codestrates-editor-core-view', 'preview-editor', 'react-preview-editor', className]
            .filter(Boolean)
            .join(' ');
    }, [className]);

    useEffect(() => {
        let isCancelled = false;
        let attachedFragment = null;
        let attachPollHandle = null;
        let loadRetryHandle = null;

        const clearPreviewContent = () => {
            setRenderMode('html');
            setReactContent(null);
            setHtmlContent('');
        };

        const stopAttachPoll = () => {
            if (!attachPollHandle) {
                return;
            }
            clearInterval(attachPollHandle);
            attachPollHandle = null;
        };

        const clearLoadRetry = () => {
            if (!loadRetryHandle) {
                return;
            }
            clearTimeout(loadRetryHandle);
            loadRetryHandle = null;
        };

        const scheduleLoadRetry = () => {
            clearLoadRetry();
            loadRetryHandle = setTimeout(() => {
                if (isCancelled || !attachedFragment) {
                    return;
                }
                loadOutput(attachedFragment);
            }, 250);
        };

        const loadOutput = async (fragment) => {
            if (!fragment) {
                return;
            }

            const requestVersion = requestVersionRef.current + 1;
            requestVersionRef.current = requestVersion;

            try {
                const requiredModule = await fragment.require();
                if (isCancelled || requestVersionRef.current !== requestVersion) {
                    return;
                }

                const output = getRenderableOutput(requiredModule);
                if (isReactRenderable(output)) {
                    setRenderMode('react');
                    setReactContent(normalizeReactOutput(output));
                    setHtmlContent('');
                    clearLoadRetry();
                    return;
                }

                setRenderMode('html');
                setReactContent(null);
                setHtmlContent(serializeToHtml(output));
                clearLoadRetry();
            } catch (error) {
                if (isCancelled || requestVersionRef.current !== requestVersion) {
                    return;
                }

                console.error('Failed to load fragment preview output', error);
                clearPreviewContent();
                scheduleLoadRetry();
            }
        };

        const handleFragmentChanged = () => {
            if (!attachedFragment) {
                return;
            }
            loadOutput(attachedFragment);
        };

        const tryAttachFragment = () => {
            if (attachedFragment || isCancelled) {
                return;
            }

            const fragment = getFragmentById(fragmentId);
            if (!fragment) {
                return;
            }

            attachedFragment = fragment;
            attachedFragment.registerOnFragmentChangedHandler(handleFragmentChanged);
            stopAttachPoll();
            loadOutput(attachedFragment);
        };

        if (typeof fragmentId !== 'string' || fragmentId.trim() === '') {
            clearPreviewContent();
            return () => { };
        }

        clearPreviewContent();
        tryAttachFragment();

        if (!attachedFragment) {
            attachPollHandle = setInterval(tryAttachFragment, 250);
        }

        return () => {
            isCancelled = true;
            stopAttachPoll();
            clearLoadRetry();

            if (attachedFragment) {
                attachedFragment.unRegisterOnFragmentChangedHandler(handleFragmentChanged);
            }
            attachedFragment = null;
        };
    }, [fragmentId]);

    if (renderMode === 'react') {
        return <div className={rootClassName} style={style}>
            {reactContent}
        </div>;
    }

    return <div
        className={rootClassName}
        style={style}
        dangerouslySetInnerHTML={{ __html: htmlContent }}
    />;
}
