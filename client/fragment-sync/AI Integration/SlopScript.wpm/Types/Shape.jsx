const DEFAULT_IMAGE_MIME_TYPE = 'image/png';

const isDataUrl = (value) => {
    return typeof value === 'string' && value.startsWith('data:image/');
};

const parseDataUrlMimeType = (dataUrl) => {
    if (!isDataUrl(dataUrl)) {
        return DEFAULT_IMAGE_MIME_TYPE;
    }

    const mimeMatch = dataUrl.match(/^data:([^;]+);base64,/i);
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

    return base64ToBlob(base64, parseDataUrlMimeType(dataUrl));
};

const cloneJSONValue = (value) => {
    if (value === null || value === undefined) {
        return value;
    }

    try {
        const seen = new WeakSet();
        const serialized = JSON.stringify(value, (key, nextValue) => {
            if (typeof nextValue === 'function') {
                return undefined;
            }
            if (typeof nextValue === 'object' && nextValue !== null) {
                if (seen.has(nextValue)) {
                    return undefined;
                }
                seen.add(nextValue);
            }
            return nextValue;
        });
        return serialized ? JSON.parse(serialized) : null;
    } catch (error) {
        return null;
    }
};

const assertSingleShapeValue = (value) => {
    if (Array.isArray(value)) {
        throw new Error('Shape type expects a single shape object. Use an array schema with items { type: "shape" } for multiple shapes.');
    }

    if (value && typeof value === 'object' && Array.isArray(value.shapes)) {
        throw new Error('Shape type does not support a "shapes" field anymore. Use an array schema with items { type: "shape" }.');
    }
};

const normalizeSingleShapeEntry = (value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Shape input at index ${index} must be an object.`);
    }

    const clonedShape = cloneJSONValue(value);
    if (!clonedShape || typeof clonedShape !== 'object') {
        throw new Error(`Shape input at index ${index} is not serializable.`);
    }

    if (typeof clonedShape.id !== 'string' || !clonedShape.id.trim()) {
        clonedShape.id = `shape-${index + 1}`;
    }
    if (typeof clonedShape.type !== 'string' || !clonedShape.type.trim()) {
        clonedShape.type = 'unknown';
    }

    return clonedShape;
};

const fetchImageBlobFromUrl = async (url) => {
    if (typeof url !== 'string' || !url.trim()) {
        return null;
    }

    const response = await fetch(url.trim());
    if (!response.ok) {
        throw new Error(`Could not load image URL (${response.status})`);
    }

    return await response.blob();
};

const getEditorFromContext = (context = {}) => {
    if (context?.editor && typeof context.editor === 'object') {
        return context.editor;
    }

    if (typeof window !== 'undefined' && window.tldrawEditor) {
        return window.tldrawEditor;
    }

    return null;
};

const tryResolveImageBlobFromAsset = async (shapeValue, editor) => {
    const assetId = shapeValue?.props?.assetId;
    if (!assetId || !editor || typeof editor.getAsset !== 'function') {
        return null;
    }

    const asset = editor.getAsset(assetId);
    if (!asset || typeof asset !== 'object') {
        return null;
    }

    if (asset.blob instanceof Blob) {
        return {
            blob: asset.blob,
            mimeType: asset.blob.type || DEFAULT_IMAGE_MIME_TYPE
        };
    }

    const srcCandidates = [
        asset?.props?.src,
        asset?.props?.url,
        asset?.src,
        asset?.url
    ].filter((candidate) => typeof candidate === 'string' && candidate.trim());

    for (const candidate of srcCandidates) {
        if (isDataUrl(candidate)) {
            return {
                blob: dataUrlToBlob(candidate),
                mimeType: parseDataUrlMimeType(candidate)
            };
        }

        try {
            const blob = await fetchImageBlobFromUrl(candidate);
            if (blob) {
                return {
                    blob: blob,
                    mimeType: blob.type || DEFAULT_IMAGE_MIME_TYPE
                };
            }
        } catch (error) {
            console.warn('Failed loading image asset URL for shape context:', error);
        }
    }

    return null;
};

const tryResolveImageBlobFromShapeUrl = async (shapeValue) => {
    const imageUrl = typeof shapeValue?.props?.url === 'string' ? shapeValue.props.url.trim() : '';
    if (!imageUrl) {
        return null;
    }

    if (isDataUrl(imageUrl)) {
        return {
            blob: dataUrlToBlob(imageUrl),
            mimeType: parseDataUrlMimeType(imageUrl)
        };
    }

    const blob = await fetchImageBlobFromUrl(imageUrl);
    if (!blob) {
        return null;
    }

    return {
        blob: blob,
        mimeType: blob.type || DEFAULT_IMAGE_MIME_TYPE
    };
};

const tryResolveImageBlobFromScreenshot = async (shapeValue, editor) => {
    if (!editor || typeof editor.toImageDataUrl !== 'function' || !shapeValue?.id) {
        return null;
    }

    try {
        const imageResult = await editor.toImageDataUrl([shapeValue.id], {
            format: 'png',
            padding: 0
        });
        const imageUrl = typeof imageResult?.url === 'string' ? imageResult.url.trim() : '';
        if (!isDataUrl(imageUrl)) {
            return null;
        }
        return {
            blob: dataUrlToBlob(imageUrl),
            mimeType: parseDataUrlMimeType(imageUrl)
        };
    } catch (error) {
        console.warn('Failed generating screenshot image for shape context:', error);
        return null;
    }
};

const resolveImageBlobFromShape = async (shapeValue, context = {}) => {
    if (shapeValue?.imageData instanceof Blob) {
        return {
            blob: shapeValue.imageData,
            mimeType: shapeValue.imageData.type || DEFAULT_IMAGE_MIME_TYPE
        };
    }

    const directDataUrl = typeof shapeValue?.imageDataUrl === 'string'
        ? shapeValue.imageDataUrl.trim()
        : typeof shapeValue?.dataUrl === 'string'
            ? shapeValue.dataUrl.trim()
            : '';
    if (isDataUrl(directDataUrl)) {
        return {
            blob: dataUrlToBlob(directDataUrl),
            mimeType: parseDataUrlMimeType(directDataUrl)
        };
    }

    try {
        const blobFromShapeUrl = await tryResolveImageBlobFromShapeUrl(shapeValue);
        if (blobFromShapeUrl) {
            return blobFromShapeUrl;
        }
    } catch (error) {
        console.warn('Failed loading image URL from shape context:', error);
    }

    const editor = getEditorFromContext(context);

    const blobFromAsset = await tryResolveImageBlobFromAsset(shapeValue, editor);
    if (blobFromAsset) {
        return blobFromAsset;
    }

    const blobFromScreenshot = await tryResolveImageBlobFromScreenshot(shapeValue, editor);
    if (blobFromScreenshot) {
        return blobFromScreenshot;
    }

    return null;
};

const mapShapeToMetadata = (shapeValue, shapeRef, hasImageAttachment) => {
    return {
        ref: shapeRef,
        id: shapeValue.id,
        type: shapeValue.type,
        x: typeof shapeValue.x === 'number' ? shapeValue.x : null,
        y: typeof shapeValue.y === 'number' ? shapeValue.y : null,
        rotation: typeof shapeValue.rotation === 'number' ? shapeValue.rotation : null,
        opacity: typeof shapeValue.opacity === 'number' ? shapeValue.opacity : null,
        hasImageAttachment: Boolean(hasImageAttachment)
    };
};

export class shape {
    static getJSONSchema() {
        return {
            type: 'object',
            description: 'Single shape context object.',
            properties: {
                id: {
                    type: 'string',
                    description: 'Unique shape identifier.'
                },
                type: {
                    type: 'string',
                    description: 'Shape type (for example note, text, geo, image, draw, Widget).'
                },
                x: {
                    type: 'number',
                    description: 'X position on canvas.'
                },
                y: {
                    type: 'number',
                    description: 'Y position on canvas.'
                },
                rotation: {
                    type: 'number',
                    description: 'Rotation in radians.'
                },
                opacity: {
                    type: 'number',
                    description: 'Opacity value.'
                },
                props: {
                    type: 'object',
                    description: 'Shape-specific properties.'
                }
            },
            additionalProperties: true
        };
    }

    static async normalizeForPrompt(value, context = {}) {
        assertSingleShapeValue(value);
        const normalizedShape = normalizeSingleShapeEntry(value, 0);
        const paramName = context.paramName || 'shape';
        const shapeType = typeof normalizedShape.type === 'string'
            ? normalizedShape.type.trim().toLowerCase()
            : '';

        let imageAttachment = null;
        if (shapeType === 'image') {
            const resolvedImage = await resolveImageBlobFromShape(normalizedShape, context);
            if (resolvedImage?.blob instanceof Blob) {
                imageAttachment = {
                    blob: resolvedImage.blob,
                    mimeType: resolvedImage.mimeType || DEFAULT_IMAGE_MIME_TYPE
                };
            }
        }

        return {
            shapeRef: paramName,
            argumentName: context.paramName || null,
            argumentIndex: Number.isInteger(context.paramIndex) ? context.paramIndex : null,
            shape: normalizedShape,
            imageAttachment: imageAttachment
        };
    }

    static async prepareValueForPrompt(value, context = {}) {
        const normalizedShape = await shape.normalizeForPrompt(value, context);
        const valueForPrompt = {
            type: 'shape',
            ...mapShapeToMetadata(normalizedShape.shape, normalizedShape.shapeRef, normalizedShape.imageAttachment),
            shape: normalizedShape.shape
        };

        const attachments = normalizedShape.imageAttachment?.blob instanceof Blob
            ? [{
                shapeRef: normalizedShape.shapeRef,
                shapeId: normalizedShape.shape.id,
                shapeType: normalizedShape.shape.type,
                blob: normalizedShape.imageAttachment.blob,
                mimeType: normalizedShape.imageAttachment.mimeType,
                detail: normalizedShape.imageAttachment.detail,
                contentPart: {
                    type: 'image_blob',
                    blob: normalizedShape.imageAttachment.blob,
                    mimeType: normalizedShape.imageAttachment.mimeType,
                    detail: normalizedShape.imageAttachment.detail
                }
            }]
            : [];

        return {
            valueForPrompt: valueForPrompt,
            attachments: attachments
        };
    }

    static async getValueFromJSON(value) {
        assertSingleShapeValue(value);
        const normalizedShape = await shape.normalizeForPrompt(value, {
            paramName: 'shape',
            paramIndex: 0
        });

        const mappedShape = cloneJSONValue(normalizedShape.shape) || normalizedShape.shape;
        if (normalizedShape.imageAttachment?.blob instanceof Blob) {
            mappedShape.imageDataUrl = await blobToDataUrl(normalizedShape.imageAttachment.blob);
        }
        return mappedShape;
    }
}
