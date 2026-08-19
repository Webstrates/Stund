import React from 'react';
const { useState, useEffect, useCallback, useRef } = React;

import { getCookie, setCookie, deleteCookie } from '#CoreHelpers .cookie-store';
import {
    safeJsonParse as parseJsonValue,
    safeJsonStringify as stringifyJsonValue
} from '#CoreHelpers .string-utils';

const isUserLoggedIn = () => {
    return typeof webstrate !== 'undefined' &&
        webstrate.user &&
        webstrate.user.userId &&
        webstrate.user.userId !== 'anonymous:';
};

const getWebstrateCookieStore = (scope) => {
    if (scope === 'here') {
        return webstrate.user.cookies.here;
    } else {
        return webstrate.user.cookies.anywhere;
    }
};



/**
 * React hook for persisting state in Webstrate cookies
 * Falls back to browser cookies if user is not logged in
 */
export const useWebstrateCookieState = (key, initialValue = undefined, scope = 'anywhere') => {
    const loggedIn = isUserLoggedIn();

    // If not logged in, fall back to regular cookie state
    const [fallbackValue, setFallbackValue] = useState(() => {
        const stored = getCookie(key);
        return stored !== null ? parseJsonValue(stored, initialValue) : initialValue;
    });

    const [value, setValue] = useState(initialValue);
    const valueRef = useRef(value);
    const isInitializedRef = useRef(false);
    const isUpdatingFromServerRef = useRef(false); // Prevent loop: don't persist when updating from server
    const lastPersistedValueRef = useRef(undefined); // Track last persisted value to avoid unnecessary writes
    valueRef.current = value;

    // Load initial value from Webstrate cookie
    useEffect(() => {
        if (!loggedIn) {
            setValue(fallbackValue);
            isInitializedRef.current = true;
            return;
        }

        let cancelled = false;

        const loadValue = async () => {
            try {
                const cookieStore = getWebstrateCookieStore(scope);
                const stored = await cookieStore.get(key);
                if (!cancelled) {
                    const resolvedValue = stored !== undefined ? stored : initialValue;
                    setValue(resolvedValue);
                    lastPersistedValueRef.current = resolvedValue;
                    isInitializedRef.current = true;
                }
            } catch (e) {
                console.warn('Failed to load Webstrate cookie:', e);
                if (!cancelled) {
                    const browserValue = getCookie(key);
                    const resolvedValue = browserValue !== null ? parseJsonValue(browserValue, initialValue) : initialValue;
                    setValue(resolvedValue);
                    lastPersistedValueRef.current = resolvedValue;
                    isInitializedRef.current = true;
                }
            }
        };

        loadValue();

        return () => {
            cancelled = true;
        };
    }, [key, loggedIn, scope]);

    // Subscribe to Webstrate cookie updates from server
    useEffect(() => {
        if (!loggedIn) return;

        const handleCookieUpdate = (updatedKey, newValue) => {
            if (updatedKey === key) {
                isUpdatingFromServerRef.current = true;
                queueMicrotask(() => {
                    setValue(newValue);
                    lastPersistedValueRef.current = newValue;
                    // Reset after microtask to allow the persist effect to skip this update
                    queueMicrotask(() => {
                        isUpdatingFromServerRef.current = false;
                    });
                });
            }
        };

        const eventName = scope === 'here' ? 'cookieUpdateHere' : 'cookieUpdateAnywhere';
        webstrate.on(eventName, handleCookieUpdate);

        return () => {
            webstrate.off(eventName, handleCookieUpdate);
        };
    }, [key, loggedIn, scope]);

    // Persist to Webstrate cookie whenever value changes (after initialization)
    useEffect(() => {
        if (!isInitializedRef.current) return;
        if (!loggedIn) return; // Fallback handles its own persistence
        if (isUpdatingFromServerRef.current) return; // Skip if update came from server (prevents loop)

        // Skip if value hasn't actually changed
        if (value === lastPersistedValueRef.current) return;
        if (typeof value === 'object' && typeof lastPersistedValueRef.current === 'object' &&
            JSON.stringify(value) === JSON.stringify(lastPersistedValueRef.current)) return;

        const persistValue = async () => {
            lastPersistedValueRef.current = value;
            try {
                const cookieStore = getWebstrateCookieStore(scope);
                if (value === undefined) {
                    await cookieStore.set(key, undefined);
                } else {
                    await cookieStore.set(key, value);
                }
            } catch (e) {
                console.warn('Failed to persist Webstrate cookie:', e);
                if (value === undefined) {
                    deleteCookie(key);
                } else {
                    setCookie(key, stringifyJsonValue(value, String(value)));
                }
            }
        };

        persistValue();
    }, [value, key, loggedIn]);

    const setValueAndPersist = useCallback((newValue) => {
        if (!loggedIn) {
            setFallbackValue(newValue);
            setValue(typeof newValue === 'function' ? newValue(valueRef.current) : newValue);
            return;
        }

        setValue(prevValue => {
            const resolvedValue = typeof newValue === 'function' ? newValue(prevValue) : newValue;
            return resolvedValue;
        });
    }, [loggedIn, setFallbackValue]);

    // Sync fallback value when not logged in and persist to browser cookie
    useEffect(() => {
        if (!loggedIn) {
            setValue(fallbackValue);
            if (fallbackValue === undefined) {
                deleteCookie(key);
            } else {
                setCookie(key, stringifyJsonValue(fallbackValue, String(fallbackValue)));
            }
        }
    }, [fallbackValue, loggedIn, key]);

    return [loggedIn ? value : fallbackValue, setValueAndPersist];
};



export const getWebstrateCookie = async (name, scope = 'anywhere') => {
    if (!isUserLoggedIn()) {
        const value = getCookie(name);
        return value !== null ? parseJsonValue(value, null) : null;
    }

    try {
        const cookieStore = getWebstrateCookieStore(scope);
        const value = await cookieStore.get(name);
        return value !== undefined ? value : null;
    } catch (e) {
        console.warn('Failed to get Webstrate cookie, falling back to browser cookie:', e);
        const value = getCookie(name);
        return value !== null ? parseJsonValue(value, null) : null;
    }
};

export const setWebstrateCookie = async (name, value, scope = 'anywhere') => {
    if (!isUserLoggedIn()) {
        setCookie(name, stringifyJsonValue(value, String(value)));
        return;
    }

    try {
        const cookieStore = getWebstrateCookieStore(scope);
        await cookieStore.set(name, value);
    } catch (e) {
        console.warn('Failed to set Webstrate cookie, falling back to browser cookie:', e);
        setCookie(name, stringifyJsonValue(value, String(value)));
    }
};

export const deleteWebstrateCookie = async (name, scope = 'anywhere') => {
    if (!isUserLoggedIn()) {
        deleteCookie(name);
        return;
    }

    try {
        const cookieStore = getWebstrateCookieStore(scope);
        await cookieStore.set(name, undefined);
    } catch (e) {
        console.warn('Failed to delete Webstrate cookie, falling back to browser cookie:', e);
        deleteCookie(name);
    }
};
