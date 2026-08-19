import { toRichText } from 'tldraw';



const isPlainObject = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }

    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
};

const deepMergeObjects = (baseValue, overrideValue) => {
    if (!isPlainObject(baseValue) || !isPlainObject(overrideValue)) {
        return overrideValue;
    }

    const merged = { ...baseValue };

    for (const [key, value] of Object.entries(overrideValue)) {
        if (isPlainObject(value) && isPlainObject(baseValue[key])) {
            merged[key] = deepMergeObjects(baseValue[key], value);
        } else {
            merged[key] = value;
        }
    }

    return merged;
};

const normalizeShapeList = (shapes) => {
    if (Array.isArray(shapes)) {
        return shapes;
    }
    if (shapes && typeof shapes === 'object') {
        return [shapes];
    }
    return [];
};

const stringifyShapeInput = (shapeInput) => {
    try {
        return JSON.stringify(shapeInput);
    } catch (error) {
        return '[unserializable-shape-input]';
    }
};

const normalizeRichTextProps = (shape) => {
    if (!shape?.props || typeof shape.props !== 'object') {
        return;
    }

    if (typeof shape.props.richText === 'string') {
        shape.props.richText = toRichText(shape.props.richText);
    }

    if (!Object.prototype.hasOwnProperty.call(shape.props, 'text')) {
        return;
    }

    const textValue = shape.props.text;
    if (typeof textValue === 'string') {
        shape.props.richText = toRichText(textValue);
    } else if (textValue !== null && textValue !== undefined) {
        shape.props.richText = toRichText(String(textValue));
    }

    delete shape.props.text;
};

export const convertAndValidateShapes = (shapes, options = {}) => {
    const editor = options.editor || window.tldrawEditor;
    const validatedShapes = [];
    const errors = [];

    if (!editor) {
        return {
            validatedShapes,
            errors: ['Shape validation error: tldraw editor not available']
        };
    }

    const schemaValidator = editor?.store?.schema?.types?.shape?.validator;
    if (!schemaValidator || typeof schemaValidator.validate !== 'function') {
        return {
            validatedShapes,
            errors: ['Shape validation error: shape schema validator is not available']
        };
    }

    for (const shapeInput of normalizeShapeList(shapes)) {
        try {
            if (!shapeInput || typeof shapeInput !== 'object' || Array.isArray(shapeInput)) {
                throw new Error(`Shape must be an object, got ${Array.isArray(shapeInput) ? 'array' : typeof shapeInput}`);
            }

            const existingShape = shapeInput.id ? (editor.getShape(shapeInput.id) || {}) : {};
            const baseShape = {
                id: `shape:${crypto.randomUUID()}`,
                typeName: 'shape',
                rotation: 0,
                index: 'a1',
                parentId: 'page:page',
                isLocked: false,
                opacity: 1,
                meta: {},
                ...existingShape
            };
            const shape = deepMergeObjects(baseShape, shapeInput);

            const normalizedType = typeof shape.type === 'string' ? shape.type.trim() : '';
            if (!normalizedType) {
                throw new Error('Shape type must be a non-empty string');
            }
            shape.type = normalizedType;

            normalizeRichTextProps(shape);

            const shapeUtil = editor.getShapeUtil(shape.type);
            if (!shapeUtil || typeof shapeUtil.getDefaultProps !== 'function') {
                throw new Error(`Shape type "${shape.type}" is not supported`);
            }

            const defaultProps = shapeUtil.getDefaultProps();
            shape.props = deepMergeObjects(defaultProps, shape.props || {});

            schemaValidator.validate(shape);
            validatedShapes.push(shape);
        } catch (validationError) {
            errors.push(`Shape validation error: ${validationError.message} for shape: ${stringifyShapeInput(shapeInput)}`);
        }
    }

    return {
        validatedShapes,
        errors
    };
};



const getMimeTypeFromDataUrl = (dataUrl) => {
    if (typeof dataUrl !== 'string') {
        return 'image/png';
    }
    const match = dataUrl.match(/^data:([^;]+);/i);
    return match?.[1] || 'image/png';
};

const normalizeShapeId = (shapeId) => {
    if (typeof shapeId !== 'string') {
        return '';
    }

    const trimmedShapeId = shapeId.trim();
    if (!trimmedShapeId) {
        return '';
    }

    return trimmedShapeId;
};

const toShapeLookupCandidates = (shapeId) => {
    const normalizedShapeId = normalizeShapeId(shapeId);
    if (!normalizedShapeId) {
        return [];
    }

    if (normalizedShapeId.startsWith('shape:')) {
        return [normalizedShapeId, normalizedShapeId.replace(/^shape:/, '')];
    }

    return [normalizedShapeId, `shape:${normalizedShapeId}`];
};

const resolveShapeIdsForScreenshot = (editor, shapeContext) => {
    if (!editor || typeof editor.getShape !== 'function') {
        return [];
    }

    const normalizedShapeContext = Array.isArray(shapeContext) ? shapeContext : [];
    const resolvedShapeIds = [];
    const seenShapeIds = new Set();

    normalizedShapeContext.forEach((shapeValue) => {
        const rawShapeId = shapeValue && typeof shapeValue === 'object' ? shapeValue.id : null;
        const candidates = toShapeLookupCandidates(rawShapeId);
        for (const candidateShapeId of candidates) {
            const existingShape = editor.getShape(candidateShapeId);
            if (!existingShape) {
                continue;
            }

            const normalizedCandidateId = candidateShapeId.startsWith('shape:')
                ? candidateShapeId.slice('shape:'.length)
                : candidateShapeId;
            if (seenShapeIds.has(normalizedCandidateId)) {
                return;
            }

            seenShapeIds.add(normalizedCandidateId);
            resolvedShapeIds.push(candidateShapeId);
            return;
        }
    });

    return resolvedShapeIds;
};

const normalizeShapeIdForComparison = (shapeId) => {
    if (typeof shapeId !== 'string') {
        return '';
    }

    const trimmedShapeId = shapeId.trim();
    if (!trimmedShapeId) {
        return '';
    }

    return trimmedShapeId.startsWith('shape:')
        ? trimmedShapeId.slice('shape:'.length)
        : trimmedShapeId;
};

const createShapeIdSetKey = (shapeIds) => {
    return (Array.isArray(shapeIds) ? shapeIds : [])
        .map((shapeId) => normalizeShapeIdForComparison(shapeId))
        .filter(Boolean)
        .sort()
        .join('|');
};

const getSelectedShapeIdsFromEditor = (editor) => {
    if (!editor || typeof editor.getSelectedShapeIds !== 'function') {
        return [];
    }

    const selectedShapeIds = editor.getSelectedShapeIds();
    const selectedShapeIdValues = Array.isArray(selectedShapeIds)
        ? selectedShapeIds
        : selectedShapeIds && typeof selectedShapeIds[Symbol.iterator] === 'function'
            ? Array.from(selectedShapeIds)
            : [];

    return selectedShapeIdValues
        .map((shapeId) => typeof shapeId === 'string' ? shapeId.trim() : '')
        .filter(Boolean);
};

const setEditorSelection = (editor, shapeIds) => {
    const normalizedShapeIds = Array.isArray(shapeIds) ? shapeIds : [];
    if (typeof editor.selectShapes === 'function') {
        editor.selectShapes(normalizedShapeIds);
        return true;
    }

    if (typeof editor.setSelectedShapes === 'function') {
        editor.setSelectedShapes(normalizedShapeIds);
        return true;
    }

    return false;
};

const prepareSelectionBoundsForShapeIds = (editor, shapeIds) => {
    if (!editor || typeof editor.getSelectionPageBounds !== 'function') {
        return {
            bounds: null,
            restoreSelection: null
        };
    }

    const normalizedShapeIds = Array.isArray(shapeIds) ? shapeIds : [];
    if (normalizedShapeIds.length < 1) {
        return {
            bounds: null,
            restoreSelection: null
        };
    }

    const currentSelectedShapeIds = getSelectedShapeIdsFromEditor(editor);
    const currentSelectionKey = createShapeIdSetKey(currentSelectedShapeIds);
    const targetSelectionKey = createShapeIdSetKey(normalizedShapeIds);

    if (!targetSelectionKey) {
        return {
            bounds: null,
            restoreSelection: null
        };
    }

    if (currentSelectionKey === targetSelectionKey) {
        return {
            bounds: editor.getSelectionPageBounds(),
            restoreSelection: null
        };
    }

    const didSetSelection = setEditorSelection(editor, normalizedShapeIds);
    if (!didSetSelection) {
        return {
            bounds: null,
            restoreSelection: null
        };
    }

    return {
        bounds: editor.getSelectionPageBounds(),
        restoreSelection: () => {
            setEditorSelection(editor, currentSelectedShapeIds);
        }
    };
};

export const createSelectionScreenshotImage = async (shapeContext = []) => {
    const editor = window.tldrawEditor;
    if (!editor) {
        return null;
    }

    const selectedIds = resolveShapeIdsForScreenshot(editor, shapeContext);
    if (selectedIds.length < 1) {
        return null;
    }

    if (typeof editor.toImageDataUrl !== 'function') {
        throw new Error('This tldraw version does not expose editor.toImageDataUrl().');
    }

    const { bounds, restoreSelection } = prepareSelectionBoundsForShapeIds(editor, selectedIds);
    const imageOptions = {
        format: 'png',
        padding: 0,
        background: editor.getInstanceState().exportBackground
    };

    if (bounds && typeof bounds.clone === 'function') {
        imageOptions.bounds = bounds;
    }

    let imageResult = null;
    try {
        imageResult = await editor.toImageDataUrl(selectedIds, imageOptions);
    } finally {
        if (typeof restoreSelection === 'function') {
            restoreSelection();
        }
    }

    const imageUrl = typeof imageResult?.url === 'string' ? imageResult.url.trim() : '';
    if (!imageUrl.startsWith('data:image/')) {
        return null;
    }

    return {
        id: `selected-shapes-screenshot-${crypto.randomUUID()}`,
        name: `Selected Shapes (${selectedIds.length})`,
        mimeType: getMimeTypeFromDataUrl(imageUrl),
        sizeBytes: null,
        detail: 'auto',
        dataUrl: imageUrl
    };
};
