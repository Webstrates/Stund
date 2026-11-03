import { LiteLLMConnector } from '#SlopScript .connector-lite-llm';
import { OpenAIConnector } from '#SlopScript .connector-open-ai';
import { OllamaConnector } from '#SlopScript .connector-ollama';
import { getCookie } from '#CoreHelpers .cookie-store';
import { safeJsonParse } from '#CoreHelpers .string-utils';
import { getWebstrateCookie, setWebstrateCookie } from '#CoreHelpers .webstrate-cookie-store';



/**
 * Webstrate cookies the per-provider API keys are stored in, keyed by connector
 * id. Single source of truth, also imported by the Model Manager's connector
 * section. Ollama needs no key, so it has no entry here.
 *
 * The connectors themselves are credential-free: this module reads the key and
 * injects it as a `getApiKey` callback when constructing them.
 */
export const API_KEY_COOKIES = {
    litellm: 'stund-lite-llm-api-key',
    openai: 'stund-openai-api-key',
    anthropic: 'stund-anthropic-api-key'
};

/**
 * Read an API key from the given webstrate cookie, prompting the user if it is
 * not set yet. The key can also be set/changed ahead of time from the Model
 * Manager's connector section, in which case no prompt is shown.
 *
 * @param {string} cookieName - Webstrate cookie the API key is stored in
 * @param {string} [providerLabel] - Provider name, used in the prompt text
 * @returns {string} The API key
 */
export const getAPIKeyFromCookie = async (cookieName, providerLabel = null) => {
    let apiKey = await getWebstrateCookie(cookieName);
    if (!apiKey) {
        apiKey = prompt(providerLabel ? `Enter your API key for ${providerLabel}:` : 'Enter your API key:');
        if (apiKey) {
            await setWebstrateCookie(cookieName, apiKey);
        } else {
            throw new Error('API key not provided');
        }
    }
    return apiKey;
};

/**
 * Clear a stored API key, so the next request prompts for a new one.
 *
 * @param {string} cookieName - Webstrate cookie the API key is stored in
 */
export const resetAPIKey = async (cookieName) => {
    await setWebstrateCookie(cookieName, null);
    console.log('API key reset. Please refresh the page to enter a new key.');
};

export const DEFAULT_LITELLM_URL = 'https://your-litellm-server.com';
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

// Default public API base URLs (include the version segment, per the OpenAI
// `base_url` convention that OpenAIConnector follows). These can be overridden
// per connector in the Model Manager — e.g. to point at a CORS-enabled proxy,
// since calling api.openai.com directly from the browser is blocked by CORS.
export const DEFAULT_OPENAI_URL = 'https://api.openai.com/v1';
export const DEFAULT_ANTHROPIC_URL = 'https://api.anthropic.com/v1';

// Browser cookies the connector selection is persisted under — per user, like
// the `ai-models` expert model selections. Written by the Model Manager's
// connector section, read here. Kept in cookies rather than the DOM store so a
// user's backend choice is personal instead of document-wide, and so the read
// stays synchronous (`getCookie`), unlike the async webstrate cookie store the
// API keys use.
export const CONNECTOR_COOKIE = 'ai-connector';
export const CONNECTOR_BASE_URLS_COOKIE = 'ai-connector-base-urls';

const trimTrailingSlash = (url) => url.replace(/\/+$/, '');

/**
 * Per-connector description of everything that differs between backends.
 *
 * `apiBase` is the OpenAI-style base URL *including* the version segment, for
 * callers that speak plain HTTP rather than going through a Connector class
 * (see `getConnectorConfig`). LiteLLM and Ollama store a host root, so `/v1` is
 * appended; OpenAI and Anthropic store a base that already ends in `/v1`.
 *
 * `capabilities` records which of the OpenAI-style routes each backend serves.
 * Ollama's OpenAI-compatibility layer covers chat/completions/embeddings only —
 * no audio and no image generation. Web search is a LiteLLM proxy feature.
 */
const CONNECTOR_DESCRIPTORS = {
    litellm: {
        name: 'LiteLLM',
        apiBase: (baseUrls) => `${trimTrailingSlash(baseUrls.litellm || DEFAULT_LITELLM_URL)}/v1`,
        apiKeyCookieName: API_KEY_COOKIES.litellm,
        extraHeaders: {},
        modelPrefixesToStrip: [],
        bodyExtras: { drop_params: true },
        capabilities: {
            chatCompletion: true,
            transcription: true,
            speech: true,
            imageGeneration: true,
            webSearch: true
        }
    },

    openai: {
        name: 'OpenAI',
        apiBase: (baseUrls) => trimTrailingSlash(baseUrls.openai || DEFAULT_OPENAI_URL),
        apiKeyCookieName: API_KEY_COOKIES.openai,
        extraHeaders: {},
        modelPrefixesToStrip: ['openai/'],
        bodyExtras: {},
        capabilities: {
            chatCompletion: true,
            transcription: true,
            speech: true,
            imageGeneration: true,
            webSearch: false
        }
    },

    anthropic: {
        name: 'Anthropic',
        apiBase: (baseUrls) => trimTrailingSlash(baseUrls.anthropic || DEFAULT_ANTHROPIC_URL),
        apiKeyCookieName: API_KEY_COOKIES.anthropic,
        extraHeaders: { 'anthropic-dangerous-direct-browser-access': 'true' },
        modelPrefixesToStrip: ['anthropic/'],
        bodyExtras: {},
        capabilities: {
            chatCompletion: true,
            transcription: false,
            speech: false,
            imageGeneration: false,
            webSearch: false
        }
    },

    ollama: {
        name: 'Ollama',
        apiBase: (baseUrls) => `${trimTrailingSlash(baseUrls.ollama || DEFAULT_OLLAMA_URL)}/v1`,
        apiKeyCookieName: null,
        extraHeaders: {},
        modelPrefixesToStrip: [],
        bodyExtras: {},
        capabilities: {
            chatCompletion: true,
            transcription: false,
            speech: false,
            imageGeneration: false,
            webSearch: false
        }
    }
};

const DEFAULT_CONNECTOR_ID = 'litellm';

// `useCookieState` JSON-encodes what it writes, so a stored id arrives as
// `"openai"`. Falling back to the raw string keeps a hand-set, unquoted cookie
// working too.
const readCookieJson = (name, fallback) => {
    const raw = getCookie(name);
    return raw === null ? fallback : safeJsonParse(raw, raw);
};

const getSelection = () => {
    const id = readCookieJson(CONNECTOR_COOKIE, DEFAULT_CONNECTOR_ID) || DEFAULT_CONNECTOR_ID;
    const baseUrls = readCookieJson(CONNECTOR_BASE_URLS_COOKIE, {});
    return {
        id: CONNECTOR_DESCRIPTORS[id] ? id : DEFAULT_CONNECTOR_ID,
        baseUrls: (baseUrls && typeof baseUrls === 'object') ? baseUrls : {}
    };
};

/**
 * Build the `getApiKey` callback a connector uses to fetch its credential
 * lazily, at request time. Returns null for connectors that need no key.
 */
const createApiKeyGetter = (descriptor) => {
    if (!descriptor.apiKeyCookieName) return null;
    return async () => await getAPIKeyFromCookie(descriptor.apiKeyCookieName, descriptor.name);
};

const stripModelPrefix = (model, prefixes) => {
    for (const prefix of prefixes) {
        if (typeof model === 'string' && model.startsWith(prefix)) {
            return model.slice(prefix.length);
        }
    }
    return model;
};

/**
 * Resolve the connector currently selected in the Model Manager into a plain
 * config object, for callers that issue OpenAI-style HTTP requests directly
 * instead of instantiating a Connector (see `AI Helpers.jsx`).
 *
 * @returns {Object} { id, name, apiBase, apiKeyCookieName, extraHeaders, bodyExtras,
 *                     capabilities, resolveModel }
 */
export function getConnectorConfig() {
    const { id, baseUrls } = getSelection();
    const descriptor = CONNECTOR_DESCRIPTORS[id];

    return {
        id: id,
        name: descriptor.name,
        apiBase: descriptor.apiBase(baseUrls),
        apiKeyCookieName: descriptor.apiKeyCookieName,
        extraHeaders: descriptor.extraHeaders,
        bodyExtras: descriptor.bodyExtras,
        capabilities: descriptor.capabilities,
        resolveModel: (model) => stripModelPrefix(model, descriptor.modelPrefixesToStrip)
    };
}

/**
 * Return the current connector config, or throw if it cannot serve `capability`.
 *
 * @param {string} capability - Key of `config.capabilities`
 * @param {string} label - Human-readable feature name used in the error message
 * @returns {Object} The connector config
 */
export function requireConnectorCapability(capability, label) {
    const config = getConnectorConfig();
    if (!config.capabilities[capability]) {
        throw new Error(`${label} is not supported by the '${config.id}' connector. Choose a different connector in the Model Manager.`);
    }
    return config;
}

/**
 * Build the auth headers for a connector config. Connectors without an API key
 * (Ollama) get no Authorization header, and never trigger the key prompt.
 *
 * @param {Object} config - A config from `getConnectorConfig`
 * @returns {Object} Headers to merge into a fetch request
 */
export async function getConnectorAuthHeaders(config) {
    const headers = { ...config.extraHeaders };

    if (config.apiKeyCookieName) {
        const apiKey = await getAPIKeyFromCookie(config.apiKeyCookieName, config.name);
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    return headers;
}

/**
 * Create the connector currently selected in the Model Manager.
 *
 * The selection and the base URL are read from the per-user connector cookies, so the same choice
 * applies everywhere connectors are instantiated — the AI Sidebar and the
 * sub-agents in Main Agent.slop.
 *
 * @param {string} model - Model identifier for this connector
 * @param {Object} [customOptions] - Request-body overrides (e.g. { max_tokens })
 * @returns {Connector}
 */
export function createConnector(model, customOptions = {}) {
    const { id, baseUrls } = getSelection();
    const descriptor = CONNECTOR_DESCRIPTORS[id];

    switch (id) {
        case 'openai':
        case 'anthropic':
            return new OpenAIConnector(descriptor.apiBase(baseUrls), model, {
                getApiKey: createApiKeyGetter(descriptor),
                extraHeaders: descriptor.extraHeaders,
                modelPrefixesToStrip: descriptor.modelPrefixesToStrip,
                customOptions
            });

        // Ollama talks its native /api/chat rather than the OpenAI-compat /v1
        // route, so it takes the raw base URL instead of `descriptor.apiBase`.
        case 'ollama':
            return new OllamaConnector(baseUrls.ollama || DEFAULT_OLLAMA_URL, model, customOptions);

        case 'litellm':
        default:
            return new LiteLLMConnector(baseUrls.litellm || DEFAULT_LITELLM_URL, model, customOptions, createApiKeyGetter(descriptor));
    }
}
