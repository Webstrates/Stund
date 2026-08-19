import React from 'react';
const { useState, useEffect, useRef } = React;

import {
    safeJsonParse as parseJsonValue,
    safeJsonStringify as stringifyJsonValue
} from '#CoreHelpers .string-utils';

const getOrCreateFragment = (fragmentSelector) => {
    let fragment = Fragment.one(fragmentSelector);
    if (fragment) return fragment;

    fragment = Fragment.create('application/json');
    if (!fragment) return null;

    const element = fragment.html;
    if (fragmentSelector.startsWith('#')) {
        element.id = fragmentSelector.slice(1);
    } else if (fragmentSelector.startsWith('.')) {
        element.className = fragmentSelector.slice(1).split('.').filter(Boolean).join(' ');
    }

    WPMv2.stripProtection(element);
    document.body.appendChild(element);

    return fragment;
};

const readFragmentValue = (fragment, fallback) => {
    const raw = fragment.raw;
    if (!raw || raw.trim() === '') return fallback;
    return parseJsonValue(raw, fallback);
};

const writeFragmentValue = (fragment, value) => {
    const serialized = stringifyJsonValue(value, '', 4);
    if (fragment.raw !== serialized) {
        fragment.raw = serialized;
    }
};

export const useFragmentState = (fragmentSelector, initialValue = undefined) => {
    const [value, setValue] = useState(() => {
        const fragment = getOrCreateFragment(fragmentSelector);
        return fragment ? readFragmentValue(fragment, initialValue) : initialValue;
    });

    const valueRef = useRef(value);
    valueRef.current = value;

    useEffect(() => {
        const fragment = getOrCreateFragment(fragmentSelector);
        if (!fragment) return;

        if (fragment.raw.trim() === '' && initialValue !== undefined) {
            writeFragmentValue(fragment, initialValue);
        }
    }, [fragmentSelector, initialValue]);

    useEffect(() => {
        const fragment = getOrCreateFragment(fragmentSelector);
        if (!fragment) return;

        const onChanged = () => {
            const nextValue = readFragmentValue(fragment, undefined);
            if (JSON.stringify(nextValue) !== JSON.stringify(valueRef.current)) {
                setValue(nextValue);
            }
        };

        fragment.registerOnFragmentChangedHandler(onChanged);

        return () => {
            fragment.unRegisterOnFragmentChangedHandler(onChanged);
        };
    }, [fragmentSelector]);

    const setFragmentValue = (nextValue) => {
        setValue((previousValue) => {
            const resolvedValue = typeof nextValue === 'function' ? nextValue(previousValue) : nextValue;
            const fragment = getOrCreateFragment(fragmentSelector);

            if (fragment) {
                writeFragmentValue(fragment, resolvedValue);
            }

            return resolvedValue;
        });
    };

    return [value, setFragmentValue];
};

export const getFragmentState = (fragmentSelector) => {
    const fragment = getOrCreateFragment(fragmentSelector);
    if (!fragment) return undefined;

    return readFragmentValue(fragment, undefined);
};

export const setFragmentState = (value, fragmentSelector) => {
    const fragment = getOrCreateFragment(fragmentSelector);
    if (!fragment) return;

    writeFragmentValue(fragment, value);
};
