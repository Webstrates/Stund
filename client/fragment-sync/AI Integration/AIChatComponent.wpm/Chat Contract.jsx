import { hasImageDataUrl } from '#AIChatComponent .image-context';
import { extractShapeContextMetadata } from '#AIChatComponent .shape-context';

export const AI_CHAT_DOM_STORE_KEY = 'ai-chat';
export const AI_CHAT_ENTRY_EVENT = 'ai-chat-entry-finalized';
export const AI_CHAT_STEP_EVENT = 'ai-chat-step-added';

/**
 * @typedef {Object} ChatImageContext
 * @property {string} id
 * @property {string} name
 * @property {string} mimeType
 * @property {number|null} sizeBytes
 * @property {string} dataUrl
 */

/**
 * @typedef {Object} ChatShapeContext
 * @property {string} id
 * @property {string} type
 * @property {Object} props
 */

/**
 * @typedef {Object} ChatProgressStep
 * @property {string} type
 * @property {string} description
 * @property {string} timestampIso
 * @property {number} timestampEpoch
 */

/**
 * @typedef {Object} ChatEntry
 * @property {string} id
 * @property {'user'|'assistant'} type
 * @property {string} content
 * @property {boolean} hasResult
 * @property {ChatProgressStep[]} progress
 */

/**
 * @typedef {Object} ChatSubmitCommand
 * @property {string} text
 * @property {ChatImageContext[]} images
 * @property {ChatShapeContext[]} shapes
 */

export const safeStringify = (obj, fallback = '[Circular or non-serializable]') => {
    try {
        const ancestors = [];
        return JSON.stringify(obj, function (key, value) {
            if (typeof value === 'object' && value !== null) {
                while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
                    ancestors.pop();
                }
                if (ancestors.includes(value)) {
                    return '[Circular]';
                }
                ancestors.push(value);
            }
            if (typeof value === 'function') {
                return value.isInvokableTool ? `[Tool: ${value.context?.name}]` : '[Function]';
            }
            return value;
        });
    } catch (e) {
        return fallback;
    }
};

export const safeClone = (obj, fallback = null) => {
    try {
        const serialized = safeStringify(obj);
        return JSON.parse(serialized);
    } catch (e) {
        return fallback;
    }
};

export const normalizePromptResult = (resultValue) => {
    if (typeof resultValue === 'string') {
        return {
            content: resultValue,
            shapeContext: []
        };
    }

    if (resultValue === undefined || resultValue === null) {
        return {
            content: '',
            shapeContext: []
        };
    }

    if (typeof resultValue !== 'object' || Array.isArray(resultValue)) {
        return {
            content: String(resultValue),
            shapeContext: []
        };
    }

    const rawContentValue = resultValue.content !== undefined
        ? resultValue.content
        : resultValue.message !== undefined
            ? resultValue.message
            : resultValue.text !== undefined
                ? resultValue.text
                : '';
    const normalizedContent = typeof rawContentValue === 'string'
        ? rawContentValue
        : rawContentValue === undefined || rawContentValue === null
            ? ''
            : safeStringify(rawContentValue, String(rawContentValue));

    const rawShapeContext = Array.isArray(resultValue.shapeContext)
        ? resultValue.shapeContext
        : resultValue.shapeContext && typeof resultValue.shapeContext === 'object' && Array.isArray(resultValue.shapeContext.shapes)
            ? resultValue.shapeContext.shapes
            : resultValue.shapeContext && typeof resultValue.shapeContext === 'object' && Array.isArray(resultValue.shapeContext.shapeIds)
                ? resultValue.shapeContext.shapeIds
                : Array.isArray(resultValue.shapes)
                    ? resultValue.shapes
                    : Array.isArray(resultValue.shapeIds)
                        ? resultValue.shapeIds
                        : [];

    const normalizedShapeInput = rawShapeContext
        .map((shapeValue) => {
            if (typeof shapeValue === 'string') {
                return shapeValue.trim();
            }

            if (!shapeValue || typeof shapeValue !== 'object') {
                return null;
            }

            return shapeValue.shape && typeof shapeValue.shape === 'object'
                ? shapeValue.shape
                : shapeValue;
        })
        .filter(Boolean);

    return {
        content: normalizedContent,
        shapeContext: extractShapeContextMetadata(normalizedShapeInput)
    };
};


export const stripImageDataFromValue = (value, seen = new WeakMap()) => {
    if (value === null || value === undefined) {
        return value;
    }

    if (typeof value === 'string') {
        return hasImageDataUrl(value) ? '[image data omitted]' : value;
    }

    if (typeof value !== 'object') {
        return value;
    }

    if (value instanceof Blob) {
        return '[binary data omitted]';
    }

    if (seen.has(value)) {
        return seen.get(value);
    }

    if (Array.isArray(value)) {
        const sanitizedArray = [];
        seen.set(value, sanitizedArray);
        value.forEach((item) => {
            sanitizedArray.push(stripImageDataFromValue(item, seen));
        });
        return sanitizedArray;
    }

    const sanitizedObject = {};
    seen.set(value, sanitizedObject);

    Object.entries(value).forEach(([key, itemValue]) => {
        if (key === 'dataUrl' || key === 'imageDataUrl' || key === 'blob' || key === 'file') {
            return;
        }
        sanitizedObject[key] = stripImageDataFromValue(itemValue, seen);
    });

    return sanitizedObject;
};

export const sanitizeEntriesForSharedPersistence = (entries) => {
    const sourceEntries = Array.isArray(entries) ? entries : [];
    return sourceEntries.map((entry) => {
        return stripImageDataFromValue(entry);
    });
};
