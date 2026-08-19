import React from 'react';
const { useEffect, useState, useCallback, useRef } = React;
import {
    safeJsonParse as parseJsonValue,
    safeJsonStringify as stringifyJsonValue
} from '#CoreHelpers .string-utils';

const DOM_STORE_PARENT_SELECTOR = '#meta-elements';
const MUTATION_OBSERVER_CONFIG = { childList: true, characterData: true, subtree: true };

// Read a serialized value from an element. Migrates from data-value
// attribute (if present from prior version) back to textContent.
// When concurrent OT writes create multiple text nodes inside the
// element, reads the last text node directly (last edit wins) instead
// of concatenating all nodes via textContent.
const readElementValue = (element) => {
    const attrValue = element.getAttribute('data-value');
    if (attrValue !== null) {
        element.removeAttribute('data-value');
        element.textContent = attrValue;
        return attrValue;
    }

    // Multiple text nodes = concurrent OT writes; pick the last one
    const childNodes = element.childNodes;
    if (childNodes.length > 1) {
        for (let i = childNodes.length - 1; i >= 0; i--) {
            if (childNodes[i].nodeType === Node.TEXT_NODE) {
                const text = childNodes[i].data;
                if (text && text.length > 0) {
                    return text;
                }
            }
        }
    }

    return element.textContent;
};

// Write a serialized value to an element via textContent.
// Concurrent OT writes produce concatenated but individually valid
// JSON strings (e.g. "{...}{...}") which parseJsonWithRecovery
// can reliably recover from.
const writeElementValue = (element, value) => {
    if (element.getAttribute('data-value') !== null) {
        element.removeAttribute('data-value');
    }
    if (element.textContent !== value) {
        element.textContent = value;
    }
};

// Parse JSON with recovery for concatenated strings caused by
// concurrent OT textContent writes (e.g. "{...}{...}").
// Returns the last valid JSON object/array found in the string.
const parseJsonWithRecovery = (rawText, fallback) => {
    const parsed = parseJsonValue(rawText, undefined);
    if (parsed !== undefined) return parsed;

    if (typeof rawText !== 'string' || rawText.length <= 2) return fallback;

    // Search from the end for the last '{' or '[' that starts valid JSON.
    for (let i = rawText.length - 1; i > 0; i--) {
        if (rawText[i] === '{' || rawText[i] === '[') {
            const candidate = rawText.substring(i);
            const result = parseJsonValue(candidate, undefined);
            if (result !== undefined) return result;
        }
    }

    return fallback;
};

const readMapFromDOM = (mapContainer) => {
    const entries = Array.from(mapContainer.querySelectorAll('[data-map-entry]'));
    const result = new Map();
    entries.forEach(entry => {
        const mapKey = entry.getAttribute('data-entry-key');
        const parsedKey = parseJsonValue(mapKey, mapKey);
        if (!result.has(parsedKey)) {
            const rawValue = readElementValue(entry);
            const parsedValue = parseJsonWithRecovery(rawValue, rawValue);
            result.set(parsedKey, parsedValue);
        }
    });
    return result;
};

const readArrayFromDOM = (arrayContainer) => {
    const items = Array.from(arrayContainer.querySelectorAll('[data-array-item]'));
    const seenIds = new Set();
    const dedupedItems = [];
    items.forEach(item => {
        const itemId = item.getAttribute('data-item-id');
        if (itemId !== null && seenIds.has(itemId)) {
            return; // skip duplicate DOM element
        }
        if (itemId !== null) {
            seenIds.add(itemId);
        }
        const rawValue = readElementValue(item);
        dedupedItems.push(parseJsonWithRecovery(rawValue, rawValue));
    });
    return dedupedItems;
};

const readValueFromDOM = (keyElement) => {
    const rawValue = readElementValue(keyElement);
    return parseJsonWithRecovery(rawValue, rawValue);
};

const readStateFromStore = (store, key) => {
    const mapContainer = store.querySelector(`[data-map-key="${key}"]`);
    if (mapContainer) {
        return readMapFromDOM(mapContainer);
    }

    const arrayContainer = store.querySelector(`[data-array-key="${key}"]`);
    if (arrayContainer) {
        return readArrayFromDOM(arrayContainer);
    }

    const keyElement = store.querySelector(`[data-key="${key}"]`);
    if (keyElement) {
        return readValueFromDOM(keyElement);
    }

    return undefined;
};

const writeMapToDOM = (store, key, value, persistent) => {
    let mapContainer = store.querySelector(`[data-map-key="${key}"]`);
    if (!mapContainer) {
        mapContainer = document.createElement('dom-map');
        mapContainer.setAttribute('data-map-key', key);
        if (persistent) {
            WPMv2.stripProtection(mapContainer);
        }
        store.appendChild(mapContainer);
    }

    mapContainer.innerHTML = '';

    value.forEach((val, mapKey) => {
        const entryElement = document.createElement('dom-entry');
        entryElement.setAttribute('data-map-entry', '');
        entryElement.setAttribute('data-entry-key', stringifyJsonValue(mapKey, String(mapKey)));
        if (persistent) {
            WPMv2.stripProtection(entryElement);
        }
        writeElementValue(entryElement, stringifyJsonValue(val, String(val)));
        mapContainer.appendChild(entryElement);
    });

    return mapContainer;
};

const writeArrayToDOM = (store, key, value, persistent) => {
    let arrayContainer = store.querySelector(`[data-array-key="${key}"]`);
    if (!arrayContainer) {
        arrayContainer = document.createElement('dom-array');
        arrayContainer.setAttribute('data-array-key', key);
        if (persistent) {
            WPMv2.stripProtection(arrayContainer);
        }
        store.appendChild(arrayContainer);
    }

    const nextItems = Array.isArray(value) ? value : [];
    const existingItems = Array.from(arrayContainer.querySelectorAll('[data-array-item]'));
    const existingById = new Map();
    const idUsage = new Map();

    existingItems.forEach((itemElement) => {
        const itemId = itemElement.getAttribute('data-item-id');
        if (itemId !== null && !existingById.has(itemId)) {
            existingById.set(itemId, itemElement);
        }
    });

    nextItems.forEach((item) => {
        const rawId = item?.id;
        if (rawId === null || rawId === undefined) {
            return;
        }
        const normalizedId = String(rawId);
        idUsage.set(normalizedId, (idUsage.get(normalizedId) || 0) + 1);
    });

    const nextItemIds = new Set();

    nextItems.forEach((item, index) => {
        const rawId = item?.id;
        const normalizedId = rawId === null || rawId === undefined ? '' : String(rawId);
        const hasUniqueId = normalizedId && idUsage.get(normalizedId) === 1;
        const itemId = hasUniqueId ? `id:${normalizedId}` : `idx:${index}`;
        const serializedItem = stringifyJsonValue(item, String(item));
        let itemElement = existingById.get(itemId);

        if (!itemElement) {
            itemElement = document.createElement('dom-item');
            itemElement.setAttribute('data-array-item', '');
            itemElement.setAttribute('data-item-id', itemId);
            if (persistent) {
                WPMv2.stripProtection(itemElement);
            }
            existingById.set(itemId, itemElement);
        }

        if (readElementValue(itemElement) !== serializedItem) {
            writeElementValue(itemElement, serializedItem);
        }

        const currentChildAtIndex = arrayContainer.children[index] || null;
        if (currentChildAtIndex !== itemElement) {
            arrayContainer.insertBefore(itemElement, currentChildAtIndex);
        }

        nextItemIds.add(itemId);
    });

    const seenWrittenIds = new Set();
    Array.from(arrayContainer.querySelectorAll('[data-array-item]')).forEach((itemElement) => {
        const itemId = itemElement.getAttribute('data-item-id');
        if (!nextItemIds.has(String(itemId)) || seenWrittenIds.has(String(itemId))) {
            arrayContainer.removeChild(itemElement);
        } else {
            seenWrittenIds.add(String(itemId));
        }
    });

    return arrayContainer;
};

const writeValueToDOM = (store, key, value, persistent) => {
    let keyElement = store.querySelector(`[data-key="${key}"]`);
    if (!keyElement) {
        keyElement = document.createElement('dom-state');
        keyElement.setAttribute('data-key', key);
        if (persistent) {
            WPMv2.stripProtection(keyElement);
        }
        store.appendChild(keyElement);
    }

    const serialized = stringifyJsonValue(value, String(value));
    if (readElementValue(keyElement) !== serialized) {
        writeElementValue(keyElement, serialized);
    }
    return keyElement;
};

const writeStateToStore = (store, key, value, persistent) => {
    if (value instanceof Map) {
        return writeMapToDOM(store, key, value, persistent);
    } else if (Array.isArray(value)) {
        return writeArrayToDOM(store, key, value, persistent);
    } else {
        return writeValueToDOM(store, key, value, persistent);
    }
};

const getOrCreateStore = (storeId, persistent) => {
    let store = document.querySelector(`[data-store-id="${storeId}"]`);

    if (!store) {
        store = document.createElement('dom-store');
        store.setAttribute('data-store-id', storeId);
        if (persistent) {
            WPMv2.stripProtection(store);
        }
        const parent = document.querySelector(DOM_STORE_PARENT_SELECTOR) || document.body;
        parent.appendChild(store);
    }

    return store;
};



/**
 * Hook for using DOM state with individual MutationObservers
 * Handles arrays and Maps as multiple DOM elements for better Webstrates performance
 */
export const useDOMState = (key, initialValue = undefined, storeId = 'default', persistent = true) => {
    const [currentValue, setCurrentValue] = useState(() => {
        // Initialize with value from DOM if it exists
        const store = document.querySelector(`[data-store-id="${storeId}"]`);
        if (store) {
            const value = readStateFromStore(store, key);
            if (value !== undefined) {
                return value;
            }
        }
        return initialValue;
    });

    const currentValueRef = useRef(currentValue);
    currentValueRef.current = currentValue;
    const initialValueRef = useRef(initialValue);
    const observerRef = useRef(null);
    const targetElementRef = useRef(null);

    useEffect(() => {
        initialValueRef.current = initialValue;
    }, [key, storeId]);

    useEffect(() => {
        const store = getOrCreateStore(storeId, persistent);
        const stableInitialValue = initialValueRef.current;

        const isMap = currentValue instanceof Map || stableInitialValue instanceof Map;
        const isArray = Array.isArray(currentValue) || Array.isArray(stableInitialValue);

        let targetElement = null;

        if (isMap) {
            targetElement = store.querySelector(`[data-map-key="${key}"]`);
            if (!targetElement && (stableInitialValue !== undefined || currentValue !== undefined)) {
                const mapToUse = stableInitialValue instanceof Map ? stableInitialValue : currentValue;
                if (mapToUse instanceof Map) {
                    targetElement = writeMapToDOM(store, key, mapToUse, persistent);
                }
            }
        } else if (isArray) {
            targetElement = store.querySelector(`[data-array-key="${key}"]`);
            if (!targetElement && stableInitialValue !== undefined) {
                targetElement = writeArrayToDOM(store, key, stableInitialValue, persistent);
            }
        } else {
            targetElement = store.querySelector(`[data-key="${key}"]`);
            if (!targetElement && stableInitialValue !== undefined) {
                targetElement = writeValueToDOM(store, key, stableInitialValue, persistent);
            }
        }

        // Set up individual MutationObserver for this element
        let observer = null;
        if (targetElement) {
            targetElementRef.current = targetElement;
            observer = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    if (mutation.type === 'characterData' || mutation.type === 'childList') {
                        let newValue;
                        if (isMap) {
                            newValue = readMapFromDOM(targetElement);
                            // Compare Maps by converting to JSON
                            const currentEntries = currentValueRef.current instanceof Map
                                ? Array.from(currentValueRef.current.entries())
                                : [];
                            const newEntries = Array.from(newValue.entries());
                            if (JSON.stringify(newEntries) !== JSON.stringify(currentEntries)) {
                                setCurrentValue(newValue);
                            }
                        } else if (isArray) {
                            newValue = readArrayFromDOM(targetElement);
                            if (JSON.stringify(newValue) !== JSON.stringify(currentValueRef.current)) {
                                setCurrentValue(newValue);
                            }
                        } else {
                            newValue = readValueFromDOM(targetElement);
                            if (JSON.stringify(newValue) !== JSON.stringify(currentValueRef.current)) {
                                setCurrentValue(newValue);
                            }
                        }
                    }
                });
            });

            observer.observe(targetElement, MUTATION_OBSERVER_CONFIG);
            observerRef.current = observer;
        }

        return () => {
            if (observer) {
                observer.disconnect();
            }
            observerRef.current = null;
            targetElementRef.current = null;
        };
    }, [key, storeId, persistent]);

    const setState = useCallback((newValue) => {
        const store = document.querySelector(`[data-store-id="${storeId}"]`);
        if (!store) return;

        // Use functional update to get current value without depending on it
        setCurrentValue(prev => {
            const resolvedValue = typeof newValue === 'function' ? newValue(prev) : newValue;

            // Disconnect observer to prevent local DOM mutations from
            // triggering the feedback loop that causes concatenated writes
            const observer = observerRef.current;
            if (observer) {
                observer.disconnect();
            }

            writeStateToStore(store, key, resolvedValue, persistent);

            // Flush any queued records and reconnect
            if (observer && targetElementRef.current) {
                observer.takeRecords();
                observer.observe(targetElementRef.current, MUTATION_OBSERVER_CONFIG);
            }

            return resolvedValue;
        });
    }, [key, storeId, persistent]);

    return [currentValue, setState];
};

export const useTransientDOMState = (key, initialValue, storeId) => {
    return useDOMState(key, initialValue, storeId, false);
};



export const getDOMStore = (storeId = 'default') => {
    const store = document.querySelector(`[data-store-id="${storeId}"]`);
    if (!store) return {};

    const result = {};

    store.querySelectorAll('[data-key]').forEach(keyElement => {
        const key = keyElement.getAttribute('data-key');
        result[key] = readValueFromDOM(keyElement);
    });

    store.querySelectorAll('[data-map-key]').forEach(mapContainer => {
        const key = mapContainer.getAttribute('data-map-key');
        result[key] = readMapFromDOM(mapContainer);
    });

    store.querySelectorAll('[data-array-key]').forEach(arrayContainer => {
        const key = arrayContainer.getAttribute('data-array-key');
        result[key] = readArrayFromDOM(arrayContainer);
    });

    return Object.freeze(result);
};

export const getDOMState = (key, storeId = 'default') => {
    const store = document.querySelector(`[data-store-id="${storeId}"]`);
    if (!store) return undefined;

    return readStateFromStore(store, key);
};

export const setDOMState = (key, value, storeId = 'default', persistent = true) => {
    const store = getOrCreateStore(storeId, persistent);
    writeStateToStore(store, key, value, persistent);
};

export const deleteDOMState = (key, storeId = 'default') => {
    const store = document.querySelector(`[data-store-id="${storeId}"]`);
    if (!store) return;

    const mapContainer = store.querySelector(`[data-map-key="${key}"]`);
    if (mapContainer) {
        store.removeChild(mapContainer);
        return;
    }

    const arrayContainer = store.querySelector(`[data-array-key="${key}"]`);
    if (arrayContainer) {
        store.removeChild(arrayContainer);
        return;
    }

    const keyElement = store.querySelector(`[data-key="${key}"]`);
    if (keyElement) {
        store.removeChild(keyElement);
        return;
    }
};
