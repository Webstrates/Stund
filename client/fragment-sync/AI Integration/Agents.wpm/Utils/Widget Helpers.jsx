import React from 'react';
const { useState, useEffect, useRef, useCallback } = React;

import { useDOMState as baseUseDOMState } from '#CoreHelpers .dom-store';
import {
    chatCompletion as baseChatCompletion,
    chatCompletionWithSearch as baseChatCompletionWithSearch,
    generateImage as baseGenerateImage,
    generateImageAsset as baseGenerateImageAsset,
    speakText as baseSpeakText,
    transcribeAudioBlob as baseTranscribeAudioBlob,
    recordAudio as baseRecordAudio,
    getTranscriptionSupportedMimeType as baseGetTranscriptionSupportedMimeType,
    webSearch as baseWebSearch
} from '#AIHelpers .default';
import { convertAndValidateShapes as baseConvertAndValidateShapes } from '#CanvasHelpers .default';
import { getModel } from '#ModelManager .default';
import { useSessionIngest } from '#SessionHistory .default';
import {
    createDocumentFragment as baseCreateDocumentFragment,
    getDocumentFragmentTextByFragmentId as baseGetDocumentFragmentTextByFragmentId,
    getDocumentFragmentNameByFragmentId as baseGetDocumentFragmentNameByFragmentId,
    setDocumentFragmentTextByFragmentId as baseSetDocumentFragmentTextByFragmentId,
    setDocumentFragmentNameByFragmentId as baseSetDocumentFragmentNameByFragmentId
} from '#Document .helpers';

export {
    baseWebSearch as webSearch,
    baseRecordAudio as recordAudio,
    baseGetTranscriptionSupportedMimeType as getTranscriptionSupportedMimeType,
    baseConvertAndValidateShapes as convertAndValidateShapes,
    baseCreateDocumentFragment as createDocumentFragment,
    baseGetDocumentFragmentTextByFragmentId as getDocumentFragmentTextByFragmentId,
    baseGetDocumentFragmentNameByFragmentId as getDocumentFragmentNameByFragmentId,
    baseSetDocumentFragmentTextByFragmentId as setDocumentFragmentTextByFragmentId,
    baseSetDocumentFragmentNameByFragmentId as setDocumentFragmentNameByFragmentId
};



// WIDGET DOM STATE HELPERS

const WIDGET_STORE_PARENT_SELECTOR = '#widget-stores';

const ensureWidgetStore = (storeId) => {
    let store = document.querySelector(`[data-store-id="${storeId}"]`);
    if (!store) {
        store = document.createElement('dom-store');
        store.setAttribute('data-store-id', storeId);
        WPMv2.stripProtection(store);
        const parent = document.querySelector(WIDGET_STORE_PARENT_SELECTOR) || document.body;
        parent.appendChild(store);
    }
    return store;
};

export const useDOMState = (key, initialValue = undefined, storeId = 'default') => {
    ensureWidgetStore(storeId);
    return baseUseDOMState(key, initialValue, storeId, true);
};



// AI CHAT, IMAGE, AND SEARCH HELPERS

// Rate limiting: 50,000 completion tokens per 5 minutes
const RATE_LIMIT_TOKENS = 50000;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes in milliseconds
if (!window.tokenUsageLog) window.tokenUsageLog = []; // Array of { timestamp, tokens }

const WIDGET_HISTORY_EVENT_STREAM = 'application.widget.widgetEvent';

const cleanupOldEntries = () => {
    const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
    while (window.tokenUsageLog.length > 0 && window.tokenUsageLog[0].timestamp < cutoff) {
        window.tokenUsageLog.shift();
    }
};

const getCurrentTokenUsage = () => {
    cleanupOldEntries();
    return window.tokenUsageLog.reduce((sum, entry) => sum + entry.tokens, 0);
};

const logTokenUsage = (tokens) => {
    window.tokenUsageLog.push({ timestamp: Date.now(), tokens });
};

const runRateLimitedOperation = async (operationName, execute, extractUsage) => {
    const currentUsage = getCurrentTokenUsage();
    if (currentUsage >= RATE_LIMIT_TOKENS) {
        const error = `Rate limit exceeded: ${currentUsage}/${RATE_LIMIT_TOKENS} completion tokens used in the last 5 minutes. Please wait before making more requests.`;
        console.error(`[${operationName}] ${error}`);
        throw new Error(error);
    }

    const result = await execute();
    const usedTokens = extractUsage(result);
    if (usedTokens > 0) {
        logTokenUsage(usedTokens);
    }
    return result;
};

const estimateTokenCount = (value) => {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) {
        return 0;
    }

    return Math.max(1, Math.ceil(text.length / 4));
};

const getUsageTokenCount = (usage, fallbackText = '') => {
    if (usage && typeof usage === 'object') {
        const totalTokens = Number(usage.total_tokens);
        if (Number.isFinite(totalTokens) && totalTokens > 0) {
            return totalTokens;
        }

        const promptTokens = Number(usage.prompt_tokens);
        const completionTokens = Number(usage.completion_tokens);
        const hasPromptOrCompletionTokens = (
            (Number.isFinite(promptTokens) && promptTokens > 0) ||
            (Number.isFinite(completionTokens) && completionTokens > 0)
        );
        if (hasPromptOrCompletionTokens) {
            const normalizedPromptTokens = Number.isFinite(promptTokens) && promptTokens > 0 ? promptTokens : 0;
            const normalizedCompletionTokens = Number.isFinite(completionTokens) && completionTokens > 0 ? completionTokens : 0;
            return normalizedPromptTokens + normalizedCompletionTokens;
        }

        const outputTokens = Number(usage.output_tokens);
        if (Number.isFinite(outputTokens) && outputTokens > 0) {
            return outputTokens;
        }
    }

    return estimateTokenCount(fallbackText);
};



export const chatCompletion = async (messages, tools, options = {}) => {
    return runRateLimitedOperation(
        'chatCompletion',
        () => baseChatCompletion(messages, getModel('widget-completion'), tools, options),
        result => result?.usage?.completion_tokens || 0
    );
};

export const chatCompletionWithSearch = async (messages, tools, options = {}) => {
    return runRateLimitedOperation(
        'chatCompletionWithSearch',
        () => baseChatCompletionWithSearch(messages, getModel('widget-completion'), tools, options),
        result => result?.usage?.completion_tokens || 0
    );
};

export const generateImage = async (prompt, options = {}) => {
    const {
        width = 1024,
        height = 1024,
        ...requestOptions
    } = options;

    const result = await runRateLimitedOperation(
        'generateImage',
        () => baseGenerateImage(prompt, getModel('widget-image-generation'), width, height, requestOptions),
        response => response?.usage?.output_tokens || 0
    );
    return result?.imageUrl || '';
};

export const generateImageAsset = async (prompt, options = {}) => {
    const {
        width = 1024,
        height = 1024,
        ...requestOptions
    } = options;

    const result = await runRateLimitedOperation(
        'generateImageAsset',
        () => baseGenerateImageAsset(prompt, getModel('widget-image-generation'), width, height, requestOptions),
        response => response?.usage?.output_tokens || 0
    );
    return result?.assetId || null;
};

export const speakText = async (text, options = {}) => {
    const requestOptions = {
        ...(options || {})
    };
    if (!requestOptions.model) {
        requestOptions.model = getModel('widget-text-to-speech');
    }

    return runRateLimitedOperation(
        'speakText',
        () => baseSpeakText(text, requestOptions),
        result => getUsageTokenCount(result?.usage, text)
    );
};

export const transcribeAudio = async (audioBlob, options = {}) => {
    const requestOptions = {
        ...(options || {})
    };
    if (!requestOptions.model) {
        requestOptions.model = getModel('widget-speech-to-text');
    }

    return runRateLimitedOperation(
        'transcribeAudio',
        () => baseTranscribeAudioBlob(audioBlob, requestOptions),
        estimateTokenCount
    );
};

export const getShapesInProximity = (editor, x, y, radius) => {
    if (!editor || typeof editor.getCurrentPageShapes !== 'function') {
        return [];
    }

    const targetX = Number(x);
    const targetY = Number(y);
    const searchRadius = Number(radius);
    if (!Number.isFinite(targetX) || !Number.isFinite(targetY) || !Number.isFinite(searchRadius) || searchRadius < 0) {
        return [];
    }

    const shapes = editor.getCurrentPageShapes() || [];
    const nearbyShapes = shapes.filter((shape) => {
        const bounds = typeof editor.getShapePageBounds === 'function' ? editor.getShapePageBounds(shape) : null;
        const centerX = bounds ? bounds.x + bounds.w / 2 : Number(shape?.x);
        const centerY = bounds ? bounds.y + bounds.h / 2 : Number(shape?.y);

        if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) {
            return false;
        }

        const dx = centerX - targetX;
        const dy = centerY - targetY;
        return Math.sqrt(dx * dx + dy * dy) <= searchRadius;
    });
    return nearbyShapes;
};

const getMimeTypeFromDataUrl = (dataUrl) => {
    if (typeof dataUrl !== 'string') {
        return 'image/png';
    }
    const match = dataUrl.match(/^data:([^;]+);/i);
    return match?.[1] || 'image/png';
};

export const getSelectionScreenshot = async (options = {}) => {
    const editor = window.tldrawEditor;
    if (!editor) {
        throw new Error('tldraw editor not available');
    }

    const {
        format = 'png',
        padding = 0,
        background = editor.getInstanceState().exportBackground
    } = options;

    const selectedShapeIds = editor.getSelectedShapeIds();
    const selectedIds = Array.isArray(selectedShapeIds)
        ? selectedShapeIds
        : Array.from(selectedShapeIds || []);

    if (selectedIds.length < 1) {
        return null;
    }

    const bounds = editor.getSelectionPageBounds();
    if (!bounds || bounds.w <= 0 || bounds.h <= 0) {
        return null;
    }

    if (typeof editor.toImageDataUrl !== 'function') {
        throw new Error('This tldraw version does not expose editor.toImageDataUrl().');
    }

    const imageResult = await editor.toImageDataUrl(selectedIds, {
        format,
        padding,
        background,
        bounds
    });

    const imageUrl = typeof imageResult?.url === 'string' ? imageResult.url.trim() : '';
    if (!imageUrl.startsWith('data:image/')) {
        return null;
    }

    return {
        id: `selected-shapes-screenshot-${crypto.randomUUID()}`,
        name: `Selected Shapes (${selectedIds.length})`,
        mimeType: getMimeTypeFromDataUrl(imageUrl),
        shapeCount: selectedIds.length,
        shapeIds: selectedIds,
        width: Math.round(bounds.w),
        height: Math.round(bounds.h),
        dataUrl: imageUrl
    };
};

export const chatCompletionWithImages = async (messages, images, tools, options = {}) => {
    const normalizedImages = Array.isArray(images) ? images : (images ? [images] : []);
    if (normalizedImages.length < 1) {
        return chatCompletion(messages, tools, options);
    }

    const processedMessages = messages.map((message) => {
        if (message.role !== 'user' || typeof message.content !== 'string') {
            return message;
        }

        const contentParts = [{ type: 'text', text: message.content }];

        for (const image of normalizedImages) {
            const imageUrl = typeof image === 'string' ? image : image?.dataUrl;
            if (!imageUrl || !imageUrl.startsWith('data:image/')) {
                continue;
            }

            const detail = image?.detail || 'auto';
            contentParts.push({
                type: 'image_url',
                image_url: {
                    url: imageUrl,
                    detail: detail === 'low' || detail === 'high' ? detail : 'auto'
                }
            });
        }

        return { ...message, content: contentParts };
    });

    return runRateLimitedOperation(
        'chatCompletionWithImages',
        () => baseChatCompletion(processedMessages, getModel('widget-completion'), tools, options),
        result => result?.usage?.completion_tokens || 0
    );
};


// WIDGET HISTORY EVENT HELPERS

export const useHistoryModelWidgetEventStream = () => {
    const ingest = useSessionIngest();
    const streamRef = useRef(null);

    useEffect(() => {
        let isUnmounted = false;

        if (!ingest) {
            streamRef.current = null;
            return;
        }

        streamRef.current = null;
        ingest.startEventStream(WIDGET_HISTORY_EVENT_STREAM).then((stream) => {
            if (!isUnmounted) {
                streamRef.current = stream;
            }
        }).catch((error) => {
            console.error('[useHistoryModelWidgetEventStream] Failed to initialize widget event stream:', error);
        });

        return () => {
            isUnmounted = true;
            streamRef.current = null;
        };
    }, [ingest]);

    const addEvent = useCallback(async (type, data = {}) => {
        const normalizedType = typeof type === 'string' ? type.trim() : '';
        if (!normalizedType) {
            throw new Error('Widget event type must be a non-empty string.');
        }

        const stream = streamRef.current;
        if (!stream) {
            throw new Error('Widget event stream is not ready yet. Wait for useHistoryModelWidgetEventStream() to initialize.');
        }

        stream.createInstantEvent({
            type: normalizedType,
            data: data === undefined ? null : data
        });
    }, []);

    return { addEvent };
};



// COLLOBARATIVE INPUT HELPERS

const getSharedFieldKey = (prefix, id) => {
    const suffix = id ? String(id) : 'default';
    return `${prefix}-${suffix}`;
};

const remapSelectionIndex = (previousValue, nextValue, index) => {
    const oldText = typeof previousValue === 'string' ? previousValue : '';
    const newText = typeof nextValue === 'string' ? nextValue : '';

    if (typeof index !== 'number') return 0;
    if (oldText === newText) return Math.min(index, newText.length);

    const clampedIndex = Math.max(0, Math.min(index, oldText.length));

    let prefixLength = 0;
    const maxPrefixLength = Math.min(oldText.length, newText.length);
    while (prefixLength < maxPrefixLength && oldText[prefixLength] === newText[prefixLength]) {
        prefixLength += 1;
    }

    let oldSuffixStart = oldText.length;
    let newSuffixStart = newText.length;
    while (
        oldSuffixStart > prefixLength &&
        newSuffixStart > prefixLength &&
        oldText[oldSuffixStart - 1] === newText[newSuffixStart - 1]
    ) {
        oldSuffixStart -= 1;
        newSuffixStart -= 1;
    }

    if (clampedIndex <= prefixLength) {
        return clampedIndex;
    }

    if (clampedIndex >= oldSuffixStart) {
        const delta = newSuffixStart - oldSuffixStart;
        return Math.max(0, Math.min(clampedIndex + delta, newText.length));
    }

    return newSuffixStart;
};

const useSharedField = (stateKey, initialValue, options = {}) => {
    const { debounceMs = 300, externalRef = null } = options;

    const [localValue, setLocalValue] = useState(initialValue || '');
    const [persistedValue, setPersistedValue] = useDOMState(stateKey, initialValue || '', fragmentSelfReference?.element?.id || 'default');
    const localRef = useRef(null);
    const persistTimeoutRef = useRef(null);

    const inputRef = useCallback((node) => {
        localRef.current = node;
        if (!externalRef) return;
        if (typeof externalRef === 'function') {
            externalRef(node);
            return;
        }
        externalRef.current = node;
    }, [externalRef]);

    const persistValue = useCallback((value, immediate = false) => {
        const nextValue = typeof value === 'string' ? value : '';

        if (persistTimeoutRef.current) {
            clearTimeout(persistTimeoutRef.current);
            persistTimeoutRef.current = null;
        }

        if (immediate || debounceMs <= 0) {
            setPersistedValue(nextValue);
            return;
        }

        persistTimeoutRef.current = setTimeout(() => {
            setPersistedValue(nextValue);
            persistTimeoutRef.current = null;
        }, debounceMs);
    }, [debounceMs, setPersistedValue]);

    useEffect(() => {
        if (persistedValue === undefined) return;

        const input = localRef.current;
        const selectionStart = input?.selectionStart;
        const selectionEnd = input?.selectionEnd;
        const hadFocus = input && document.activeElement === input;
        const previousValue = input?.value || '';
        const nextValue = typeof persistedValue === 'string' ? persistedValue : '';

        setLocalValue(nextValue);

        if (input && hadFocus && selectionStart !== undefined) {
            requestAnimationFrame(() => {
                const remappedStart = remapSelectionIndex(previousValue, nextValue, selectionStart);
                const remappedEnd = remapSelectionIndex(previousValue, nextValue, selectionEnd ?? selectionStart);
                input.setSelectionRange(remappedStart, remappedEnd);
                input.focus();
            });
        }
    }, [persistedValue]);

    useEffect(() => {
        return () => {
            if (persistTimeoutRef.current) {
                clearTimeout(persistTimeoutRef.current);
            }
        };
    }, []);

    const onSharedChange = useCallback((eventOrValue) => {
        const nextValue = typeof eventOrValue === 'string' ? eventOrValue : eventOrValue?.target?.value;
        const normalizedValue = typeof nextValue === 'string' ? nextValue : '';
        setLocalValue(normalizedValue);
        persistValue(normalizedValue);
    }, [persistValue]);

    const onSharedBlur = useCallback((eventOrValue) => {
        const nextValue = typeof eventOrValue === 'string' ? eventOrValue : eventOrValue?.target?.value;
        const fallbackValue = localRef.current?.value || '';
        persistValue(typeof nextValue === 'string' ? nextValue : fallbackValue, true);
    }, [persistValue]);

    return {
        value: localValue || '',
        ref: inputRef,
        onSharedChange,
        onSharedBlur
    };
};

export const SharedTextArea = React.forwardRef(function SharedTextArea({
    id,
    initialValue = '',
    debounceMs = 300,
    domStoreKeyPrefix = 'shared-textarea',
    onChange,
    onBlur,
    ...props
}, forwardedRef) {
    const stateKey = getSharedFieldKey(domStoreKeyPrefix, id);
    const { value, ref, onSharedChange, onSharedBlur } = useSharedField(stateKey, initialValue, { debounceMs, externalRef: forwardedRef });

    const handleChange = useCallback((event) => {
        onSharedChange(event);
        if (onChange) {
            onChange(event);
        }
    }, [onSharedChange, onChange]);

    const handleBlur = useCallback((event) => {
        onSharedBlur(event);
        if (onBlur) {
            onBlur(event);
        }
    }, [onSharedBlur, onBlur]);

    return <textarea
        {...props}
        ref={ref}
        value={value}
        onChange={handleChange}
        onBlur={handleBlur}
    />;
});

export const SharedInput = React.forwardRef(function SharedInput({
    id,
    initialValue = '',
    debounceMs = 300,
    domStoreKeyPrefix = 'shared-input',
    onChange,
    onBlur,
    type = 'text',
    ...props
}, forwardedRef) {
    const stateKey = getSharedFieldKey(domStoreKeyPrefix, id);
    const { value, ref, onSharedChange, onSharedBlur } = useSharedField(stateKey, initialValue, { debounceMs, externalRef: forwardedRef });

    const handleChange = useCallback((event) => {
        onSharedChange(event);
        if (onChange) {
            onChange(event);
        }
    }, [onSharedChange, onChange]);

    const handleBlur = useCallback((event) => {
        onSharedBlur(event);
        if (onBlur) {
            onBlur(event);
        }
    }, [onSharedBlur, onBlur]);

    return <input
        {...props}
        ref={ref}
        type={type}
        value={value}
        onChange={handleChange}
        onBlur={handleBlur}
    />;
});
