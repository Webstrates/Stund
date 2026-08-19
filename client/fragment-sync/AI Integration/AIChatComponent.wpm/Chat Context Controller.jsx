import React from 'react';
const { useState, useEffect, useRef, useCallback } = React;

import { createSelectionScreenshotImage } from '#CanvasHelpers .default';
import {
    createContextImageDescriptor,
    extractImageFilesFromTransferData,
    hasImageFileInTransferData,
    isImageFile,
    normalizeExternalContextImages,
    readFileAsDataUrl
} from '#AIChatComponent .image-context';
import {
    createSelectedShapeContextFromEditor,
    createShapeSelectionKey,
    getSelectedShapeIdsFromEditor,
    normalizeAndDedupeShapeDescriptors,
    normalizeExternalContextShapes
} from '#AIChatComponent .shape-context';



export function useChatContextController({ hidden, isDisabled, isProcessing }) {
    const [isImageDropActive, setIsImageDropActive] = useState(false);
    const [pendingContextImages, setPendingContextImages] = useState([]);
    const [pendingContextShapes, setPendingContextShapes] = useState([]);
    const imageInputRef = useRef(null);
    const imageDropDepthRef = useRef(0);
    const lastCanvasSelectionKeyRef = useRef(null);

    useEffect(() => {
        if (hidden) {
            return;
        }
        if (typeof window === 'undefined') {
            return;
        }

        let isDisposed = false;
        let activeEditor = null;
        let storeListenerCleanup = null;

        const disconnectStoreListener = () => {
            if (typeof storeListenerCleanup === 'function') {
                storeListenerCleanup();
            }
            storeListenerCleanup = null;
        };

        const syncSelectionShapeContext = () => {
            if (isDisposed || hidden || !activeEditor) {
                return;
            }

            const selectedShapeIds = getSelectedShapeIdsFromEditor(activeEditor);
            const nextSelectionKey = createShapeSelectionKey(selectedShapeIds);
            if (nextSelectionKey === lastCanvasSelectionKeyRef.current) {
                return;
            }

            lastCanvasSelectionKeyRef.current = nextSelectionKey;
            const selectedShapeContext = createSelectedShapeContextFromEditor(activeEditor);
            const normalizedShapeContext = normalizeAndDedupeShapeDescriptors(selectedShapeContext);
            setPendingContextShapes(normalizedShapeContext);
        };

        const connectToEditor = (editor) => {
            if (activeEditor === editor) {
                return;
            }

            disconnectStoreListener();
            activeEditor = editor || null;
            if (!activeEditor) {
                return;
            }

            if (activeEditor.store && typeof activeEditor.store.listen === 'function') {
                storeListenerCleanup = activeEditor.store.listen(() => {
                    syncSelectionShapeContext();
                });
            }

            syncSelectionShapeContext();
        };

        const refreshEditorReference = () => {
            const editor = window.tldrawEditor || null;
            connectToEditor(editor);
        };

        refreshEditorReference();
        const editorPollHandle = window.setInterval(() => {
            if (!isDisposed) {
                refreshEditorReference();
            }
        }, 500);

        return () => {
            isDisposed = true;
            window.clearInterval(editorPollHandle);
            disconnectStoreListener();
        };
    }, [hidden]);
    const appendPendingContextImages = useCallback((contextImages) => {
        const sourceImages = Array.isArray(contextImages) ? contextImages : [];
        if (sourceImages.length < 1) {
            return 0;
        }

        const preparedImages = sourceImages
            .map((contextImage, index) => {
                const fallbackName = typeof contextImage?.name === 'string' && contextImage.name.trim()
                    ? contextImage.name.trim()
                    : `Image ${index + 1}`;
                return createContextImageDescriptor(contextImage, fallbackName);
            })
            .filter(Boolean);

        if (preparedImages.length < 1) {
            return 0;
        }

        setPendingContextImages((previousImages) => [...previousImages, ...preparedImages]);
        return preparedImages.length;
    }, []);

    const appendPendingContextShapes = useCallback((contextShapes) => {
        const sourceShapes = Array.isArray(contextShapes) ? contextShapes : [];
        if (sourceShapes.length < 1) {
            return 0;
        }

        const preparedShapes = normalizeAndDedupeShapeDescriptors(sourceShapes);

        if (preparedShapes.length < 1) {
            return 0;
        }

        setPendingContextShapes((previousShapes) => {
            const safePreviousShapes = Array.isArray(previousShapes) ? previousShapes : [];
            return normalizeAndDedupeShapeDescriptors([...safePreviousShapes, ...preparedShapes]);
        });
        return preparedShapes.length;
    }, []);

    const preparePendingContextImagesFromFiles = useCallback(async (files, defaultNamePrefix = 'Image') => {
        const sourceFiles = Array.isArray(files) ? files : [];
        const preparedImages = [];
        for (let fileIndex = 0; fileIndex < sourceFiles.length; fileIndex += 1) {
            const file = sourceFiles[fileIndex];
            if (!isImageFile(file)) {
                continue;
            }

            const dataUrl = await readFileAsDataUrl(file);
            const fallbackName = `${defaultNamePrefix} ${preparedImages.length + 1}`;
            const imageDescriptor = createContextImageDescriptor({
                name: typeof file.name === 'string' && file.name.trim() ? file.name.trim() : fallbackName,
                mimeType: file.type || 'image/png',
                sizeBytes: typeof file.size === 'number' ? file.size : null,
                detail: 'auto',
                dataUrl: dataUrl
            }, fallbackName);
            if (imageDescriptor) {
                preparedImages.push(imageDescriptor);
            }
        }

        return {
            totalFiles: sourceFiles.length,
            preparedImages: preparedImages
        };
    }, []);

    const applyExternalContextImages = useCallback((requestedImages) => {
        const normalizedImages = normalizeExternalContextImages(requestedImages);
        setPendingContextImages(normalizedImages);
        if (imageInputRef.current) {
            imageInputRef.current.value = '';
        }
        return true;
    }, []);

    const applyExternalContextShapes = useCallback((requestedShapes) => {
        const normalizedShapes = normalizeExternalContextShapes(requestedShapes);
        setPendingContextShapes(normalizedShapes);
        return true;
    }, []);

    const appendExternalContextImages = useCallback((requestedImages) => {
        const normalizedImages = normalizeExternalContextImages(requestedImages);
        if (normalizedImages.length < 1) {
            return true;
        }

        setPendingContextImages((previousImages) => {
            const safePreviousImages = Array.isArray(previousImages) ? previousImages : [];
            return [...safePreviousImages, ...normalizedImages];
        });
        if (imageInputRef.current) {
            imageInputRef.current.value = '';
        }
        return true;
    }, []);

    const appendExternalContextShapes = useCallback((requestedShapes) => {
        const normalizedShapes = normalizeExternalContextShapes(requestedShapes);
        if (normalizedShapes.length < 1) {
            return true;
        }
        appendPendingContextShapes(normalizedShapes);
        return true;
    }, [appendPendingContextShapes]);

    const removePendingContextImage = useCallback((imageId, imageIndex) => {
        setPendingContextImages((previousImages) => {
            if (!Array.isArray(previousImages) || previousImages.length < 1) {
                return previousImages;
            }

            return previousImages.filter((image, index) => {
                if (imageId) {
                    return image?.id !== imageId;
                }
                return index !== imageIndex;
            });
        });
    }, []);

    const removePendingContextShape = useCallback((shapeId, shapeIndex) => {
        setPendingContextShapes((previousShapes) => {
            if (!Array.isArray(previousShapes) || previousShapes.length < 1) {
                return previousShapes;
            }

            return previousShapes.filter((shapeItem, index) => {
                if (shapeId) {
                    return shapeItem?.id !== shapeId;
                }
                return index !== shapeIndex;
            });
        });
    }, []);

    const clearPendingContextImages = useCallback(() => {
        setPendingContextImages([]);
        if (imageInputRef.current) {
            imageInputRef.current.value = '';
        }
    }, []);

    const clearPendingContextShapes = useCallback(() => {
        setPendingContextShapes([]);
    }, []);

    const capturePendingShapeScreenshot = useCallback(async () => {
        if (isDisabled || isProcessing) {
            return;
        }

        const shapeContextForScreenshot = normalizeAndDedupeShapeDescriptors(pendingContextShapes)
            .map((shapeDescriptor) => shapeDescriptor?.shape || null)
            .filter(Boolean);
        if (shapeContextForScreenshot.length < 1) {
            return;
        }

        try {
            const screenshotImage = await createSelectionScreenshotImage(shapeContextForScreenshot);
            if (!screenshotImage) {
                return;
            }
            appendPendingContextImages([screenshotImage]);
        } catch (error) {
            console.error('Failed to create screenshot from pending shape context:', error);
            alert(`Could not create shape screenshot: ${error.message || error}`);
        }
    }, [isDisabled, isProcessing, pendingContextShapes, appendPendingContextImages]);

    const handleImageContextClick = useCallback(() => {
        if (isDisabled || isProcessing) return;
        if (imageInputRef.current) {
            imageInputRef.current.click();
        }
    }, [isDisabled, isProcessing]);

    const handleImageContextInputChange = useCallback(async (event) => {
        const files = Array.from(event.target.files || []);
        if (files.length < 1) return;

        try {
            const { totalFiles, preparedImages } = await preparePendingContextImagesFromFiles(files, 'Image');
            const attachedCount = appendPendingContextImages(preparedImages);
            if (attachedCount !== totalFiles) {
                alert('One or more selected files were skipped because they are not images.');
            }
        } catch (error) {
            console.error('Failed to attach image context:', error);
            alert(`Could not attach image context: ${error.message || error}`);
        } finally {
            event.target.value = '';
        }
    }, [preparePendingContextImagesFromFiles, appendPendingContextImages]);

    const handleImageContextPaste = useCallback(async (files) => {
        const sourceFiles = Array.isArray(files) ? files : [];
        if (sourceFiles.length < 1) {
            return;
        }

        try {
            const { preparedImages } = await preparePendingContextImagesFromFiles(sourceFiles, 'Pasted Image');
            appendPendingContextImages(preparedImages);
        } catch (error) {
            console.error('Failed to attach pasted image context:', error);
            alert(`Could not attach pasted image context: ${error.message || error}`);
        }
    }, [preparePendingContextImagesFromFiles, appendPendingContextImages]);

    const handleInputContainerDragEnter = useCallback((event) => {
        if (isDisabled || isProcessing) {
            return;
        }
        if (!hasImageFileInTransferData(event.dataTransfer)) {
            return;
        }

        event.preventDefault();
        imageDropDepthRef.current += 1;
        setIsImageDropActive(true);
    }, [isDisabled, isProcessing]);

    const handleInputContainerDragOver = useCallback((event) => {
        if (isDisabled || isProcessing) {
            return;
        }
        if (!hasImageFileInTransferData(event.dataTransfer)) {
            return;
        }

        event.preventDefault();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'copy';
        }
        setIsImageDropActive(true);
    }, [isDisabled, isProcessing]);

    const handleInputContainerDragLeave = useCallback((event) => {
        if (!isImageDropActive) {
            return;
        }

        event.preventDefault();
        imageDropDepthRef.current = Math.max(0, imageDropDepthRef.current - 1);
        if (imageDropDepthRef.current < 1) {
            setIsImageDropActive(false);
        }
    }, [isImageDropActive]);

    const handleInputContainerDrop = useCallback((event) => {
        imageDropDepthRef.current = 0;
        setIsImageDropActive(false);
        if (!hasImageFileInTransferData(event.dataTransfer)) {
            return;
        }

        event.preventDefault();
        if (isDisabled || isProcessing) {
            return;
        }

        const droppedImageFiles = extractImageFilesFromTransferData(event.dataTransfer);
        if (droppedImageFiles.length < 1) {
            return;
        }

        handleImageContextPaste(droppedImageFiles);
    }, [isDisabled, isProcessing, handleImageContextPaste]);

    useEffect(() => {
        if (isDisabled || isProcessing) {
            imageDropDepthRef.current = 0;
            setIsImageDropActive(false);
        }
    }, [isDisabled, isProcessing]);

    const clearContext = useCallback(() => {
        clearPendingContextImages();
        clearPendingContextShapes();
    }, [clearPendingContextImages, clearPendingContextShapes]);

    const snapshot = useCallback(() => ({
        images: pendingContextImages,
        shapes: pendingContextShapes
    }), [pendingContextImages, pendingContextShapes]);

    return {
        images: pendingContextImages,
        shapes: pendingContextShapes,
        imageInputRef,
        isDropActive: isImageDropActive,
        onDragEnter: handleInputContainerDragEnter,
        onDragOver: handleInputContainerDragOver,
        onDragLeave: handleInputContainerDragLeave,
        onDrop: handleInputContainerDrop,
        onImageInputChange: handleImageContextInputChange,
        onPasteImages: handleImageContextPaste,
        openImagePicker: handleImageContextClick,
        removeImage: removePendingContextImage,
        removeShape: removePendingContextShape,
        clearImages: clearPendingContextImages,
        clearShapes: clearPendingContextShapes,
        captureShapeScreenshot: capturePendingShapeScreenshot,
        setImages: applyExternalContextImages,
        appendImages: appendExternalContextImages,
        setShapes: applyExternalContextShapes,
        appendShapes: appendExternalContextShapes,
        snapshot,
        clear: clearContext
    };
}
