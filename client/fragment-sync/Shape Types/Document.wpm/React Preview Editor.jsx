import React from 'react';
const { useEffect, useMemo, useRef, useState } = React;

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

export function ReactPreviewEditor({ fragment, className = '', style }) {
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
        let loadRetryHandle = null;

        const clearPreviewContent = () => {
            setRenderMode('html');
            setReactContent(null);
            setHtmlContent('');
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
                if (isCancelled || !fragment) {
                    return;
                }
                loadOutput(fragment);
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
            loadOutput(fragment);
        };

        clearPreviewContent();
        if (!fragment) return;
        fragment.registerOnFragmentChangedHandler(handleFragmentChanged);
        loadOutput(fragment);

        return () => {
            isCancelled = true;
            clearLoadRetry();
            fragment.unRegisterOnFragmentChangedHandler(handleFragmentChanged);
        };
    }, [fragment]);

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

export function createDocumentEditorClass(MonacoEditor) {
    return class DocumentMonacoEditor extends MonacoEditor {
        handleFragmentChanged() {
            if (this.applyingDocumentText || !this.editor?.getModel()) return;
            const text = this.fragment.raw;
            if (this.getValue() === text) return;

            const viewState = this.editor.saveViewState();
            this.applyingDocumentText = true;
            try {
                this.setValue(text);
                if (viewState) this.editor.restoreViewState(viewState);
            } finally {
                this.applyingDocumentText = false;
            }
        }

        // Document shapes synchronize complete values. Queued fragment deltas
        // may describe an older editor value, so always read the current text.
        handleTextInserted() {
            this.handleFragmentChanged();
        }

        handleTextDeleted() {
            this.handleFragmentChanged();
        }

        handleModelChanged() {
            if (this.applyingDocumentText || !this.editor?.getModel()) return;

            this.applyingDocumentText = true;
            try {
                super.handleModelChanged();
            } finally {
                this.applyingDocumentText = false;
            }

            // Another shape update can win while the local edit is published.
            this.handleFragmentChanged();
        }
    };
}

export function ReactDocumentEditor({ fragment }) {
    const containerRef = useRef(null);
    const [loadError, setLoadError] = useState(null);

    useEffect(() => {
        const container = containerRef.current;
        if (!fragment || !container) return;

        let editorInstance = null;
        let focusFrame = null;
        setLoadError(null);

        const tryMountEditor = () => {
            if (!window.EditorManager?.createEditor || !window.MonacoEditor) return;

            try {
                if (!editorInstance) {
                    const editors = window.EditorManager.createEditor(fragment, {
                        theme: 'light',
                        mode: 'full',
                        editor: createDocumentEditorClass(window.MonacoEditor)
                    });
                    editorInstance = Array.isArray(editors) ? editors[0] : editors;
                }

                const root = editorInstance?.html?.[0] || editorInstance?.html;
                if (!(root instanceof Node)) return;
                if (root.parentNode !== container) container.replaceChildren(root);

                const monacoEditor = editorInstance.editor;
                if (!monacoEditor?.updateOptions) return;
                editorInstance.setWordwrap?.(true);
                monacoEditor.updateOptions({
                    hover: { enabled: false },
                    quickSuggestions: false,
                    suggestOnTriggerCharacters: false,
                    parameterHints: { enabled: false },
                    wordBasedSuggestions: 'off',
                    snippetSuggestions: 'none',
                    tabCompletion: 'off'
                });
                clearInterval(pollHandle);
                focusFrame = requestAnimationFrame(() => editorInstance?.focus?.());
            } catch (error) {
                clearInterval(pollHandle);
                setLoadError(error);
            }
        };

        const pollHandle = setInterval(tryMountEditor, 120);
        tryMountEditor();

        return () => {
            clearInterval(pollHandle);
            cancelAnimationFrame(focusFrame);
            editorInstance?.unload?.();
            editorInstance = null;
            container.replaceChildren();
        };
    }, [fragment]);

    return <div className='document-source-editor' style={{ width: '100%', height: '100%' }}>
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
        {loadError ? <div role='alert'>Unable to open document editor: {loadError.message}</div> : null}
    </div>;
}
