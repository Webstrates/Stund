import React from 'react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useWebstrateCookieState } from '#CoreHelpers .webstrate-cookie-store';

import { useTransientDOMState } from '#CoreHelpers .dom-store';
import { useCookieState, getCookie } from '#CoreHelpers .cookie-store';
import { Dialog, DialogHeader, Section } from '#Dialog .default';
import {
    API_KEY_COOKIES,
    CONNECTOR_COOKIE,
    CONNECTOR_BASE_URLS_COOKIE,
    DEFAULT_LITELLM_URL,
    DEFAULT_OLLAMA_URL,
    DEFAULT_OPENAI_URL,
    DEFAULT_ANTHROPIC_URL
} from '#SlopScript .connector-factory';



const DEFAULT_COMPLETION_MODELS = [
    'openai/gpt-6.1-sol',
    'anthropic/claude-opus-5-5',
    'anthropic/claude-sonnet-5-5',
    'anthropic/claude-haiku-5-5'
];

const DEFAULT_IMAGE_MODELS = [
    'openai/gpt-image-2',
    'openai/dall-e-3',
    'gemini/imagen-4.0-generate-001'
];

const DEFAULT_STT_MODELS = [
    'openai/whisper-1'
];

const DEFAULT_TTS_MODELS = [
    'openai/tts-1'
];

// Available connectors shown in the connector picker at the top of the dialog.
// `hasBaseUrl` controls whether a base-URL field is shown (LiteLLM / Ollama only);
// `keyCookie` is the webstrate cookie the API key is stored in (null = no key needed).
const CONNECTORS = [
    { id: 'openai', name: 'OpenAI', hasBaseUrl: true, keyCookie: API_KEY_COOKIES.openai, baseUrlPlaceholder: DEFAULT_OPENAI_URL },
    { id: 'anthropic', name: 'Anthropic', hasBaseUrl: true, keyCookie: API_KEY_COOKIES.anthropic, baseUrlPlaceholder: DEFAULT_ANTHROPIC_URL },
    { id: 'ollama', name: 'Ollama', hasBaseUrl: true, keyCookie: null, baseUrlPlaceholder: DEFAULT_OLLAMA_URL },
    { id: 'litellm', name: 'LiteLLM', hasBaseUrl: true, keyCookie: API_KEY_COOKIES.litellm, baseUrlPlaceholder: DEFAULT_LITELLM_URL }
];

// No connector is seeded with a base URL: every field starts empty and shows its
// default as a placeholder. An empty entry means "use the connector's default",
// which the factory applies (`baseUrls.<id> || DEFAULT_<ID>_URL`).
const DEFAULT_CONNECTOR_BASE_URLS = {};

// Webstrate cookies holding the user-added models of each type.
const COMPLETION_MODELS_COOKIE = 'ai-completion-models';
const IMAGE_MODELS_COOKIE = 'ai-image-models';
const STT_MODELS_COOKIE = 'ai-stt-models';
const TTS_MODELS_COOKIE = 'ai-tts-models';

// Combined model configurations for experts, widgets, and general app behavior
const MODEL_CONFIGS = [
    {
        id: 'main-agent',
        name: 'Main Agent',
        type: 'completion',
        category: 'expert',
        defaultModel: 'anthropic/claude-sonnet-5-5'
    },
    {
        id: 'search-expert',
        name: 'Search Expert',
        type: 'completion',
        category: 'expert',
        defaultModel: 'anthropic/claude-sonnet-5-5'
    },
    {
        id: 'canvas-expert',
        name: 'Canvas Expert',
        type: 'completion',
        category: 'expert',
        defaultModel: 'anthropic/claude-sonnet-5-5'
    },
    {
        id: 'canvas-expert-image-generation',
        name: 'Canvas Expert Image Generation',
        type: 'image',
        category: 'expert',
        defaultModel: 'openai/gpt-image-2'
    },
    {
        id: 'history-model-expert',
        name: 'History Model Expert',
        type: 'completion',
        category: 'expert',
        defaultModel: 'anthropic/claude-sonnet-5-5'
    },
    {
        id: 'widget-expert',
        name: 'Widget Expert',
        type: 'completion',
        category: 'expert',
        defaultModel: 'anthropic/claude-opus-5-5'
    },
    {
        id: 'processor-expert',
        name: 'Processor Expert',
        type: 'completion',
        category: 'expert',
        defaultModel: 'anthropic/claude-opus-5-5'
    },
    {
        id: 'widget-completion',
        name: 'Completion Model',
        type: 'completion',
        category: 'widget',
        defaultModel: 'anthropic/claude-sonnet-5-5'
    },
    {
        id: 'widget-image-generation',
        name: 'Image Generation Model',
        type: 'image',
        category: 'widget',
        defaultModel: 'openai/gpt-image-2'
    },
    {
        id: 'widget-speech-to-text',
        name: 'Speech-to-Text Model',
        type: 'stt',
        category: 'widget',
        defaultModel: 'openai/whisper-1'
    },
    {
        id: 'widget-text-to-speech',
        name: 'Text-to-Speech Model',
        type: 'tts',
        category: 'widget',
        defaultModel: 'openai/tts-1'
    },
    {
        id: 'speak-prompt-transcription',
        name: 'Speak Prompt STT Model',
        type: 'stt',
        category: 'general',
        defaultModel: 'openai/whisper-1'
    }
];

// Derived arrays for backwards compatibility in UI
const EXPERTS = MODEL_CONFIGS.filter(m => m.category === 'expert');
const WIDGET_MODEL_TYPES = MODEL_CONFIGS.filter(m => m.category === 'widget');
const GENERAL_MODEL_TYPES = MODEL_CONFIGS.filter(m => m.category === 'general');



function ModelChip({ model, onDelete, type, isDefault }) {
    return (
        <div className={`chip ${type} ${isDefault ? 'default' : ''}`} title={model}>
            <span className="chip-name">{model}</span>
            {!isDefault && (
                <div className="chip-actions">
                    <button
                        className="chip-action-btn delete-btn"
                        onClick={(e) => {
                            e.stopPropagation();
                            onDelete(model);
                        }}
                        title="Remove model"
                    >
                        <span className="icon material-icons">close</span>
                    </button>
                </div>
            )}
        </div>
    );
}

function AddModelButton({ onAdd, placeholder }) {
    const [isAdding, setIsAdding] = useState(false);
    const [inputValue, setInputValue] = useState('');
    const inputRef = useRef(null);

    useEffect(() => {
        if (isAdding && inputRef.current) {
            inputRef.current.focus();
        }
    }, [isAdding]);

    const handleSubmit = () => {
        const trimmed = inputValue.trim();
        if (trimmed) {
            onAdd(trimmed);
        }
        setInputValue('');
        setIsAdding(false);
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') {
            handleSubmit();
        } else if (e.key === 'Escape') {
            setInputValue('');
            setIsAdding(false);
        }
    };

    const handleBlur = () => {
        if (inputValue.trim()) {
            handleSubmit();
        } else {
            setIsAdding(false);
        }
    };

    if (isAdding) {
        return (
            <div className="add-chip-input-container">
                <input
                    ref={inputRef}
                    type="text"
                    className="add-chip-input"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onBlur={handleBlur}
                    placeholder={placeholder}
                />
            </div>
        );
    }

    return (
        <button
            className="add-chip-btn"
            onClick={() => setIsAdding(true)}
            title="Add model"
        >
            <span className="icon material-icons">add</span>
        </button>
    );
}

function ModelSelector({ label, modelId, models, selectedModel, onSelect, defaultModel }) {
    const displayValue = selectedModel || defaultModel;
    const isUsingDefault = !selectedModel || selectedModel === defaultModel;

    const handleReset = () => {
        onSelect(modelId, undefined);
    };

    return (
        <div className="model-selector-row">
            <span className="selector-label">{label}</span>
            <select
                className={`model-select ${isUsingDefault ? 'using-default' : ''}`}
                value={displayValue}
                onChange={(e) => onSelect(modelId, e.target.value)}
            >
                {models.map((model) => (
                    <option key={model} value={model}>
                        {model}{model === defaultModel ? ' (default)' : ''}
                    </option>
                ))}
            </select>
            {!isUsingDefault && (
                <button
                    className="reset-model-btn"
                    onClick={handleReset}
                    title="Reset to default"
                >
                    <span className="icon material-icons">restart_alt</span>
                </button>
            )}
        </div>
    );
}



export function Main() {
    const [visible, setVisible] = useTransientDOMState('model-manager-visible', false);

    // Available (user-added) models, persisted per-user in webstrate cookies.
    // Only non-default entries are stored; the DEFAULT_*_MODELS lists are merged in below.
    const [completionModels, setCompletionModels] = useWebstrateCookieState(COMPLETION_MODELS_COOKIE, []);
    const [imageModels, setImageModels] = useWebstrateCookieState(IMAGE_MODELS_COOKIE, []);
    const [sttModels, setSttModels] = useWebstrateCookieState(STT_MODELS_COOKIE, []);
    const [ttsModels, setTtsModels] = useWebstrateCookieState(TTS_MODELS_COOKIE, []);

    // All model selections stored in a single cookie (persisted per-user)
    const [aiModels, setAiModels] = useCookieState('ai-models', {});

    // Connector selection + base URLs, persisted per-user in cookies (like `ai-models`)
    const [connector, setConnector] = useCookieState(CONNECTOR_COOKIE, 'litellm');
    const [connectorBaseUrls, setConnectorBaseUrls] = useCookieState(CONNECTOR_BASE_URLS_COOKIE, DEFAULT_CONNECTOR_BASE_URLS);

    // API keys, stored in (and read back from) the webstrate cookie store so they
    // can be set/changed here instead of only being prompted on first use.
    const [liteLlmKey, setLiteLlmKey] = useWebstrateCookieState(API_KEY_COOKIES.litellm, '');
    const [openaiKey, setOpenaiKey] = useWebstrateCookieState(API_KEY_COOKIES.openai, '');
    const [anthropicKey, setAnthropicKey] = useWebstrateCookieState(API_KEY_COOKIES.anthropic, '');

    const activeConnector = CONNECTORS.find(c => c.id === connector) || CONNECTORS[0];
    const connectorKeyStates = {
        [API_KEY_COOKIES.litellm]: [liteLlmKey, setLiteLlmKey],
        [API_KEY_COOKIES.openai]: [openaiKey, setOpenaiKey],
        [API_KEY_COOKIES.anthropic]: [anthropicKey, setAnthropicKey]
    };
    const [activeKey, setActiveKey] = activeConnector.keyCookie
        ? connectorKeyStates[activeConnector.keyCookie]
        : [null, null];

    // Merge default models with stored models and sort alphabetically
    const allCompletionModels = [
        ...DEFAULT_COMPLETION_MODELS,
        ...(completionModels || []).filter(m => !DEFAULT_COMPLETION_MODELS.includes(m))
    ].sort((a, b) => a.localeCompare(b));

    const allImageModels = [
        ...DEFAULT_IMAGE_MODELS,
        ...(imageModels || []).filter(m => !DEFAULT_IMAGE_MODELS.includes(m))
    ].sort((a, b) => a.localeCompare(b));

    const allSTTModels = [
        ...DEFAULT_STT_MODELS,
        ...(sttModels || []).filter(m => !DEFAULT_STT_MODELS.includes(m))
    ].sort((a, b) => a.localeCompare(b));

    const allTTSModels = [
        ...DEFAULT_TTS_MODELS,
        ...(ttsModels || []).filter(m => !DEFAULT_TTS_MODELS.includes(m))
    ].sort((a, b) => a.localeCompare(b));

    const handleAddCompletionModel = useCallback((model) => {
        // Don't store default models in the cookie
        if (DEFAULT_COMPLETION_MODELS.includes(model)) {
            return;
        }
        const currentModels = completionModels || [];
        if (!currentModels.includes(model)) {
            setCompletionModels([...currentModels, model]);
        }
    }, [completionModels, setCompletionModels]);

    const handleDeleteCompletionModel = useCallback((model) => {
        const currentModels = completionModels || [];
        setCompletionModels(currentModels.filter(m => m !== model));
    }, [completionModels, setCompletionModels]);

    const handleAddImageModel = useCallback((model) => {
        // Don't store default models in the cookie
        if (DEFAULT_IMAGE_MODELS.includes(model)) {
            return;
        }
        const currentModels = imageModels || [];
        if (!currentModels.includes(model)) {
            setImageModels([...currentModels, model]);
        }
    }, [imageModels, setImageModels]);

    const handleDeleteImageModel = useCallback((model) => {
        const currentModels = imageModels || [];
        setImageModels(currentModels.filter(m => m !== model));
    }, [imageModels, setImageModels]);

    const handleAddSTTModel = useCallback((model) => {
        if (DEFAULT_STT_MODELS.includes(model)) {
            return;
        }
        const currentModels = sttModels || [];
        if (!currentModels.includes(model)) {
            setSttModels([...currentModels, model]);
        }
    }, [sttModels, setSttModels]);

    const handleDeleteSTTModel = useCallback((model) => {
        const currentModels = sttModels || [];
        setSttModels(currentModels.filter(m => m !== model));
    }, [sttModels, setSttModels]);

    const handleAddTTSModel = useCallback((model) => {
        if (DEFAULT_TTS_MODELS.includes(model)) {
            return;
        }
        const currentModels = ttsModels || [];
        if (!currentModels.includes(model)) {
            setTtsModels([...currentModels, model]);
        }
    }, [ttsModels, setTtsModels]);

    const handleDeleteTTSModel = useCallback((model) => {
        const currentModels = ttsModels || [];
        setTtsModels(currentModels.filter(m => m !== model));
    }, [ttsModels, setTtsModels]);

    const handleModelSelect = useCallback((modelId, model) => {
        setAiModels(prev => ({
            ...(prev || {}),
            [modelId]: model || undefined
        }));
    }, [setAiModels]);

    const modelOptionsByType = {
        completion: allCompletionModels,
        image: allImageModels,
        stt: allSTTModels,
        tts: allTTSModels
    };

    return (
        <Dialog
            className="model-manager-dialog"
            visible={visible}
            setVisible={setVisible}
        >
            <DialogHeader title="Model Manager" icon="memory" onClose={() => setVisible(false)} />

            <Section
                className="connector-settings-section"
                title="Connector"
                color="#ff9800"
                collapsable
                collapsedByDefault
            >
                <p className="section-description">Choose the AI backend and optional base URL. The connector and URL are local; API keys are connected to the current Webstrates user.</p>

                <div className="connector-row">
                    <span className="selector-label">Connector</span>
                    <select
                        className="connector-select"
                        value={connector}
                        onChange={(e) => setConnector(e.target.value)}
                    >
                        {CONNECTORS.map((c) => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                    </select>
                </div>

                {activeConnector.hasBaseUrl && (
                    <div className="connector-row">
                        <span className="selector-label">Base URL</span>
                        <input
                            type="text"
                            className="connector-input"
                            value={(connectorBaseUrls || {})[connector] || ''}
                            placeholder={activeConnector.baseUrlPlaceholder}
                            onChange={(e) => setConnectorBaseUrls(prev => ({
                                ...(prev || {}),
                                [connector]: e.target.value
                            }))}
                        />
                    </div>
                )}

                {activeConnector.keyCookie && (
                    <div className="connector-row">
                        <span className="selector-label">API Key</span>
                        <input
                            type="text"
                            className="connector-input"
                            value={activeKey || ''}
                            placeholder="Enter API key"
                            autoComplete="off"
                            onChange={(e) => setActiveKey(e.target.value)}
                        />
                    </div>
                )}
            </Section>

            <Section
                className="available-models-section"
                title="Available Models"
                color="#2196f3"
                collapsable
                collapsedByDefault
            >
                <p className="section-description">Add models to use below. Added models are connected to the current Webstrates user; built-in models cannot be removed. Not all models may support all features and might cause errors.</p>

                <div className="subsection">
                    <h3>Completion Models</h3>
                    <div className="chips-container">
                        <div className="chips">
                            {allCompletionModels.map((model) => (
                                <ModelChip
                                    key={model}
                                    model={model}
                                    type="completion"
                                    isDefault={DEFAULT_COMPLETION_MODELS.includes(model)}
                                    onDelete={handleDeleteCompletionModel}
                                />
                            ))}
                            <AddModelButton
                                onAdd={handleAddCompletionModel}
                                placeholder="Model name (e.g., gpt-4o)"
                            />
                        </div>
                    </div>
                </div>

                <div className="subsection">
                    <h3>Image Models</h3>
                    <div className="chips-container">
                        <div className="chips">
                            {allImageModels.map((model) => (
                                <ModelChip
                                    key={model}
                                    model={model}
                                    type="image"
                                    isDefault={DEFAULT_IMAGE_MODELS.includes(model)}
                                    onDelete={handleDeleteImageModel}
                                />
                            ))}
                            <AddModelButton
                                onAdd={handleAddImageModel}
                                placeholder="Model name (e.g., dall-e-3)"
                            />
                        </div>
                    </div>
                </div>

                <div className="subsection">
                    <h3>Speech-to-Text Models</h3>
                    <div className="chips-container">
                        <div className="chips">
                            {allSTTModels.map((model) => (
                                <ModelChip
                                    key={model}
                                    model={model}
                                    type="stt"
                                    isDefault={DEFAULT_STT_MODELS.includes(model)}
                                    onDelete={handleDeleteSTTModel}
                                />
                            ))}
                            <AddModelButton
                                onAdd={handleAddSTTModel}
                                placeholder="Model name (e.g., whisper-large-v3)"
                            />
                        </div>
                    </div>
                </div>

                <div className="subsection">
                    <h3>Text-to-Speech Models</h3>
                    <div className="chips-container">
                        <div className="chips">
                            {allTTSModels.map((model) => (
                                <ModelChip
                                    key={model}
                                    model={model}
                                    type="tts"
                                    isDefault={DEFAULT_TTS_MODELS.includes(model)}
                                    onDelete={handleDeleteTTSModel}
                                />
                            ))}
                            <AddModelButton
                                onAdd={handleAddTTSModel}
                                placeholder="Model name (e.g., tts-1)"
                            />
                        </div>
                    </div>
                </div>
            </Section>

            <Section
                className="expert-models-section"
                title="Expert Models"
                color="#ab47bc"
                collapsable
            >
                <p className="section-description">Select which completion model each expert uses. These settings are local.</p>

                <div className="model-selectors">
                    {EXPERTS.map((expert) => (
                        <ModelSelector
                            key={expert.id}
                            label={expert.name}
                            modelId={expert.id}
                            models={modelOptionsByType[expert.type] || allCompletionModels}
                            selectedModel={(aiModels || {})[expert.id]}
                            defaultModel={expert.defaultModel}
                            onSelect={handleModelSelect}
                        />
                    ))}
                </div>
            </Section>

            <Section
                className="widget-models-section"
                title="Widget Models"
                color="#ffc107"
                collapsable
            >
                <p className="section-description">Select default models for widget generation and speech output. These settings are local.</p>

                <div className="model-selectors">
                    {WIDGET_MODEL_TYPES.map((type) => (
                        <ModelSelector
                            key={type.id}
                            label={type.name}
                            modelId={type.id}
                            models={modelOptionsByType[type.type] || allCompletionModels}
                            selectedModel={(aiModels || {})[type.id]}
                            defaultModel={type.defaultModel}
                            onSelect={handleModelSelect}
                        />
                    ))}
                </div>
            </Section>

            <Section
                className="general-models-section"
                title="General Models"
                color="#26a69a"
                collapsable
            >
                <p className="section-description">Select default models for general app features. These settings are local.</p>

                <div className="model-selectors">
                    {GENERAL_MODEL_TYPES.map((type) => (
                        <ModelSelector
                            key={type.id}
                            label={type.name}
                            modelId={type.id}
                            models={modelOptionsByType[type.type] || allCompletionModels}
                            selectedModel={(aiModels || {})[type.id]}
                            defaultModel={type.defaultModel}
                            onSelect={handleModelSelect}
                        />
                    ))}
                </div>
            </Section>
        </Dialog>
    );
}



/**
 * Get the selected model for a given model ID (expert or widget type)
 * @param {string} modelId - The ID of the model config (e.g., 'main-agent', 'widget-completion')
 * @returns {string} The selected model name or the default model
 */
export function getModel(modelId) {
    const stored = getCookie('ai-models');
    if (stored) {
        try {
            const models = JSON.parse(stored);
            if (models[modelId]) {
                return models[modelId];
            }
        } catch (e) {
            // Fall through to default
        }
    }
    // Return default model if no selection
    const config = MODEL_CONFIGS.find(c => c.id === modelId);
    return config?.defaultModel;
}

/**
 * React hook to get and set the selected model for a given model ID
 * @param {string} modelId - The ID of the model config (e.g., 'main-agent', 'widget-completion')
 * @returns {[string, (model: string) => void]} Tuple of [currentModel, setModel]
 */
export function useModel(modelId) {
    const [aiModels, setAiModels] = useCookieState('ai-models', {});

    const config = MODEL_CONFIGS.find(c => c.id === modelId);
    const currentModel = (aiModels || {})[modelId] || config?.defaultModel;

    const setModel = useCallback((model) => {
        setAiModels(prev => ({
            ...(prev || {}),
            [modelId]: model || undefined
        }));
    }, [modelId, setAiModels]);

    return [currentModel, setModel];
}
