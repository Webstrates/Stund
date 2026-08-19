import React from 'react';
const { useEffect, useRef, useState, useCallback } = React;

import { useDOMState } from '#CoreHelpers .dom-store';
import {
    AI_CHAT_DOM_STORE_KEY,
    safeStringify,
    stripImageDataFromValue
} from '#AIChatComponent .chat-contract';
import {
    extractImageFilesFromClipboardData,
    extractImageContextMetadata,
    hasImageDataUrl,
    normalizeImageDataUrl,
    openImageInNewTab
} from '#AIChatComponent .image-context';
import {
    createShapePreviewDescriptor,
    extractShapeContextMetadata,
    focusShapeInCanvas
} from '#AIChatComponent .shape-context';



const STEP_ICONS = {
    stackEntry: 'memory',
    slopCall: 'psychology_alt',
    toolCall: 'build_circle',
    stackReturn: 'undomemory',
    slopReturn: 'undopsychology_alt',
    toolReturn: 'undobuild_circle',
    stackException: 'errormemory',
    slopException: 'errorpsychology_alt',
    toolException: 'errorbuild_circle',
    slopSyntaxException: 'question_mark'
};

const STEP_HOVER_TEXT = {
    stackEntry: 'AI Connection Layer Start',
    slopCall: 'Slop Function Call',
    toolCall: 'Tool Call',
    stackReturn: 'Completion of AI Connection Layer',
    slopReturn: 'Slop Function Returns',
    toolReturn: 'Tool Returns',
    stackException: 'Exception',
    slopException: 'Slop Function Rejected',
    toolException: 'Tool Threw Exception',
    slopSyntaxException: 'Slop Communication Nonconformance'
};



export function ShapePreviewTile({
    shapeItem,
    className = '',
    onClick = null,
    onRemove = null,
    removeTitle = 'Remove shape'
}) {
    if (!shapeItem || typeof shapeItem !== 'object') {
        return null;
    }

    const tileClassName = [
        className,
        shapeItem.imagePreviewSource ? 'with-image' : 'placeholder',
        shapeItem.textPreview ? 'with-text' : ''
    ].join(' ').trim();
    const tileStyle = shapeItem.color ? { '--shape-preview-color': shapeItem.color } : undefined;
    const handleTileClick = typeof onClick === 'function' ? onClick : undefined;

    return <div
        className={tileClassName}
        title={shapeItem.title || `Shape ${shapeItem.id} (${shapeItem.type})`}
        onClick={handleTileClick}
        style={tileStyle}
    >
        {shapeItem.imagePreviewSource
            ? <img src={shapeItem.imagePreviewSource} alt={`Shape ${shapeItem.id}`} />
            : <React.Fragment>
                <span className="shape-color-indicator" />
                <span className="shape-body">
                    {shapeItem.textPreview
                        ? <span className="shape-text">{shapeItem.textPreview}</span>
                        : <span className="shape-icon material-icons">{shapeItem.icon}</span>}
                    <span className="shape-type">{shapeItem.type}</span>
                </span>
            </React.Fragment>}
        {typeof onRemove === 'function' && <button
            type="button"
            className="remove-preview-item"
            title={removeTitle}
            onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onRemove();
            }}
        >
            <span className="remove-icon material-icons">close</span>
        </button>}
    </div>;
}

function ChatEntry({ entry, type, menuOverlay, imagePreviews = [] }) {
    const entryRef = useRef(null);
    const [isProgressExpanded, setIsProgressExpanded] = useState(false);
    const validImagePreviews = Array.isArray(imagePreviews)
        ? imagePreviews
            .map((preview) => {
                const normalizedDataUrl = normalizeImageDataUrl(preview?.dataUrl, preview?.mimeType);
                if (!normalizedDataUrl) {
                    return null;
                }

                return {
                    ...preview,
                    dataUrl: normalizedDataUrl
                };
            })
            .filter(Boolean)
        : [];
    const entryImageContext = Array.isArray(entry?.imageContext)
        ? entry.imageContext
        : [];
    const entryShapeContext = Array.isArray(entry?.shapeContext)
        ? entry.shapeContext
        : [];
    const previewById = new Map();
    validImagePreviews.forEach((preview) => {
        if (preview?.id) {
            previewById.set(preview.id, preview);
        }
    });

    const usedPreviewItems = new Set();
    const displayImageItems = [];

    entryImageContext.forEach((imageContextItem, index) => {
        let matchedPreview = null;
        if (imageContextItem?.id && previewById.has(imageContextItem.id)) {
            matchedPreview = previewById.get(imageContextItem.id);
        } else {
            matchedPreview = validImagePreviews.find((preview) => !usedPreviewItems.has(preview));
        }

        if (matchedPreview) {
            usedPreviewItems.add(matchedPreview);
        }

        displayImageItems.push({
            id: imageContextItem?.id || matchedPreview?.id || `${entry?.id || 'entry'}-context-${index}`,
            name: imageContextItem?.name || matchedPreview?.name || `Image ${index + 1}`,
            mimeType: imageContextItem?.mimeType || matchedPreview?.mimeType || 'image/png',
            dataUrl: hasImageDataUrl(matchedPreview?.dataUrl) ? matchedPreview.dataUrl : null
        });
    });

    validImagePreviews.forEach((preview, index) => {
        if (usedPreviewItems.has(preview)) {
            return;
        }

        displayImageItems.push({
            id: preview?.id || `${entry?.id || 'entry'}-preview-${index}`,
            name: preview?.name || `Image ${displayImageItems.length + 1}`,
            mimeType: preview?.mimeType || 'image/png',
            dataUrl: preview.dataUrl
        });
    });

    const displayShapeItems = entryShapeContext
        .map((shapeItem, index) => createShapePreviewDescriptor(shapeItem, index))
        .filter(Boolean);

    const createInspectionMenuForStep = useCallback((step) => {
        if (!window.MenuSystem) return null;

        const inspectionMenu = window.MenuSystem.MenuManager.createMenu('AIChatComponent.Thinking.InspectorMenu', {
            groupDividers: true
        });

        if (step.arguments && step.arguments.length > 0) {
            const argumentsMenu = window.MenuSystem.MenuManager.createMenu('AIChatComponent.Thinking.InspectorMenu.Arguments', {
                groupDividers: true
            });
            step.arguments.forEach((arg, index) => {
                const valueConverted = typeof arg === 'string' ? arg : safeStringify(arg);
                argumentsMenu.addItem({
                    label: valueConverted || 'undefined',
                    onAction: () => console.log('Argument ' + (index + 1), arg)
                });
            });
            inspectionMenu.addItem({
                label: 'Arguments',
                icon: window.IconRegistry?.createIcon('mdc:tune'),
                submenu: argumentsMenu
            });
        }

        if (step.returnValue !== undefined) {
            const returnMenu = window.MenuSystem.MenuManager.createMenu('AIChatComponent.Thinking.InspectorMenu.Return', {});
            const valueConverted = typeof step.returnValue === 'string' ? step.returnValue : safeStringify(step.returnValue);
            returnMenu.addItem({
                label: valueConverted || 'undefined',
                onAction: () => console.log('Return value', step.returnValue)
            });
            inspectionMenu.addItem({
                label: 'Return Value',
                icon: window.IconRegistry?.createIcon('mdc:undo'),
                submenu: returnMenu
            });
        }

        if (step.error) {
            const exceptionMenu = window.MenuSystem.MenuManager.createMenu('AIChatComponent.Thinking.InspectorMenu.Exception', {});
            exceptionMenu.addItem({
                label: step.error,
                onAction: () => console.log('Exception', step.error)
            });
            inspectionMenu.addItem({
                label: 'Exception',
                icon: window.IconRegistry?.createIcon('mdc:warning'),
                submenu: exceptionMenu
            });
        }

        inspectionMenu.registerOnCloseCallback(() => {
            inspectionMenu.html.remove();
        });

        return inspectionMenu;
    }, []);

    const renderProgressStep = (step, index) => {
        const isError = step.type?.includes('Exception');

        const handleClick = (evt) => {
            if (!menuOverlay) return;

            const menu = createInspectionMenuForStep(step);

            if (menu) {
                menuOverlay.appendChild(menu.html);
                menu.open({ x: evt.pageX, y: evt.pageY });
                evt.preventDefault();
                evt.stopPropagation();
            }
        };

        return <div
            key={index}
            className={`step ${isError ? 'error' : ''}`}
            title={STEP_HOVER_TEXT[step.type] || ''}
            onContextMenu={(e) => e.preventDefault()}
            onMouseUp={handleClick}
        >
            <span className="icon material-icons-outlined">{STEP_ICONS[step.type] || ''}</span>
            <span className="description">{step.description || ''}</span>
        </div>;
    };

    const progressSteps = Array.isArray(entry.progress) ? entry.progress : [];
    const isProcessing = !entry.hasResult && !entry.cancelled && !entry.exception;
    const hasMultipleProgressSteps = progressSteps.length > 1;
    const visibleProgressSteps = isProgressExpanded ? progressSteps : (isProcessing ? progressSteps.slice(-1) : []);

    // Debounce scrollIntoView to avoid excessive calls during rapid progress updates
    useEffect(() => {
        const timeoutId = setTimeout(() => {
            if (entryRef.current) {
                entryRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
            }
        }, 50);
        return () => clearTimeout(timeoutId);
    }, [entry.content, entry.progress?.length, displayImageItems.length, displayShapeItems.length]);

    return <div
        ref={entryRef}
        className={`entry ${type} ${entry.hasResult ? 'result-available' : ''} ${entry.cancelled ? 'cancelled' : ''} ${entry.exception ? 'exception' : ''}`}
        data-timestamp-epoch={entry.timestampEpoch}
        data-timestamp-iso={entry.timestampIso}
    >
        <div className="thinking">
            {hasMultipleProgressSteps && <button
                type="button"
                className="progress-toggle"
                title={isProgressExpanded ? 'Collapse Progress View' : 'Expand Progress View'}
                onClick={() => setIsProgressExpanded(prev => !prev)}
            >
                <span className="icon material-icons">{isProgressExpanded ? 'expand_less' : 'expand_more'}</span>
                <span className="description">{isProgressExpanded ? 'Hide Progress' : `Show Progress (${progressSteps.length})`}</span>
            </button>}
            {visibleProgressSteps.map((step, index) => renderProgressStep(step, index))}
            {isProcessing && <div className="step processing" title="Processing">
                <span className="spinner-circle" />
            </div>}
        </div>
        <div className="chat">
            <div className="content">{entry.content || ''}</div>
            {displayImageItems.length > 0 && <div className="image-preview-grid">
                {displayImageItems.map((preview, index) => {
                    const normalizedPreviewDataUrl = normalizeImageDataUrl(preview?.dataUrl, preview?.mimeType);
                    return <div
                        key={preview.id || `${entry.id || 'entry'}-preview-${index}`}
                        className={`image-preview-item ${normalizedPreviewDataUrl ? 'with-image' : 'placeholder'}`}
                        title={preview.name || 'Attached image'}
                        onClick={() => openImageInNewTab(preview?.dataUrl, preview?.mimeType)}
                    >
                        {normalizedPreviewDataUrl
                            ? <img src={normalizedPreviewDataUrl} alt={preview.name || 'Attached image'} />
                            : <React.Fragment>
                                <span className="placeholder-icon material-icons">image</span>
                                <span className="placeholder-name">{preview.name || 'Image'}</span>
                            </React.Fragment>}
                    </div>;
                })}
            </div>}
            {displayShapeItems.length > 0 && <div className="shape-preview-grid">
                {displayShapeItems.map((shapeItem, index) => (
                    <ShapePreviewTile
                        key={`${shapeItem.id}-${index}`}
                        shapeItem={shapeItem}
                        className="shape-preview-item"
                        onClick={() => focusShapeInCanvas(shapeItem.id)}
                    />
                ))}
            </div>}
            <div className="tagline">
                <div className="author">{entry.author || ''}</div>
                <div className="timestamp">{entry.timestamp || ''}</div>
            </div>
        </div>
    </div>;
}

function ToolGroupToggle({ group, onToggle }) {
    return <div
        className={`tool-group-toggle ${group.enabled ? 'enabled' : ''}`}
        title={group.description || group.name}
        data-group-key={group.key}
        onClick={() => { onToggle(group.key, !group.enabled) }}
    >
        <span className="icon material-icons">{group.icon}</span>
    </div>;
}

function ToolGroupControls({ toolGroups, onToggle }) {
    const toggleableToolGroups = (Array.isArray(toolGroups) ? toolGroups : [])
        .filter((group) => !group.alwaysEnabled);
    if (toggleableToolGroups.length < 1) {
        return null;
    }

    return <div className="tool-groups">
        {toggleableToolGroups.map(group => (
            <ToolGroupToggle key={group.key} group={group} onToggle={onToggle} />
        ))}
    </div>;
}

function ChatInput({ chatId, persisted, isDisabled, onSubmit, onPasteImages, textareaRef }) {
    const [localText, setLocalText] = useState('');
    const [persistedText, setPersistedText] = useDOMState(`chat-input-${chatId}`, '', AI_CHAT_DOM_STORE_KEY, persisted);

    // For persisted mode, throttle writes so shared chat input updates at most once per second
    const pendingPersistRef = useRef({
        timerId: null,
        latestValue: '',
        hasPendingValue: false,
        lastPersistedAt: 0
    });
    const lastLocalPersistedValueRef = useRef(null);
    // Store localText in a ref for getUserText to access current value synchronously
    const localTextRef = useRef(localText);
    localTextRef.current = localText;

    const flushPendingPersist = useCallback(() => {
        const state = pendingPersistRef.current;
        if (state.timerId) {
            clearTimeout(state.timerId);
            state.timerId = null;
        }
        if (!state.hasPendingValue) {
            return;
        }
        const value = state.latestValue;
        state.hasPendingValue = false;
        state.lastPersistedAt = Date.now();
        lastLocalPersistedValueRef.current = value;
        setPersistedText(value);
    }, [setPersistedText]);

    const throttledPersist = useCallback((value) => {
        const state = pendingPersistRef.current;
        state.latestValue = value;
        state.hasPendingValue = true;

        const now = Date.now();
        const elapsed = state.lastPersistedAt > 0 ? now - state.lastPersistedAt : 0;
        const delay = state.lastPersistedAt > 0 ? Math.max(1000 - elapsed, 0) : 1000;

        if (state.timerId) {
            return;
        }
        state.timerId = setTimeout(() => {
            state.timerId = null;
            flushPendingPersist();
        }, delay);
    }, [flushPendingPersist]);

    useEffect(() => {
        if (!persisted || persistedText === undefined) {
            return;
        }

        const nextValue = persistedText || '';
        const lastLocalPersistedValue = lastLocalPersistedValueRef.current;

        if (lastLocalPersistedValue !== null) {
            lastLocalPersistedValueRef.current = null;
            if (nextValue === lastLocalPersistedValue) {
                return;
            }
        }

        if (pendingPersistRef.current.hasPendingValue || nextValue === localTextRef.current) {
            return;
        }

        setLocalText(nextValue);
        localTextRef.current = nextValue;
    }, [persisted, persistedText]);

    const clearText = useCallback(() => {
        setLocalText('');
        localTextRef.current = '';
        if (persisted) {
            throttledPersist('');
        }
    }, [persisted, throttledPersist]);

    const setUserText = useCallback((text) => {
        const nextValue = typeof text === 'string' ? text : '';
        setLocalText(nextValue);
        localTextRef.current = nextValue;
        if (persisted) {
            throttledPersist(nextValue);
        }
    }, [persisted, throttledPersist]);

    const handleKeyDown = useCallback((event) => {
        if ((event.keyCode === 13 || event.key === 'Enter') && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
        }
    }, [onSubmit]);

    const handleChange = useCallback((e) => {
        const value = e.target.value;
        setLocalText(value);
        localTextRef.current = value;
        if (persisted) {
            throttledPersist(value);
        }
    }, [persisted, throttledPersist]);

    const handlePaste = useCallback((event) => {
        if (typeof onPasteImages !== 'function') {
            return;
        }

        const pastedImageFiles = extractImageFilesFromClipboardData(event.clipboardData);
        if (pastedImageFiles.length < 1) {
            return;
        }

        event.preventDefault();
        onPasteImages(pastedImageFiles);
    }, [onPasteImages]);

    const appendUserText = useCallback((text) => {
        const appended = typeof text === 'string' ? text.trim() : '';
        if (!appended) return;

        const current = localTextRef.current || '';
        const separator = current && !/\s$/.test(current) ? ' ' : '';
        const nextValue = `${current}${separator}${appended}`;

        setLocalText(nextValue);
        localTextRef.current = nextValue;
        if (persisted) {
            throttledPersist(nextValue);
        }
    }, [persisted, throttledPersist]);

    // Expose methods to get and clear the text for external submit - attach once
    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.getUserText = () => localTextRef.current;
            textareaRef.current.clearUserText = clearText;
            textareaRef.current.setUserText = setUserText;
            textareaRef.current.appendUserText = appendUserText;
        }
    }, [textareaRef, clearText, setUserText, appendUserText]);

    useEffect(() => {
        return () => {
            flushPendingPersist();
        };
    }, [flushPendingPersist]);

    return <textarea
        id="ai-usertext"
        ref={textareaRef}
        value={localText}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder="Ask anything ..."
        disabled={isDisabled}
    />;
}

function ChatExportButton({ entries, entryImagePreviews = {} }) {
    const handleExportChat = useCallback(() => {
        const chatData = {
            exportedAt: new Date().toISOString(),
            exportedAtEpoch: Date.now(),
            messages: entries.map((entry, index) => {
                const sanitizedEntry = stripImageDataFromValue(entry) || {};
                const contextImages = extractImageContextMetadata(sanitizedEntry.imageContext);
                const previewImages = extractImageContextMetadata(entryImagePreviews?.[entry?.id] || []);
                const imageContext = contextImages.length > 0 ? contextImages : previewImages;
                const shapeContext = extractShapeContextMetadata(sanitizedEntry.shapeContext);
                return {
                    index,
                    type: sanitizedEntry.type,
                    content: sanitizedEntry.content || '',
                    author: sanitizedEntry.author || '',
                    timestampIso: sanitizedEntry.timestampIso || null,
                    timestampEpoch: sanitizedEntry.timestampEpoch || null,
                    progress: sanitizedEntry.progress || [],
                    imageContext: imageContext,
                    shapeContext: shapeContext
                };
            })
        };

        const jsonString = JSON.stringify(chatData, null, 4);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `chat-export-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, [entries, entryImagePreviews]);

    return entries.length > 0 ? <button className="export-chat" onClick={handleExportChat} title="Export Chat">
        <span className="icon material-icons">download</span>
    </button> : null;
}




export function ChatHistory({
    entries,
    persisted,
    isDisabled,
    menuOverlay,
    entryImagePreviews
}) {
    const historyRef = useRef(null);

    useEffect(() => {
        if (!persisted || !historyRef.current) {
            return;
        }

        requestAnimationFrame(() => {
            if (historyRef.current) {
                historyRef.current.scrollTop = historyRef.current.scrollHeight;
            }
        });
    }, [entries, persisted]);

    return <div className="historical-entries" ref={historyRef}>
        {isDisabled && (
            <div className="disabled-message">
                <span className="icon material-icons">info</span>
                <span className="text">No AI connector configured. Chat is disabled.</span>
            </div>
        )}
        {entries.map(entry => (
            <ChatEntry
                key={entry.id}
                entry={entry}
                type={entry.type}
                menuOverlay={menuOverlay}
                imagePreviews={entryImagePreviews[entry.id] || []}
            />
        ))}
    </div>;
}

export function ChatComposer({
    identity,
    availability,
    context,
    speech,
    tools,
    actions,
    entries,
    entryImagePreviews,
    promptRef
}) {
    return <div className="user-input">
        <div
            className={`input-container${context.isDropActive ? ' drag-active' : ''}`}
            onDragEnter={context.onDragEnter}
            onDragOver={context.onDragOver}
            onDragLeave={context.onDragLeave}
            onDrop={context.onDrop}
        >
            <input
                ref={context.imageInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={context.onImageInputChange}
                style={{ display: 'none' }}
            />
            <ChatInput
                chatId={identity.chatId}
                persisted={identity.persisted}
                isDisabled={availability.isDisabled}
                onSubmit={actions.submit}
                onPasteImages={context.onPasteImages}
                textareaRef={promptRef}
            />
            {context.images.length > 0 && <div className="image-context-bar" title={`${context.images.length} Images Attached`}>
                <span className="icon material-icons">image</span>
                <span className="label"> {context.images.length}</span>
                <div className="preview-list">
                    {context.images.map((contextImage, index) => {
                        const normalizedContextImageDataUrl = normalizeImageDataUrl(contextImage?.dataUrl, contextImage?.mimeType);
                        return <div
                            key={contextImage.id || `pending-image-${index}`}
                            className={`preview-item ${normalizedContextImageDataUrl ? 'with-image' : 'placeholder'}`}
                            title={contextImage.name || 'Attached image'}
                            onClick={() => openImageInNewTab(contextImage?.dataUrl, contextImage?.mimeType)}
                        >
                            {normalizedContextImageDataUrl
                                ? <img src={normalizedContextImageDataUrl} alt={contextImage.name || 'Attached image'} />
                                : <span className="preview-name">{contextImage.name || 'Image'}</span>}
                            <button
                                type="button"
                                className="remove-preview-item"
                                title={`Remove ${contextImage.name || 'attached image'} From Prompt`}
                                onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    context.removeImage(contextImage.id, index);
                                }}
                            >
                                <span className="remove-icon material-icons">close</span>
                            </button>
                        </div>;
                    })}
                </div>
                <button
                    type="button"
                    className="clear-preview-items"
                    title="Remove All Images From Prompt"
                    onClick={context.clearImages}
                >
                    <span className="material-icons">close</span>
                </button>
            </div>}
            {context.shapes.length > 0 && <div className="shape-context-bar" title={`${context.shapes.length} Shapes Attached`}>
                <span className="icon material-icons">category</span>
                <span className="label">{context.shapes.length}</span>
                <div className="preview-list">
                    {context.shapes.map((contextShape, index) => {
                        const shapeItem = createShapePreviewDescriptor(contextShape, index);
                        if (!shapeItem) {
                            return null;
                        }

                        return <ShapePreviewTile
                            key={`${shapeItem.id}-${index}`}
                            shapeItem={shapeItem}
                            className="preview-item shape-placeholder"
                            onClick={() => focusShapeInCanvas(shapeItem.id)}
                            onRemove={() => context.removeShape(shapeItem.id, index)}
                            removeTitle={`Remove ${shapeItem.id} From Prompt`}
                        />;
                    })}
                </div>
                <button
                    type="button"
                    className="clear-preview-items"
                    title="Add Shapes Screenshot to Prompt"
                    onClick={context.captureShapeScreenshot}
                    disabled={availability.isDisabled || availability.isProcessing}
                >
                    <span className="material-icons">photo_camera</span>
                </button>
                <button
                    type="button"
                    className="clear-preview-items"
                    title="Remove All Shapes From Prompt"
                    onClick={context.clearShapes}
                >
                    <span className="material-icons">close</span>
                </button>
            </div>}
            <div className="input-controls">
                <div className="left-controls">
                    {identity.showConnectorEditor || identity.showProfileEditor && (
                        <div className="model-selectors">
                            {identity.showConnectorEditor && identity.connectors.length > 0 && (
                                <div className="connector-config" onClick={actions.openConnectorMenu}>
                                    <span className="icon material-icons">memory</span>
                                    <span className="connector">{identity.currentConnector?.name || 'None'}</span>
                                </div>
                            )}
                            {identity.showProfileEditor && (
                                <div className="profile-config" onClick={actions.openProfileMenu}>
                                    <span className="icon material-icons">psychology</span>
                                    <span className="profile">{identity.currentProfile?.name || 'Select Profile'}</span>
                                </div>
                            )}
                        </div>
                    )}
                    <ToolGroupControls toolGroups={tools.groups} onToggle={tools.toggle} />
                </div>
                <div className="right-controls">
                    <ChatExportButton entries={entries} entryImagePreviews={entryImagePreviews} />
                    {entries.length > 0 && <button className="reset" onClick={actions.reset} title="Reset Profile">
                        <span className="icon material-icons">delete</span>
                    </button>}
                    <button
                        className={`image-context ${context.images.length > 0 ? 'active' : ''}`}
                        onClick={context.openImagePicker}
                        disabled={availability.isDisabled || availability.isProcessing}
                        title={context.images.length > 0
                            ? `Add image context (${context.images.length} attached)`
                            : 'Add image context'}
                    >
                        <span className="icon material-icons">image</span>
                        {context.images.length > 0 && <span className="count">{context.images.length}</span>}
                    </button>
                    <button
                        className={`stt ${speech.isRecording ? 'recording' : ''} ${speech.isTranscribing ? 'transcribing' : ''}`}
                        onClick={speech.toggle}
                        disabled={availability.isDisabled || availability.isProcessing || speech.isTranscribing}
                        title={speech.isRecording ? 'Stop recording' : (speech.isTranscribing ? 'Transcribing...' : 'Speak Prompt')}
                    >
                        <span className="icon material-icons">
                            {speech.isRecording ? 'stop' : (speech.isTranscribing ? 'hourglass_top' : 'mic')}
                        </span>
                    </button>
                    <button
                        className={`send ${availability.isProcessing ? 'loading' : ''}`}
                        onClick={actions.sendOrCancel}
                        disabled={availability.isDisabled || (availability.isProcessing && !availability.isLocalProcessing)}
                        title={availability.isProcessing ? (availability.isLocalProcessing ? 'Stop' : 'Processing remotely...') : 'Send'}
                    >
                        <span className="icon material-icons send-icon">send</span>
                        <span className="spinner"></span>
                        {availability.isLocalProcessing && <span className="icon material-icons stop-icon">stop</span>}
                    </button>
                </div>
            </div>
        </div>
    </div>;
}
