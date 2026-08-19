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

export const safeJsonStringify = (value, fallback = '', space = undefined) => {
    try {
        return JSON.stringify(value, null, space);
    } catch (error) {
        return fallback;
    }
};
