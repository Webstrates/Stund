import { normalizeImageDataUrl } from '#AIChatComponent .image-context';



export const SHAPE_TYPE_ICON_MAP = {
    image: 'image',
    note: 'sticky_note_2',
    geo: 'pentagon',
    text: 'title',
    draw: 'draw',
    arrow: 'north_east',
    line: 'show_chart',
    frame: 'crop_square',
    widget: 'widgets',
    document: 'article',
    videostream: 'videocam',
    screenstream: 'screen_share'
};

export const SHAPE_COLOR_MAP = {
    black: '#212121',
    grey: '#757575',
    gray: '#757575',
    blue: '#1E88E5',
    'light-blue': '#4FC3F7',
    cyan: '#00ACC1',
    green: '#43A047',
    'light-green': '#81C784',
    yellow: '#FDD835',
    orange: '#FB8C00',
    red: '#E53935',
    'light-red': '#EF9A9A',
    violet: '#8E24AA',
    'light-violet': '#CE93D8',
    white: '#FAFAFA'
};

export const TEXT_PREVIEW_SHAPE_TYPES = new Set(['note', 'geo', 'text']);
export const SHAPE_TEXT_PREVIEW_MAX_LENGTH = 64;



export const cloneShapeContextValue = (value) => {
    if (!value || typeof value !== 'object') {
        return null;
    }

    try {
        const serialized = JSON.stringify(value, (key, nextValue) => {
            if (typeof nextValue === 'function') {
                return undefined;
            }
            return nextValue;
        });
        return serialized ? JSON.parse(serialized) : null;
    } catch (error) {
        return null;
    }
};

export const resolveShapeFromCanvasById = (shapeId) => {
    if (typeof shapeId !== 'string' || !shapeId.trim()) {
        return null;
    }

    const normalizedShapeId = shapeId.trim();
    const candidateShapeIds = [normalizedShapeId];
    if (normalizedShapeId.startsWith('shape:')) {
        candidateShapeIds.push(normalizedShapeId.replace(/^shape:/, ''));
    } else {
        candidateShapeIds.push(`shape:${normalizedShapeId}`);
    }

    for (const candidateShapeId of candidateShapeIds) {
        const shapeValue = window.tldrawEditor.getShape(candidateShapeId);
        if (!shapeValue) {
            continue;
        }

        const clonedShapeValue = cloneShapeContextValue(shapeValue);
        if (clonedShapeValue && typeof clonedShapeValue === 'object') {
            return clonedShapeValue;
        }
    }

    return null;
};

export const createContextShapeDescriptor = (shapeData, fallbackIndex = 0) => {
    const sourceShape = shapeData && typeof shapeData === 'object' && shapeData.shape && typeof shapeData.shape === 'object'
        ? shapeData.shape
        : typeof shapeData === 'string'
            ? { id: shapeData.trim() }
            : shapeData;
    let clonedShape = cloneShapeContextValue(sourceShape);
    if (!clonedShape || typeof clonedShape !== 'object') {
        return null;
    }

    const resolvedCanvasShape = resolveShapeFromCanvasById(clonedShape.id);
    if (resolvedCanvasShape && typeof resolvedCanvasShape === 'object') {
        const resolvedProps = resolvedCanvasShape.props && typeof resolvedCanvasShape.props === 'object'
            ? resolvedCanvasShape.props
            : {};
        const providedProps = clonedShape.props && typeof clonedShape.props === 'object'
            ? clonedShape.props
            : {};

        clonedShape = {
            ...resolvedCanvasShape,
            ...clonedShape,
            props: {
                ...resolvedProps,
                ...providedProps
            }
        };
    }

    const normalizedId = typeof clonedShape.id === 'string' && clonedShape.id.trim()
        ? clonedShape.id.trim()
        : `shape-${fallbackIndex + 1}`;
    const normalizedType = typeof clonedShape.type === 'string' && clonedShape.type.trim()
        ? clonedShape.type.trim()
        : 'unknown';
    clonedShape.id = normalizedId;
    clonedShape.type = normalizedType;

    return {
        id: normalizedId,
        type: normalizedType,
        shape: clonedShape
    };
};

export const normalizeShapeType = (shapeType) => {
    if (typeof shapeType !== 'string') {
        return 'unknown';
    }

    const trimmedShapeType = shapeType.trim();
    return trimmedShapeType || 'unknown';
};

export const getShapeTypeIcon = (shapeType) => {
    const normalizedShapeType = normalizeShapeType(shapeType).toLowerCase();
    return SHAPE_TYPE_ICON_MAP[normalizedShapeType] || 'category';
};

export const normalizeShapeColor = (shapeColor, shapeType = 'unknown') => {
    if (typeof shapeColor !== 'string') {
        return '#EF6C00';
    }

    const trimmedColor = shapeColor.trim();
    if (!trimmedColor) {
        return '#EF6C00';
    }

    const lowerColor = trimmedColor.toLowerCase();
    const normalizedShapeType = normalizeShapeType(shapeType).toLowerCase();

    // tldraw note style: color token "black" is rendered as a yellow sticky note.
    if (normalizedShapeType === 'note' && lowerColor === 'black') {
        return SHAPE_COLOR_MAP.yellow;
    }

    if (SHAPE_COLOR_MAP[lowerColor]) {
        return SHAPE_COLOR_MAP[lowerColor];
    }

    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(trimmedColor)) {
        return trimmedColor;
    }

    return '#EF6C00';
};

export const extractTextFromRichTextContent = (richTextValue) => {
    if (!richTextValue) {
        return '';
    }

    if (typeof richTextValue === 'string') {
        return richTextValue;
    }

    if (Array.isArray(richTextValue)) {
        return richTextValue
            .map((item) => extractTextFromRichTextContent(item))
            .join(' ')
            .trim();
    }

    if (typeof richTextValue === 'object') {
        const nodeText = typeof richTextValue.text === 'string'
            ? richTextValue.text
            : '';
        const nestedText = Array.isArray(richTextValue.content)
            ? richTextValue.content.map((item) => extractTextFromRichTextContent(item)).join(' ')
            : '';
        return `${nodeText} ${nestedText}`.trim();
    }

    return '';
};

export const compactPreviewText = (text, maxLength = SHAPE_TEXT_PREVIEW_MAX_LENGTH) => {
    if (typeof text !== 'string') {
        return '';
    }

    const collapsedText = text.replace(/\s+/g, ' ').trim();
    if (!collapsedText) {
        return '';
    }

    if (collapsedText.length <= maxLength) {
        return collapsedText;
    }

    return `${collapsedText.slice(0, Math.max(8, maxLength - 1)).trimEnd()}…`;
};

export const getShapeTextPreview = (shapeValue, shapeType) => {
    const normalizedShapeType = normalizeShapeType(shapeType).toLowerCase();

    const props = shapeValue?.props && typeof shapeValue.props === 'object'
        ? shapeValue.props
        : {};

    if (normalizedShapeType === 'widget') {
        const widgetName = typeof props.name === 'string' && props.name.trim()
            ? props.name.trim()
            : '';
        if (widgetName) {
            return compactPreviewText(widgetName);
        }
    }

    if (!TEXT_PREVIEW_SHAPE_TYPES.has(normalizedShapeType)) {
        return '';
    }

    const plainText = typeof props.text === 'string' && props.text.trim()
        ? props.text.trim()
        : typeof props.label === 'string' && props.label.trim()
            ? props.label.trim()
            : '';
    if (plainText) {
        return compactPreviewText(plainText);
    }

    if (props.richText) {
        return compactPreviewText(extractTextFromRichTextContent(props.richText));
    }

    return '';
};

export const normalizeShapeImagePreviewSource = (value, mimeType = 'image/png') => {
    if (typeof value !== 'string') {
        return null;
    }

    const trimmedValue = value.trim();
    if (!trimmedValue) {
        return null;
    }

    const normalizedDataUrl = normalizeImageDataUrl(trimmedValue, mimeType);
    if (normalizedDataUrl) {
        return normalizedDataUrl;
    }

    if (/^(https?:\/\/|blob:|\/)/i.test(trimmedValue)) {
        return trimmedValue;
    }

    return null;
};

export const getShapeImagePreviewSource = (shapeValue) => {
    if (!shapeValue || typeof shapeValue !== 'object') {
        return null;
    }

    const directCandidates = [
        normalizeShapeImagePreviewSource(shapeValue.imageDataUrl, shapeValue.mimeType),
        normalizeShapeImagePreviewSource(shapeValue.dataUrl, shapeValue.mimeType),
        normalizeShapeImagePreviewSource(shapeValue?.props?.src, shapeValue?.props?.mimeType),
        normalizeShapeImagePreviewSource(shapeValue?.props?.url, shapeValue?.props?.mimeType)
    ].filter(Boolean);
    if (directCandidates.length > 0) {
        return directCandidates[0];
    }

    const assetId = shapeValue?.props?.assetId;
    const editor = typeof window !== 'undefined' ? window.tldrawEditor : null;
    if (!assetId || !editor || typeof editor.getAsset !== 'function') {
        return null;
    }

    const asset = editor.getAsset(assetId);
    if (!asset || typeof asset !== 'object') {
        return null;
    }

    const assetCandidates = [
        normalizeShapeImagePreviewSource(asset?.props?.src, asset?.props?.mimeType),
        normalizeShapeImagePreviewSource(asset?.props?.url, asset?.props?.mimeType),
        normalizeShapeImagePreviewSource(asset?.src, asset?.mimeType),
        normalizeShapeImagePreviewSource(asset?.url, asset?.mimeType)
    ].filter(Boolean);

    return assetCandidates[0] || null;
};

export const createShapePreviewDescriptor = (shapeData, fallbackIndex = 0) => {
    const descriptor = createContextShapeDescriptor(shapeData, fallbackIndex);
    if (!descriptor) {
        return null;
    }

    const shapeValue = descriptor.shape || {};
    const shapeType = normalizeShapeType(descriptor.type);
    const shapeColor = normalizeShapeColor(shapeValue?.props?.color, shapeType);
    const shapeTextPreview = getShapeTextPreview(shapeValue, shapeType);
    const shapeTypeLower = shapeType.toLowerCase();
    const imagePreviewSource = shapeTypeLower === 'image'
        ? getShapeImagePreviewSource(shapeValue)
        : null;

    const titleParts = [
        `Shape ${descriptor.id}`,
        `Type: ${shapeType}`
    ];
    if (typeof shapeValue?.props?.color === 'string' && shapeValue.props.color.trim()) {
        titleParts.push(`Color: ${shapeValue.props.color.trim()}`);
    }
    if (shapeTextPreview) {
        titleParts.push(`Text: ${shapeTextPreview}`);
    }

    return {
        id: descriptor.id,
        type: shapeType,
        icon: getShapeTypeIcon(shapeType),
        color: shapeColor,
        textPreview: shapeTextPreview,
        imagePreviewSource: imagePreviewSource,
        title: titleParts.join('\n'),
        shape: shapeValue
    };
};

export const focusShapeInCanvas = (shapeId) => {
    if (typeof shapeId !== 'string' || !shapeId.trim()) {
        return false;
    }

    const normalizedShapeId = shapeId.trim();
    const candidateShapeIds = [normalizedShapeId];
    if (normalizedShapeId.startsWith('shape:')) {
        candidateShapeIds.push(normalizedShapeId.replace(/^shape:/, ''));
    } else {
        candidateShapeIds.push(`shape:${normalizedShapeId}`);
    }
    const editor = typeof window !== 'undefined' ? window.tldrawEditor : null;
    if (!editor) {
        return false;
    }

    try {
        let resolvedShapeId = null;
        let shapeValue = null;
        for (const candidateShapeId of candidateShapeIds) {
            const candidateShapeValue = typeof editor.getShape === 'function'
                ? editor.getShape(candidateShapeId)
                : editor?.store?.get?.(candidateShapeId);
            if (candidateShapeValue) {
                shapeValue = candidateShapeValue;
                resolvedShapeId = candidateShapeId;
                break;
            }
        }

        if (!shapeValue) {
            return false;
        }

        const selectedShapeId = resolvedShapeId || normalizedShapeId;
        if (typeof editor.selectShapes === 'function') {
            editor.selectShapes([selectedShapeId]);
        } else if (typeof editor.setSelectedShapes === 'function') {
            editor.setSelectedShapes([selectedShapeId]);
        } else if (typeof editor.select === 'function') {
            editor.select(selectedShapeId);
        }

        if (typeof editor.zoomToSelection === 'function') {
            try {
                editor.zoomToSelection({ animation: { duration: 250 } });
            } catch (error) {
                editor.zoomToSelection();
            }
            return true;
        }

        let shapeBounds = null;
        if (typeof editor.getShapePageBounds === 'function') {
            shapeBounds = editor.getShapePageBounds(selectedShapeId);
        }
        if (!shapeBounds && typeof editor.getSelectionPageBounds === 'function') {
            shapeBounds = editor.getSelectionPageBounds();
        }

        if (shapeBounds && typeof editor.zoomToBounds === 'function') {
            try {
                editor.zoomToBounds(shapeBounds, { animation: { duration: 250 } });
            } catch (error) {
                editor.zoomToBounds(shapeBounds);
            }
            return true;
        }

        if (typeof editor.centerOnPoint === 'function' && typeof shapeValue.x === 'number' && typeof shapeValue.y === 'number') {
            const point = { x: shapeValue.x, y: shapeValue.y };
            try {
                editor.centerOnPoint(point, { animation: { duration: 250 } });
            } catch (error) {
                editor.centerOnPoint(point);
            }
            return true;
        }

        if (typeof editor.zoomToFit === 'function') {
            editor.zoomToFit();
            return true;
        }

        return true;
    } catch (error) {
        console.warn('Failed to focus shape from preview:', error);
        return false;
    }
};

export const normalizeAndDedupeShapeDescriptors = (shapeValues) => {
    const sourceValues = Array.isArray(shapeValues) ? shapeValues : [];
    if (sourceValues.length < 1) {
        return [];
    }

    const dedupedShapes = [];
    const shapeIndexById = new Map();
    let anonymousShapeCounter = 0;

    sourceValues.forEach((shapeValue, index) => {
        const descriptor = createContextShapeDescriptor(shapeValue, index);
        if (!descriptor) {
            return;
        }

        const normalizedShapeId = typeof descriptor.id === 'string' && descriptor.id.trim()
            ? descriptor.id.trim()
            : `shape-anon-${anonymousShapeCounter++}`;
        const dedupeShapeId = normalizedShapeId.startsWith('shape:')
            ? normalizedShapeId.slice('shape:'.length)
            : normalizedShapeId;

        if (shapeIndexById.has(dedupeShapeId)) {
            const existingIndex = shapeIndexById.get(dedupeShapeId);
            dedupedShapes[existingIndex] = descriptor;
            return;
        }

        shapeIndexById.set(dedupeShapeId, dedupedShapes.length);
        dedupedShapes.push(descriptor);
    });

    return dedupedShapes;
};

export const normalizeExternalContextShapes = (requestedShapes) => {
    const shapeList = Array.isArray(requestedShapes)
        ? requestedShapes
        : requestedShapes && typeof requestedShapes === 'object' && Array.isArray(requestedShapes.shapes)
            ? requestedShapes.shapes
            : [];
    return normalizeAndDedupeShapeDescriptors(shapeList);
};

export const normalizeShapeIdForSelectionKey = (shapeId) => {
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

export const createShapeSelectionKey = (shapeIds) => {
    return (Array.isArray(shapeIds) ? shapeIds : [])
        .map((shapeId) => normalizeShapeIdForSelectionKey(shapeId))
        .filter(Boolean)
        .sort()
        .join('|');
};

export const getSelectedShapeIdsFromEditor = (editor) => {
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

export const createSelectedShapeContextFromEditor = (editor) => {
    if (!editor) {
        return [];
    }

    const selectedShapes = typeof editor.getSelectedShapes === 'function'
        ? editor.getSelectedShapes()
        : [];
    if (Array.isArray(selectedShapes) && selectedShapes.length > 0) {
        return selectedShapes
            .map((shapeValue) => cloneShapeContextValue(shapeValue))
            .filter(Boolean);
    }

    if (typeof editor.getShape !== 'function') {
        return [];
    }

    const selectedShapeIds = getSelectedShapeIdsFromEditor(editor);
    if (selectedShapeIds.length < 1) {
        return [];
    }

    return selectedShapeIds
        .map((shapeId) => {
            const candidateShapeIds = [shapeId];
            if (shapeId.startsWith('shape:')) {
                candidateShapeIds.push(shapeId.replace(/^shape:/, ''));
            } else {
                candidateShapeIds.push(`shape:${shapeId}`);
            }

            for (const candidateShapeId of candidateShapeIds) {
                const shapeValue = editor.getShape(candidateShapeId);
                if (!shapeValue) {
                    continue;
                }

                const clonedShapeValue = cloneShapeContextValue(shapeValue);
                if (clonedShapeValue && typeof clonedShapeValue === 'object') {
                    return clonedShapeValue;
                }
            }

            return null;
        })
        .filter(Boolean);
};

export const extractShapeContextMetadata = (shapeContext) => {
    const normalizedShapeDescriptors = normalizeAndDedupeShapeDescriptors(shapeContext);
    if (normalizedShapeDescriptors.length < 1) {
        return [];
    }

    return normalizedShapeDescriptors
        .map((descriptor) => {
            const shapeValue = descriptor.shape || {};
            return {
                id: descriptor.id,
                type: descriptor.type,
                x: typeof shapeValue.x === 'number' ? shapeValue.x : null,
                y: typeof shapeValue.y === 'number' ? shapeValue.y : null,
                rotation: typeof shapeValue.rotation === 'number' ? shapeValue.rotation : null,
                opacity: typeof shapeValue.opacity === 'number' ? shapeValue.opacity : null,
                imageDataUrl: typeof shapeValue.imageDataUrl === 'string' ? shapeValue.imageDataUrl : null,
                dataUrl: typeof shapeValue.dataUrl === 'string' ? shapeValue.dataUrl : null,
                props: shapeValue.props && typeof shapeValue.props === 'object' ? shapeValue.props : {}
            };
        })
        .filter(Boolean);
};
