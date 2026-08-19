import React from 'react';
const { useState, useEffect, useRef } = React;

import { useTransientDOMState } from '#CoreHelpers .dom-store';
import { useCookieState } from '#CoreHelpers .cookie-store';
import { Dialog, DialogHeader, DialogToggleRow, Section } from '#Dialog .default';
import { useSession, useSessionModel, resolveSchemaRefs } from '#SessionHistory .default';
import { normalizeSessionHistoryServerUrl } from '#SessionHistory .api';


const PROCESSOR_FRAGMENT_CONTAINER_ID = 'processor-fragments';
const DEFAULT_PROCESSOR_IDS = ['application0', 'transcription0', 'voicedetect0'];
const SUPPORTED_PROCESSOR_TYPES = ['ScriptProcessor', 'AIPromptProcessor', 'AIVisionProcessor'];

// Generate a consistent, distinct color from a string (type name)
// Uses golden ratio to ensure colors are well-distributed across the hue spectrum
const GOLDEN_RATIO = 0.618033988749895;
const typeColorCache = new Map();
let nextHue = 0;

function getTypeColor(type, lightness = 85) {
    if (!typeColorCache.has(type)) {
        // Use golden ratio to distribute hues evenly
        const hue = (nextHue * 360) % 360;
        typeColorCache.set(type, hue);
        nextHue = (nextHue + GOLDEN_RATIO) % 1;
    }
    const hue = typeColorCache.get(type);
    return `hsl(${hue}, 70%, ${lightness}%)`;
}

function stringToColor(str) {
    return getTypeColor(str, 85);
}

function stringToHoverColor(str) {
    return getTypeColor(str, 78);
}

function formatErrorMessage(error, fallback = 'Unknown error') {
    if (error instanceof Error && typeof error.message === 'string' && error.message.trim()) {
        return error.message;
    }

    if (typeof error === 'string' && error.trim()) {
        return error;
    }

    try {
        const serialized = JSON.stringify(error);
        if (serialized && serialized !== '{}') {
            return serialized;
        }
    } catch (serializationError) {
        // Ignore serialization errors and fall through to String conversion.
    }

    const asString = String(error || '').trim();
    return asString || fallback;
}

function isObjectRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeFragmentProcessorDefinition(rawDefinition) {
    if (!isObjectRecord(rawDefinition)) {
        throw new Error('Processor definition must be an object.');
    }

    if (!SUPPORTED_PROCESSOR_TYPES.includes(rawDefinition.type)) {
        throw new Error(`Unsupported processor type "${rawDefinition.type}".`);
    }

    if (typeof rawDefinition.name !== 'string' || !rawDefinition.name.trim()) {
        throw new Error('Processor name must be a non-empty string.');
    }

    if (!isObjectRecord(rawDefinition.options)) {
        throw new Error('Processor options must be an object.');
    }

    if (rawDefinition.options.inputs && !isObjectRecord(rawDefinition.options.inputs)) {
        throw new Error('Processor options.inputs must be an object when provided.');
    }

    if (rawDefinition.options.outputs && !isObjectRecord(rawDefinition.options.outputs)) {
        throw new Error('Processor options.outputs must be an object when provided.');
    }

    if (rawDefinition.options.schemas && !isObjectRecord(rawDefinition.options.schemas)) {
        throw new Error('Processor options.schemas must be an object when provided.');
    }

    if (rawDefinition.type === 'ScriptProcessor' && typeof rawDefinition.options.script !== 'string') {
        throw new Error('ScriptProcessor requires options.script (string).');
    }

    if (rawDefinition.type === 'AIPromptProcessor' && typeof rawDefinition.options.prompt !== 'string') {
        throw new Error('AIPromptProcessor requires options.prompt (string).');
    }

    return {
        type: rawDefinition.type,
        name: rawDefinition.name.trim(),
        options: rawDefinition.options
    };
}

function EventEntry({ event }) {
    const [expanded, setExpanded] = useState(false);
    const bgColor = event.type ? stringToColor(event.type) : '#f2f2f2';
    const hoverColor = event.type ? stringToHoverColor(event.type) : '#e8e8e8';

    return (
        <div
            className={`event ${expanded ? 'expanded' : ''}`}
            onClick={() => setExpanded(!expanded)}
            style={{ '--event-bg': bgColor, '--event-hover-bg': hoverColor }}
        >
            {event.type ? <>
                <span className="event-tag">{`${event.type}`}</span>
                <span className="event-tag">{`Start: ${new Date(event.start).toLocaleDateString('de')} ${new Date(event.start).toLocaleTimeString('de')}`}</span>
                {event.end ? <span className="event-tag">{`Duration: ${((event.end - event.start) / 1000).toFixed(2)}s`}</span> : null}
            </> : null}
            <pre onClick={(e) => {
                e.stopPropagation();
                setExpanded(true)
            }}>{JSON.stringify(event, null, 4)}</pre>
            <span className="expand-hint">{expanded ? 'Click to collapse' : 'Click to expand'}</span>
        </div>
    );
}

function HistoryServerField({
    historyServerOverride,
    defaultHistoryServer,
    setHistoryServerOverride,
    disabled
}) {
    const getDraftServerUrl = (serverUrl) => {
        if (!serverUrl) {
            return '';
        }

        try {
            return normalizeSessionHistoryServerUrl(serverUrl);
        } catch (error) {
            return serverUrl;
        }
    };
    const [draftServerUrl, setDraftServerUrl] = useState(() => getDraftServerUrl(historyServerOverride));
    const [serverUrlError, setServerUrlError] = useState('');
    const inputFocusedRef = useRef(false);
    const skipNextBlurCommitRef = useRef(false);

    useEffect(() => {
        if (!inputFocusedRef.current) {
            setDraftServerUrl(getDraftServerUrl(historyServerOverride));
            setServerUrlError('');
        }
    }, [historyServerOverride]);

    const commitServerUrl = () => {
        const trimmedServerUrl = draftServerUrl.trim();

        try {
            const normalizedServerUrl = normalizeSessionHistoryServerUrl(trimmedServerUrl);
            const normalizedOverride = normalizedServerUrl === defaultHistoryServer
                ? ''
                : normalizedServerUrl;

            setHistoryServerOverride(normalizedOverride);
            setDraftServerUrl(normalizedOverride);
            setServerUrlError('');
        } catch (error) {
            setServerUrlError(formatErrorMessage(error, 'Enter a valid HTTP(S) server URL.'));
        }
    };

    return (
        <div className={`session-history-server-setting ${serverUrlError ? 'invalid' : ''}`}>
            <label className="info-label" htmlFor="session-history-server-input">Session Server</label>
            <div className="session-history-server-input-container">
                <input
                    id="session-history-server-input"
                    className="session-history-server-input"
                    type="url"
                    value={draftServerUrl}
                    placeholder={defaultHistoryServer}
                    disabled={disabled}
                    aria-invalid={serverUrlError ? 'true' : 'false'}
                    aria-describedby={serverUrlError ? 'session-history-server-description' : undefined}
                    title="Session Server URL"
                    onFocus={() => {
                        inputFocusedRef.current = true;
                    }}
                    onChange={(event) => {
                        setDraftServerUrl(event.target.value);
                        setServerUrlError('');
                    }}
                    onBlur={() => {
                        inputFocusedRef.current = false;
                        if (skipNextBlurCommitRef.current) {
                            skipNextBlurCommitRef.current = false;
                            return;
                        }
                        commitServerUrl();
                    }}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                            event.currentTarget.blur();
                        } else if (event.key === 'Escape') {
                            skipNextBlurCommitRef.current = true;
                            setDraftServerUrl(getDraftServerUrl(historyServerOverride));
                            setServerUrlError('');
                            event.currentTarget.blur();
                        }
                    }}
                />
                {serverUrlError ? (
                    <span
                        id="session-history-server-description"
                        className="session-history-server-description"
                    >
                        {serverUrlError}
                    </span>
                ) : null}
            </div>
        </div>
    );
}

function ProcessorList() {
    const { session, sessionJoined } = useSession();
    const model = useSessionModel();
    const [serverProcessors, setServerProcessors] = useState({});
    const [fragmentProcessors, setFragmentProcessors] = useState([]);
    const [syncingProcessorName, setSyncingProcessorName] = useState('');

    useEffect(() => {
        if (!session?.schema?.processors) {
            setServerProcessors({});
            return;
        }
        setServerProcessors({ ...session.schema.processors });
    }, [session]);

    // Listen for schema changes via the model (eventTypesChanged fires on any schema update,
    // including processor additions/removals)
    useEffect(() => {
        if (!model) return;
        const handleTypesChanged = () => {
            setServerProcessors(session?.schema?.processors ? { ...session.schema.processors } : {});
        };
        model.addEventListener('eventTypesChanged', handleTypesChanged);
        return () => model.removeEventListener('eventTypesChanged', handleTypesChanged);
    }, [model, session]);

    useEffect(() => {
        let active = true;
        let refreshTimer = null;
        let observer = null;

        const parseLocalProcessors = async () => {
            const container = document.querySelector('#' + PROCESSOR_FRAGMENT_CONTAINER_ID);
            if (!container) {
                if (active) {
                    setFragmentProcessors([]);
                }
                return;
            }

            const fragments = Array.from(container.querySelectorAll(':scope > code-fragment'))
                .sort((a, b) => {
                    const aName = a.getAttribute('name') || a.id || '';
                    const bName = b.getAttribute('name') || b.id || '';
                    return aName.localeCompare(bName);
                });

            const parsed = [];
            for (const fragmentElement of fragments) {
                const fragmentId = fragmentElement.id || '';
                const fragmentName = fragmentElement.getAttribute('name') || 'Unnamed Processor Fragment';
                const meta = {
                    fragmentId,
                    fragmentName,
                    valid: false
                };

                if (!fragmentId) {
                    meta.error = 'Fragment is missing an id.';
                    parsed.push(meta);
                    continue;
                }

                try {
                    const fragment = Fragment.one(`code-fragment#${CSS.escape(fragmentId)}`);
                    if (!fragment) {
                        throw new Error(`Could not resolve fragment "${fragmentId}".`);
                    }

                    const exportsObject = await fragment.require();
                    const definition = normalizeFragmentProcessorDefinition(exportsObject?.processor);

                    meta.valid = true;
                    meta.processorName = definition.name;
                    meta.processorType = definition.type;
                    meta.options = definition.options;
                    meta.inputs = Object.keys(definition.options.inputs || {}).sort((a, b) => a.localeCompare(b));
                    meta.outputs = Object.keys(definition.options.outputs || {}).sort((a, b) => a.localeCompare(b));
                    meta.outputSchemaMap = Object.fromEntries(
                        Object.entries(definition.options.outputs || {}).map(([eventType, outputConfig]) => [eventType, outputConfig?.schemaId || ''])
                    );
                } catch (error) {
                    meta.error = formatErrorMessage(error, 'Failed to parse processor fragment.');
                }

                parsed.push(meta);
            }

            if (!active) return;
            setFragmentProcessors(parsed);
        };

        const scheduleParse = () => {
            if (refreshTimer) {
                clearTimeout(refreshTimer);
            }

            refreshTimer = setTimeout(() => {
                parseLocalProcessors();
            }, 120);
        };

        const connectObserver = () => {
            const container = document.querySelector('#' + PROCESSOR_FRAGMENT_CONTAINER_ID);
            if (!container) return;

            observer = new MutationObserver(scheduleParse);
            observer.observe(container, {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true
            });
        };

        connectObserver();
        scheduleParse();

        const containerWatchInterval = setInterval(() => {
            const container = document.querySelector('#' + PROCESSOR_FRAGMENT_CONTAINER_ID);
            if (!container && observer) {
                observer.disconnect();
                observer = null;
                setFragmentProcessors([]);
                return;
            }

            if (container && !observer) {
                connectObserver();
                scheduleParse();
            }
        }, 800);

        return () => {
            active = false;
            if (refreshTimer) {
                clearTimeout(refreshTimer);
            }
            if (observer) {
                observer.disconnect();
            }
            clearInterval(containerWatchInterval);
        };
    }, []);

    const handleToggleFragmentProcessor = async (fragmentProcessor, isActive) => {
        if (!session || !fragmentProcessor?.valid) {
            return;
        }

        const processorName = fragmentProcessor.processorName;
        if (DEFAULT_PROCESSOR_IDS.includes(processorName)) {
            return;
        }

        const actionLabel = isActive ? 'deactivate' : 'activate';
        if (!confirm(`Do you want to ${actionLabel} processor "${processorName}"?`)) {
            return;
        }

        setSyncingProcessorName(processorName);
        try {
            if (isActive) {
                await session.removeProcessor(processorName);
            } else {
                await session.addProcessor(
                    processorName,
                    fragmentProcessor.processorType,
                    fragmentProcessor.options
                );
            }
        } catch (error) {
            console.error(`Failed to ${actionLabel} processor:`, error);
            alert(`Failed to ${actionLabel} processor: ${error?.message}`);
        } finally {
            setSyncingProcessorName('');
        }
    };

    const handleDeactivateRemoteProcessor = async (processorId) => {
        if (!session) return;

        if (!confirm(`Deactivate processor "${processorId}"?`)) {
            return;
        }

        setSyncingProcessorName(processorId);
        try {
            await session.removeProcessor(processorId);
        } catch (error) {
            console.error('Failed to deactivate processor:', error);
            alert(`Failed to deactivate processor: ${error?.message}`);
        } finally {
            setSyncingProcessorName('');
        }
    };

    const handleOpenFragmentEditor = (fragmentId) => {
        if (!fragmentId) {
            return;
        }

        const runAsync = async () => {
            if (typeof Cauldron === 'undefined' || typeof Cauldron.Cauldron === 'undefined') {
                await WPMv2.require({ package: 'Cauldron', repository: 'cauldron-repos' });
            }
            if (typeof localCauldronEditor === 'undefined') {
                window.localCauldronEditor = new Cauldron.Cauldron();
            }
            localCauldronEditor.open();

            const fragment = Fragment.one(`code-fragment#${CSS.escape(fragmentId)}`);
            if (!fragment) {
                console.warn('Processor fragment not found:', fragmentId);
                return;
            }

            EventSystem.triggerEvent('Cauldron.Open.FragmentEditor', { fragment });
        };

        runAsync().catch((error) => {
            console.error('Failed to open processor fragment editor:', error);
            alert(`Failed to open processor source: ${error?.message || error}`);
        });
    };

    const renderProcessorIo = (inputs = {}, outputs = {}, schemasMap = {}) => {
        const inputKeys = Object.keys(inputs || {});
        const outputEntries = Object.entries(outputs || {});

        return <>
            {inputKeys.length > 0 && (
                <div className="processor-io">
                    <span className="processor-io-label">Inputs</span>
                    <div className="chips">
                        {inputKeys.map((inputKey) => (
                            <span key={inputKey} className="chip processor-input-chip">{inputKey}</span>
                        ))}
                    </div>
                </div>
            )}
            {outputEntries.length > 0 && (
                <div className="processor-io">
                    <span className="processor-io-label">Outputs</span>
                    <div className="chips">
                        {outputEntries.map(([outputKey, outputValue]) => {
                            const rawSchema = outputValue?.schemaId && schemasMap ? schemasMap[outputValue.schemaId] : null;
                            const resolvedSchema = rawSchema ? resolveSchemaRefs(rawSchema, schemasMap) : null;
                            const tooltip = resolvedSchema ? JSON.stringify(resolvedSchema, null, 2) : (outputValue?.schemaId || '');
                            return (
                                <span
                                    key={outputKey}
                                    className="chip processor-output-chip"
                                    title={tooltip}
                                    onClick={() => console.log(`Schema for ${outputKey}:`, resolvedSchema || outputValue)}
                                >
                                    {outputKey}
                                </span>
                            );
                        })}
                    </div>
                </div>
            )}
        </>;
    };

    const serverEntries = Object.entries(serverProcessors);
    const localNameCounts = fragmentProcessors.reduce((counts, fragmentProcessor) => {
        if (!fragmentProcessor.valid) return counts;
        const name = fragmentProcessor.processorName;
        if (!name) return counts;
        counts[name] = (counts[name] || 0) + 1;
        return counts;
    }, {});
    const localProcessorNameSet = new Set(
        fragmentProcessors
            .filter(fragmentProcessor => fragmentProcessor.valid && fragmentProcessor.processorName)
            .map(fragmentProcessor => fragmentProcessor.processorName)
    );
    const defaultProcessorSet = new Set(DEFAULT_PROCESSOR_IDS);
    const serverProcessorNameSet = new Set(serverEntries.map(([processorId]) => processorId));
    const remoteCustomEntries = serverEntries
        .filter(([processorId]) => !defaultProcessorSet.has(processorId) && !localProcessorNameSet.has(processorId))
        .sort((a, b) => a[0].localeCompare(b[0]));

    return sessionJoined ? (
        <div className="processor-list">
            <div className="processor-category">
                <div className="processor-category-header">
                    <h3>Local Processor Fragments</h3>
                    <span className="processor-category-note">From #{PROCESSOR_FRAGMENT_CONTAINER_ID}</span>
                </div>

                {fragmentProcessors.length === 0 && (
                    <p className="empty-message">No local processor fragments found.</p>
                )}

                {fragmentProcessors.map((fragmentProcessor) => {
                    const isValid = fragmentProcessor.valid;
                    const processorName = fragmentProcessor.processorName || fragmentProcessor.fragmentId || 'Unnamed';
                    const hasFragmentId = Boolean(fragmentProcessor.fragmentId);
                    const isDefaultName = defaultProcessorSet.has(processorName);
                    const hasDuplicateName = isValid && localNameCounts[processorName] > 1;
                    const isActive = isValid && serverProcessorNameSet.has(processorName);
                    const isSyncing = syncingProcessorName === processorName;

                    const toggleDisabled = !isValid || hasDuplicateName || isDefaultName || isSyncing;
                    const toggleLabel = isDefaultName
                        ? 'System'
                        : hasDuplicateName
                            ? 'Duplicate Name'
                            : isSyncing
                                ? 'Updating...'
                                : isActive
                                    ? 'Deactivate'
                                    : 'Activate';

                    return (
                        <div
                            key={fragmentProcessor.fragmentId || `invalid-${fragmentProcessor.fragmentName}`}
                            className={`processor-card local ${isValid ? '' : 'invalid'} ${isActive ? 'active' : 'inactive'}`}
                        >
                            <div className="processor-card-header">
                                <div className="processor-card-title">
                                    <span className="processor-name">{processorName}</span>
                                    <span className="processor-type">{fragmentProcessor.processorType || 'Invalid Processor'}</span>
                                    <span className={`processor-status ${!isValid
                                            ? 'invalid'
                                            : hasDuplicateName
                                                ? 'warning'
                                                : isActive
                                                    ? 'active'
                                                    : 'inactive'
                                        }`}>
                                        {!isValid ? 'Invalid' : hasDuplicateName ? 'Duplicate Name' : isActive ? 'Active' : 'Inactive'}
                                    </span>
                                </div>
                                <button
                                    className={`processor-toggle-button ${isActive ? 'active' : ''}`}
                                    title={`${toggleLabel} ${processorName}`}
                                    disabled={toggleDisabled}
                                    onClick={() => handleToggleFragmentProcessor(fragmentProcessor, isActive)}
                                >
                                    {toggleLabel}
                                </button>
                            </div>

                            <div className="processor-fragment-meta">
                                <span className="processor-fragment-name">{fragmentProcessor.fragmentName}</span>
                                <div className="processor-fragment-id-group">
                                    <span className="processor-fragment-id">{fragmentProcessor.fragmentId || 'missing-id'}</span>
                                    <button
                                        className="processor-source-button"
                                        title={hasFragmentId ? 'Open Source' : 'Fragment ID Missing'}
                                        disabled={!hasFragmentId}
                                        onClick={() => handleOpenFragmentEditor(fragmentProcessor.fragmentId)}
                                    >
                                        <span className="material-icons">code</span>
                                    </button>
                                </div>
                            </div>

                            {!isValid && (
                                <p className="processor-error-message">{fragmentProcessor.error}</p>
                            )}

                            {isValid && hasDuplicateName && (
                                <p className="processor-error-message">
                                    Another local fragment uses processor name "{processorName}". Rename one of them.
                                </p>
                            )}

                            {isValid && renderProcessorIo(fragmentProcessor.options?.inputs || {}, fragmentProcessor.options?.outputs || {}, fragmentProcessor.options?.schemas || {})}
                        </div>
                    );
                })}
            </div>

            <div className="processor-category">
                <div className="processor-category-header">
                    <h3>System Processors</h3>
                </div>
                {DEFAULT_PROCESSOR_IDS.map((processorId) => {
                    const processor = serverProcessors[processorId];
                    const isActive = Boolean(processor);
                    const outputs = processor?.config?.outputs || {};
                    const inputs = processor?.config?.inputs || {};
                    const schemas = processor?.config?.schemas || {};

                    return (
                        <div key={processorId} className={`processor-card system ${isActive ? 'active' : 'inactive'}`}>
                            <div className="processor-card-header">
                                <div className="processor-card-title">
                                    <span className="processor-name">{processorId}</span>
                                    <span className="processor-type">{processor?.type || 'SystemProcessor'}</span>
                                    <span className={`processor-status ${isActive ? 'active' : 'inactive'}`}>
                                        {isActive ? 'Active' : 'Inactive'}
                                    </span>
                                </div>
                                <button className="processor-toggle-button system" disabled title="System processors cannot be deleted">
                                    <span className="material-icons">lock</span>
                                    <span>System</span>
                                </button>
                            </div>
                            {renderProcessorIo(inputs, outputs, schemas)}
                        </div>
                    );
                })}
            </div>

            {remoteCustomEntries.length > 0 && (
                <div className="processor-category">
                    <div className="processor-category-header">
                        <h3>Active Server Processors Without Local Fragment</h3>
                        <span className="processor-category-note">Server Only</span>
                    </div>
                    {remoteCustomEntries.map(([processorId, processor]) => {
                        const isSyncing = syncingProcessorName === processorId;
                        const processorType = typeof processor?.type === 'string' && processor.type.trim()
                            ? processor.type
                            : 'UnknownProcessor';
                        return (
                            <div key={processorId} className="processor-card remote active">
                                <div className="processor-card-header">
                                    <div className="processor-card-title">
                                        <span className="processor-name">{processorId}</span>
                                        <span className="processor-type">{processorType}</span>
                                        <span className="processor-status active">Active</span>
                                    </div>
                                    <button
                                        className="processor-toggle-button active"
                                        title={`Deactivate ${processorId}`}
                                        disabled={isSyncing}
                                        onClick={() => handleDeactivateRemoteProcessor(processorId)}
                                    >
                                        {isSyncing ? 'Updating...' : 'Deactivate'}
                                    </button>
                                </div>
                                {renderProcessorIo(processor.config?.inputs || {}, processor.config?.outputs || {}, processor.config?.schemas || {})}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    ) : (
        <p>Create or join a session to view processors.</p>
    );
}

function EventList() {
    const { sessionId, sessionJoined } = useSession();
    const model = useSessionModel();
    const [events, setEvents] = useState([]);
    const [follow, setFollow] = useTransientDOMState('follow-event-list', true);
    const [hiddenTypes, setHiddenTypes] = useTransientDOMState('hidden-event-types', []);
    const listRef = useRef(null);

    const exportEvents = () => {
        if (!model) {
            alert('Session model is not connected yet.');
            return;
        }

        const eventsData = Array.isArray(model.events) ? model.events : [];
        const isoTimestamp = new Date().toISOString();
        const fileTimestamp = isoTimestamp.replace(/[:.]/g, '-');
        const safeSessionId = (sessionId || 'session').replace(/[^a-zA-Z0-9_-]/g, '-');
        const exportData = {
            sessionId: sessionId || null,
            exportedAt: isoTimestamp,
            eventCount: eventsData.length,
            events: eventsData
        };

        const blob = new Blob([JSON.stringify(exportData, null, 4)], { type: 'application/json' });
        const downloadUrl = URL.createObjectURL(blob);
        const downloadLink = document.createElement('a');
        downloadLink.href = downloadUrl;
        downloadLink.download = `${safeSessionId}-history-events-${fileTimestamp}.json`;
        document.body.appendChild(downloadLink);
        downloadLink.click();
        downloadLink.remove();
        URL.revokeObjectURL(downloadUrl);
    };

    const eventTypeCounts = events.reduce((counts, event) => {
        if (!event?.type) {
            return counts;
        }

        counts[event.type] = (counts[event.type] || 0) + 1;
        return counts;
    }, {});
    const eventTypes = Object.keys(eventTypeCounts).sort();

    const toggleType = (type) => {
        setHiddenTypes((prev) => {
            if (prev.includes(type)) {
                return prev.filter((t) => t !== type);
            } else {
                return [...prev, type];
            }
        });
    };

    useEffect(() => {
        if (!model) return;

        // Load existing events
        setEvents(model.events || []);

        const handleEventAdded = (ev) => {
            setEvents((prevEvents) => [...prevEvents, ev]);
        };

        const handleEventUpdated = (ev) => {
            setEvents((prevEvents) => {
                const index = prevEvents.findIndex((e) => e.id === ev.id);
                if (index !== -1) {
                    const newEvents = [...prevEvents];
                    newEvents[index] = ev;
                    return newEvents;
                }
                return prevEvents;
            });
        };

        model.addEventListener('eventAdded', handleEventAdded);
        model.addEventListener('eventUpdated', handleEventUpdated);

        return () => {
            model.removeEventListener('eventAdded', handleEventAdded);
            model.removeEventListener('eventUpdated', handleEventUpdated);
        };
    }, [model]);

    useEffect(() => {
        if (follow && listRef.current) {
            listRef.current.scrollTop = listRef.current.scrollHeight;
        }
    }, [events, follow]);

    if (!sessionJoined) {
        return <p>Create or join a session to view events.</p>;
    }

    return <>
        <div className="session-history-events-actions">
            <div className="toggle-button-group session-history-events-action-buttons">
                <button
                    className="dialog-action-button toggle-button session-history-export-events-button"
                    onClick={exportEvents}
                    title="Export Session Events"
                    disabled={!model}
                >
                    <span className="material-icons">download</span>
                    <span>Export Traces as JSON</span>
                </button>
            </div>
            <DialogToggleRow
                className="session-history-events-follow"
                compact
                label="Auto-Scroll"
                checked={follow}
                onChange={setFollow}
                title="Auto-scroll to latest event"
            />
        </div>
        {eventTypes.length > 0 && (
            <div className="subsection" title="Toggle event type visibility">
                <h3>Trace Filters</h3>
                <div className="chips-container">
                    <div className="chips">
                        {eventTypes.map((type) => {
                            const count = eventTypeCounts[type] || 0;

                            return (
                                <div
                                    key={type}
                                    className={`chip type-filter ${hiddenTypes.includes(type) ? 'hidden' : ''}`}
                                    onClick={() => toggleType(type)}
                                    style={{ '--filter-bg': stringToColor(type) }}
                                >
                                    <span className="chip-name">{type}</span>
                                    <span className="chip-count">{count}</span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        )}
        <div className="event-list" ref={listRef}>
            {events
                .filter((e) => !e.type || !hiddenTypes.includes(e.type))
                .slice(-100)
                .map((event) => (
                    <EventEntry key={event.id} event={event} />
                ))}
        </div>
    </>;
}

export function Main() {
    const [visible, setVisible] = useTransientDOMState('session-history-visible', false);
    const {
        sessionId,
        sessionJoined,
        autoJoinEnabled,
        historyServerOverride,
        defaultHistoryServer,
        setAutoJoinEnabled,
        setHistoryServerOverride,
        createSession,
        joinSession,
        disconnectSession
    } = useSession();
    const [stateRecorderActive, setStateRecorderActive] = useCookieState('stateRecorderActive', true);
    const [interactionRecorderActive, setInteractionRecorderActive] = useCookieState('interactionRecorderActive', true);
    const [streamRecorderActive, setStreamRecorderActive] = useCookieState('streamRecorderActive', true);
    const [chatRecorderActive, setChatRecorderActive] = useCookieState('chatRecorderActive', true);
    const recorderToggles = [
        {
            key: 'state',
            label: 'State Recorder',
            value: stateRecorderActive,
            setValue: setStateRecorderActive
        },
        {
            key: 'interaction',
            label: 'Interaction Recorder',
            value: interactionRecorderActive,
            setValue: setInteractionRecorderActive
        },
        {
            key: 'stream',
            label: 'Stream Recorder',
            value: streamRecorderActive,
            setValue: setStreamRecorderActive
        },
        {
            key: 'chat',
            label: 'Chat Recorder',
            value: chatRecorderActive,
            setValue: setChatRecorderActive
        }
    ];

    return <Dialog
        className="session-history-dialog"
        visible={visible}
        setVisible={setVisible}
    >
        <DialogHeader title="Activity Session" icon="history" onClose={() => setVisible(false)} />

        <Section
            className="session-info-section"
            title="Session"
            color="#42a5f5"
            collapsable
        >
            <p className="section-description">Create or join the activity session used to collect workspace history. The session setup is persistent and shared; the active connection is local.</p>

            <HistoryServerField
                historyServerOverride={historyServerOverride}
                defaultHistoryServer={defaultHistoryServer}
                setHistoryServerOverride={setHistoryServerOverride}
                disabled={sessionJoined}
            />
            <div className="session-info-row">
                <span className="info-label">Session ID</span>
                {sessionId ? <span className="session-id">{sessionId}</span> : <span>No session ID found</span>}
            </div>
            <div className="session-info-row">
                <span className="info-label">Connection</span>
                <span className="session-joined" joined={sessionJoined ? 'yes' : 'no'}>{sessionJoined ? 'Connected' : 'Disconnected'}</span>
            </div>
            <div className="toggle-button-group">
                <button
                    className="dialog-action-button toggle-button"
                    onClick={createSession}
                    disabled={sessionJoined}
                    title="Create New Session"
                >
                    Create New Session
                </button>
                <button
                    className="dialog-action-button toggle-button"
                    onClick={joinSession}
                    disabled={sessionJoined || !sessionId}
                    title="Join Session"
                >
                    Join Session
                </button>
                <button
                    className="dialog-action-button toggle-button"
                    onClick={disconnectSession}
                    disabled={!sessionJoined}
                    title="Disconnect From Session"
                >
                    Disconnect
                </button>
            </div>
            <DialogToggleRow
                className="session-history-auto-connect-row"
                label="Auto-Connect"
                description="Automatically connect when a session ID is available."
                checked={autoJoinEnabled}
                onChange={setAutoJoinEnabled}
                title="Automatically join the current session when available"
            />
        </Section>

        <Section
            className="controls-section"
            title="Recorders"
            color="#ffb300"
            collapsable
        >
            <p className="section-description">Choose which activity is recorded and sent to the session. These settings are local.</p>

            <div className="session-history-recorder-toggle-list">
                {recorderToggles.map((recorder) => (
                    <DialogToggleRow
                        key={recorder.key}
                        className="session-history-recorder-toggle-row"
                        compact
                        label={recorder.label}
                        checked={recorder.value}
                        onChange={recorder.setValue}
                        title={`Toggle ${recorder.label} on/off`}
                    />
                ))}
            </div>
        </Section>

        <Section
            className="processor-section"
            title="Processors"
            color="#4caf50"
            collapsable
            collapsedByDefault
        >
            <p className="section-description">View processor definitions and activate them for the current session. Processor definitions are persistent and shared.</p>

            <ProcessorList />
        </Section>

        <Section
            className="events-section"
            title="Traces"
            color="#78909c"
            collapsable
        >
            <p className="section-description">Inspect or export traces collected by the current session. Display settings are local.</p>

            <EventList />
        </Section>
    </Dialog>;
}
