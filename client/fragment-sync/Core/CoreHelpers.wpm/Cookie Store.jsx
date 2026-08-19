import React from 'react';
const { useState, useEffect, useCallback, useRef } = React;

import { useGlobalEvents } from '#CoreHelpers .global-events';
import {
    safeJsonParse as parseJsonValue,
    safeJsonStringify as stringifyJsonValue
} from '#CoreHelpers .string-utils';



const COOKIE_CHANGE_EVENT_PREFIX = 'cookie-change:';



export const getCookie = (name) => {
    const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
    return match ? decodeURIComponent(match[2]) : null;
};

export const setCookie = (name, value, days = 365) => {
    const expires = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=${location.pathname}`;
};

export const deleteCookie = (name) => {
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=${location.pathname}`;
};



/**
 * React hook for persisting state in cookies
 * Cookies are stored in the current document path (location.pathname)
 */
export const useCookieState = (key, initialValue = undefined, days = 365) => {
    const globalEvents = useGlobalEvents();

    const cookieKey = key;
    const eventName = `${COOKIE_CHANGE_EVENT_PREFIX}${cookieKey}`;

    const [value, setValue] = useState(() => {
        const stored = getCookie(cookieKey);
        if (stored !== null) {
            return parseJsonValue(stored, initialValue);
        }
        return initialValue;
    });

    const valueRef = useRef(value);
    valueRef.current = value;

    // Subscribe to changes from other components
    useEffect(() => {
        if (!globalEvents) return;

        const unsubscribe = globalEvents.subscribeEvent(eventName, (newValue) => {
            // Defer state update to avoid updating during render
            queueMicrotask(() => setValue(newValue));
        });

        return unsubscribe;
    }, [globalEvents, eventName]);

    // Persist to cookie whenever value changes
    useEffect(() => {
        if (value === undefined) {
            deleteCookie(cookieKey);
        } else {
            setCookie(cookieKey, stringifyJsonValue(value, String(value)), days);
        }
    }, [value, cookieKey, days]);

    const setValueAndPersist = useCallback((newValue) => {
        setValue(prevValue => {
            const resolvedValue = typeof newValue === 'function' ? newValue(prevValue) : newValue;
            // Notify other components about the change
            if (globalEvents) {
                globalEvents.triggerEvent(eventName, resolvedValue);
            }
            return resolvedValue;
        });
    }, [globalEvents, eventName]);

    return [value, setValueAndPersist];
};
