export const readFileAsDataUrl = (file) => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            if (typeof reader.result !== 'string') {
                reject(new Error('Expected image data URL result'));
                return;
            }
            resolve(reader.result);
        };
        reader.onerror = () => reject(new Error('Failed to read image file'));
        reader.readAsDataURL(file);
    });
};

export const isImageFile = (file) => {
    return file instanceof Blob && typeof file.type === 'string' && file.type.startsWith('image/');
};

export const IMAGE_DATA_URL_PREFIX = 'data:image/';

export const hasImageDataUrl = (value) => {
    return typeof value === 'string' && value.startsWith(IMAGE_DATA_URL_PREFIX);
};

export const normalizeImageDataUrl = (value, mimeType = 'image/png') => {
    if (typeof value !== 'string') {
        return null;
    }

    const trimmedValue = value.trim();
    if (!trimmedValue) {
        return null;
    }

    if (trimmedValue.startsWith(IMAGE_DATA_URL_PREFIX)) {
        return trimmedValue;
    }

    const rawBase64 = trimmedValue.startsWith('base64,')
        ? trimmedValue.slice('base64,'.length)
        : trimmedValue;
    const compactBase64 = rawBase64.replace(/\s+/g, '');
    const base64PaddingRemainder = compactBase64.length % 4;
    if (compactBase64.length < 1 || base64PaddingRemainder === 1) {
        return null;
    }

    const paddedBase64 = base64PaddingRemainder > 0
        ? compactBase64.padEnd(compactBase64.length + (4 - base64PaddingRemainder), '=')
        : compactBase64;
    const isValidBase64 = /^[A-Za-z0-9+/]+={0,2}$/.test(paddedBase64);

    if (!isValidBase64) {
        return null;
    }

    const safeMimeType = typeof mimeType === 'string' && mimeType.trim()
        ? mimeType.trim()
        : 'image/png';

    return `data:${safeMimeType};base64,${paddedBase64}`;
};

export const getMimeTypeFromDataUrl = (dataUrl) => {
    if (!hasImageDataUrl(dataUrl)) {
        return 'image/png';
    }
    const mimeMatch = dataUrl.match(/^data:([^;]+);base64,/i);
    if (!mimeMatch || typeof mimeMatch[1] !== 'string' || !mimeMatch[1].trim()) {
        return 'image/png';
    }
    return mimeMatch[1].trim();
};

export const normalizeImageDetail = (detail) => {
    return detail === 'low' || detail === 'high' || detail === 'auto'
        ? detail
        : 'auto';
};

export const createContextImageDescriptor = (imageData, fallbackName = 'Image') => {
    if (!imageData || typeof imageData !== 'object') {
        return null;
    }

    const normalizedDataUrl = normalizeImageDataUrl(imageData.dataUrl, imageData.mimeType);
    if (!normalizedDataUrl) {
        return null;
    }

    const providedName = typeof imageData.name === 'string' ? imageData.name.trim() : '';
    const providedMimeType = typeof imageData.mimeType === 'string' ? imageData.mimeType.trim() : '';

    return {
        id: typeof imageData.id === 'string' && imageData.id.trim()
            ? imageData.id
            : `chat-image-${crypto.randomUUID()}`,
        name: providedName || fallbackName,
        mimeType: providedMimeType || getMimeTypeFromDataUrl(normalizedDataUrl),
        sizeBytes: typeof imageData.sizeBytes === 'number' ? imageData.sizeBytes : null,
        detail: normalizeImageDetail(imageData.detail),
        dataUrl: normalizedDataUrl
    };
};

export const extractImageContextMetadata = (imageContext) => {
    if (!Array.isArray(imageContext)) {
        return [];
    }

    return imageContext.map((contextImage, index) => {
        return {
            id: typeof contextImage?.id === 'string' && contextImage.id.trim() ? contextImage.id : `image-${index + 1}`,
            name: typeof contextImage?.name === 'string' && contextImage.name.trim() ? contextImage.name.trim() : `Image ${index + 1}`,
            mimeType: typeof contextImage?.mimeType === 'string' && contextImage.mimeType.trim()
                ? contextImage.mimeType.trim()
                : 'image/png',
            sizeBytes: typeof contextImage?.sizeBytes === 'number' ? contextImage.sizeBytes : null,
            detail: normalizeImageDetail(contextImage?.detail)
        };
    });
};

export const normalizeExternalContextImages = (requestedImages) => {
    if (!Array.isArray(requestedImages)) {
        return [];
    }

    return requestedImages
        .map((image, index) => {
            if (typeof image === 'string') {
                return createContextImageDescriptor({ dataUrl: image }, `Image ${index + 1}`);
            }

            if (!image || typeof image !== 'object') {
                return null;
            }

            const imageData = typeof image.dataUrl === 'string'
                ? image.dataUrl
                : typeof image.base64 === 'string'
                    ? image.base64
                    : null;
            if (!imageData) {
                return null;
            }

            return createContextImageDescriptor({
                ...image,
                dataUrl: imageData
            }, `Image ${index + 1}`);
        })
        .filter(Boolean);
};

export const extractImageFilesFromTransferData = (transferData) => {
    if (!transferData) {
        return [];
    }

    const items = Array.from(transferData.items || []);
    const imageFilesFromItems = items
        .filter((item) => item?.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file) => isImageFile(file));

    if (imageFilesFromItems.length > 0) {
        return imageFilesFromItems;
    }

    return Array.from(transferData.files || []).filter((file) => isImageFile(file));
};

export const hasImageFileInTransferData = (transferData) => {
    if (!transferData) {
        return false;
    }

    const itemsContainImage = Array.from(transferData.items || []).some((item) => {
        if (item?.kind !== 'file') {
            return false;
        }
        return typeof item.type === 'string' && item.type.startsWith('image/');
    });
    if (itemsContainImage) {
        return true;
    }

    return Array.from(transferData.files || []).some((file) => isImageFile(file));
};

export const extractImageFilesFromClipboardData = (clipboardData) => {
    return extractImageFilesFromTransferData(clipboardData);
};

export const openImageInNewTab = (imageValue, mimeType = 'image/png') => {
    const dataUrl = normalizeImageDataUrl(imageValue, mimeType);
    if (!dataUrl) {
        return;
    }

    const openedWindow = window.open('', '_blank');
    if (openedWindow && openedWindow.document) {
        try {
            openedWindow.opener = null;
        } catch (e) {
            // Ignore if browser disallows overriding opener.
        }

        const imageDocument = openedWindow.document;
        imageDocument.open();
        imageDocument.write(`<!DOCTYPE html>
<html lang='en'>
<head>
    <meta charset='utf-8'>
    <title>Image Preview</title>
    <style>
        html, body {
            margin: 0;
            width: 100%;
            height: 100%;
            background: #212121;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        img {
            max-width: 100%;
            max-height: 100%;
            object-fit: contain;
        }
    </style>
</head>
<body>
</body>
</html>`);
        imageDocument.close();
        const imageElement = imageDocument.createElement('img');
        imageElement.src = dataUrl;
        imageElement.alt = 'Image Preview';
        imageDocument.body.appendChild(imageElement);
        return;
    }

    // Fallback for popup blockers that still allow direct anchor clicks.
    const anchor = document.createElement('a');
    anchor.href = dataUrl;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
};
