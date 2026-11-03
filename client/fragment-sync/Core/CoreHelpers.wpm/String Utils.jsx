export const toTrimmedString = (value) => {
    if (value === null || value === undefined) {
        return '';
    }
    return String(value).trim();
};

export const toKey = (value) => {
    return toTrimmedString(value).toLowerCase();
};

export const safeJsonParse = (rawValue, fallback = null) => {
    if (rawValue === null || rawValue === undefined) {
        return fallback;
    }

    try {
        return JSON.parse(rawValue);
    } catch (error) {
        return fallback;
    }
};

const parseLastJsonObject = (rawValue, acceptsValue) => {
    const isAccepted = (value) => value && typeof value === 'object'
        && !Array.isArray(value) && acceptsValue(value);
    const parsedValue = safeJsonParse(rawValue);
    if (isAccepted(parsedValue)) return parsedValue;

    let lastValue = null;
    let start = 0;
    let depth = 0;
    let inString = false;
    let escaped = false;

    // Concurrent textContent replacements can leave adjacent complete objects.
    // Find their boundaries without treating braces in Markdown as JSON objects.
    for (let index = 0; index < rawValue.length; index++) {
        const character = rawValue[index];
        if (depth === 0) {
            if (/\s/.test(character)) continue;
            if (character !== '{') break;
            start = index;
            depth = 1;
            continue;
        }
        if (inString) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') inString = false;
            continue;
        }
        if (character === '"') inString = true;
        else if (character === '{') depth++;
        else if (character === '}') {
            depth--;
            if (depth === 0) {
                const value = safeJsonParse(rawValue.slice(start, index + 1));
                if (isAccepted(value)) lastValue = value;
            }
        }
    }
    return lastValue;
};

export const readLastJsonObject = (element, acceptsValue = () => true) => {
    if (!element) return null;
    // Read the last complete value without joining concurrent text-node writes.
    for (let index = element.childNodes.length - 1; index >= 0; index--) {
        const child = element.childNodes[index];
        if (child.nodeType !== 3) continue;
        const candidate = parseLastJsonObject(child.textContent || '', acceptsValue);
        if (candidate) return candidate;
    }
    return parseLastJsonObject(element.textContent || '', acceptsValue);
};

export const safeJsonStringify = (value, fallback = '', space = undefined) => {
    try {
        return JSON.stringify(value, null, space);
    } catch (error) {
        return fallback;
    }
};
