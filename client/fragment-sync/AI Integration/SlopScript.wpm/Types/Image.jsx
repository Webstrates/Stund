const DEFAULT_IMAGE_MIME_TYPE = 'image/png';

const isDataUrl = (value) => {
    return typeof value === 'string' && value.startsWith('data:image/');
};

const parseDataUrlMimeType = (dataUrl) => {
    if (!isDataUrl(dataUrl)) {
        return DEFAULT_IMAGE_MIME_TYPE;
    }

    const mimeMatch = dataUrl.match(/^data:([^;]+);base64,/);
    return mimeMatch?.[1] || DEFAULT_IMAGE_MIME_TYPE;
};

const blobToDataUrl = (blob) => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Failed to read image blob'));
        reader.readAsDataURL(blob);
    });
};

const base64ToBlob = (base64, mimeType = DEFAULT_IMAGE_MIME_TYPE) => {
    if (typeof base64 !== 'string' || !base64.trim()) {
        throw new Error('Base64 image data must be a non-empty string');
    }

    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType || DEFAULT_IMAGE_MIME_TYPE });
};

const dataUrlToBlob = (dataUrl) => {
    if (!isDataUrl(dataUrl)) {
        throw new Error('Expected an image data URL');
    }

    const [header, base64] = dataUrl.split(',');
    if (!header || !base64) {
        throw new Error('Invalid image data URL');
    }

    const mimeType = parseDataUrlMimeType(dataUrl);
    return base64ToBlob(base64, mimeType);
};

const assertSingleImageValue = (value) => {
    if (Array.isArray(value)) {
        throw new Error('Image type expects a single value. Use an array schema with items { type: "image" } for multiple images.');
    }

    if (value && typeof value === 'object' && Array.isArray(value.images)) {
        throw new Error('Image type does not support an "images" field anymore. Use an array schema with items { type: "image" }.');
    }
};

const normalizeSingleImageEntry = async (value) => {
    if (value === null || value === undefined) {
        throw new Error('Image input is missing');
    }

    if (typeof value === 'string') {
        const trimmedValue = value.trim();
        if (!trimmedValue) {
            throw new Error('Image input string is empty');
        }

        if (isDataUrl(trimmedValue)) {
            return {
                blob: dataUrlToBlob(trimmedValue),
                mimeType: parseDataUrlMimeType(trimmedValue),
                name: 'Image',
                detail: 'auto',
                source: 'dataUrl'
            };
        }

        const response = await fetch(trimmedValue);
        if (!response.ok) {
            throw new Error(`Could not load image URL (${response.status})`);
        }

        const blob = await response.blob();
        return {
            blob: blob,
            mimeType: blob.type || DEFAULT_IMAGE_MIME_TYPE,
            name: 'Image',
            detail: 'auto',
            source: 'url'
        };
    }

    if (value instanceof Blob) {
        return {
            blob: value,
            mimeType: value.type || DEFAULT_IMAGE_MIME_TYPE,
            name: value.name || 'Image',
            detail: 'auto',
            source: 'blob'
        };
    }

    if (typeof value === 'object') {
        const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : 'Image';

        if (value.blob instanceof Blob) {
            return {
                blob: value.blob,
                mimeType: value.mimeType || value.blob.type || DEFAULT_IMAGE_MIME_TYPE,
                name: name,
                source: 'blob-object'
            };
        }

        if (value.file instanceof Blob) {
            return {
                blob: value.file,
                mimeType: value.mimeType || value.file.type || DEFAULT_IMAGE_MIME_TYPE,
                name: name || value.file.name || 'Image',
                source: 'file-object'
            };
        }

        if (typeof value.dataUrl === 'string' && isDataUrl(value.dataUrl)) {
            const blob = dataUrlToBlob(value.dataUrl);
            return {
                blob: blob,
                mimeType: value.mimeType || parseDataUrlMimeType(value.dataUrl),
                name: name,
                source: 'dataUrl-object'
            };
        }

        if (typeof value.base64 === 'string' && value.base64.trim()) {
            const mimeType = value.mimeType || DEFAULT_IMAGE_MIME_TYPE;
            return {
                blob: base64ToBlob(value.base64, mimeType),
                mimeType: mimeType,
                name: name,
                source: 'base64'
            };
        }

        if (typeof value.url === 'string' && value.url.trim()) {
            return await normalizeSingleImageEntry(value.url.trim());
        }
    }

    throw new Error('Unsupported image input. Expected Blob, data URL, URL, or image descriptor object.');
};

export class image {
    static getJSONSchema() {
        return {
            type: 'object',
            description: 'Single image input. Supports dataUrl, base64+mimeType, URL, Blob wrapper, or file/blob object.',
            properties: {
                dataUrl: {
                    type: 'string',
                    description: 'Image as a base64 data URL, e.g. data:image/png;base64,...'
                },
                base64: {
                    type: 'string',
                    description: 'Base64 encoded image bytes without the data URL prefix.'
                },
                mimeType: {
                    type: 'string',
                    description: 'MIME type for base64 image data.'
                },
                url: {
                    type: 'string',
                    description: 'URL to an image that can be fetched.'
                },
                name: {
                    type: 'string',
                    description: 'Optional image name.'
                }
            },
            additionalProperties: true
        };
    }

    static async normalizeForPrompt(value, context = {}) {
        assertSingleImageValue(value);
        const normalizedImage = await normalizeSingleImageEntry(value);
        const paramName = context.paramName || 'image';

        return {
            imageRef: paramName,
            argumentName: context.paramName || null,
            argumentIndex: Number.isInteger(context.paramIndex) ? context.paramIndex : null,
            name: normalizedImage.name || 'Image',
            mimeType: normalizedImage.mimeType || DEFAULT_IMAGE_MIME_TYPE,
            sizeBytes: normalizedImage.blob?.size || null,
            source: normalizedImage.source || 'unknown',
            blob: normalizedImage.blob
        };
    }

    static async prepareValueForPrompt(value, context = {}) {
        const normalizedImage = await image.normalizeForPrompt(value, context);
        const valueForPrompt = {
            type: 'image',
            ref: normalizedImage.imageRef,
            name: normalizedImage.name || null,
            mimeType: normalizedImage.mimeType || DEFAULT_IMAGE_MIME_TYPE,
            sizeBytes: normalizedImage.sizeBytes
        };

        const attachments = [{
            ...normalizedImage,
            contentPart: {
                type: 'image_blob',
                blob: normalizedImage.blob,
                mimeType: normalizedImage.mimeType || DEFAULT_IMAGE_MIME_TYPE
            }
        }];

        return {
            valueForPrompt: valueForPrompt,
            attachments: attachments
        };
    }

    static async getValueFromJSON(value) {
        assertSingleImageValue(value);
        const normalizedImage = await image.normalizeForPrompt(value, {
            paramName: 'image',
            paramIndex: 0
        });

        return {
            name: normalizedImage.name,
            mimeType: normalizedImage.mimeType,
            sizeBytes: normalizedImage.sizeBytes,
            dataUrl: await blobToDataUrl(normalizedImage.blob),
            blob: normalizedImage.blob
        };
    }
}
