import { Connector } from '#SlopScript .connector';



export const DEFAULT_OPTIONS = {
    temperature: 1,
    max_tokens: 8192,
    drop_params: true
};
export const DEFAULT_TOOL_OPTIONS = {
    tool_choice: 'auto',
    parallel_tool_calls: true
};

/**
 * A generic connector for any OpenAI-compatible `/chat/completions` endpoint
 * (OpenAI, Anthropic's OpenAI-compatibility endpoint, self-hosted proxies, ...).
 *
 * The `endpoint` is the API base URL and must already include the version
 * segment (e.g. `https://api.openai.com/v1`); this connector appends
 * `/chat/completions` to it — matching the OpenAI SDK `base_url` convention.
 */
export class OpenAIConnector extends Connector {
    /**
     * @param {string} endpoint - API base URL including version, e.g. 'https://api.openai.com/v1'
     * @param {string} model - Model identifier (may carry a provider prefix from the model list)
     * @param {Object} options
     * @param {Function} [options.getApiKey] - Async provider of the API key, injected by the connector factory
     * @param {Object} [options.extraHeaders] - Extra request headers (e.g. browser-access opt-in)
     * @param {string[]} [options.modelPrefixesToStrip] - Leading `provider/` prefixes to remove from the model id
     * @param {Object} [options.customOptions] - Request-body overrides (e.g. max_tokens)
     */
    constructor(endpoint, model, {
        getApiKey = null,
        extraHeaders = {},
        modelPrefixesToStrip = [],
        customOptions = {}
    } = {}) {
        super(model);

        if (!endpoint) throw new Error('No endpoint provided');
        if (!model) throw new Error('No model name provided');

        this.endpoint = endpoint;
        this.model = model;
        this.getApiKey = getApiKey;
        this.extraHeaders = extraHeaders;
        this.modelPrefixesToStrip = modelPrefixesToStrip;
        this.customOptions = customOptions;
    }

    /**
     * Strip a known `provider/` prefix from the model id so the shared,
     * LiteLLM-style model list (e.g. `openai/gpt-5.4`) works against a native
     * provider that expects a bare model id (`gpt-5.4`).
     */
    resolveModel() {
        for (const prefix of this.modelPrefixesToStrip) {
            if (this.model.startsWith(prefix)) {
                return this.model.slice(prefix.length);
            }
        }
        return this.model;
    }

    /**
     * Make a chat completion request
     * @param {Array} history - Array of message objects with role and content
     * @param {Array} tools - Optional array of tool definitions in OpenAI format
     * @returns {Object} Response object with { content, tool_calls, finish_reason }
     */
    async completion(history, tools = null) {
        const body = { model: this.resolveModel() };
        Object.assign(body, DEFAULT_OPTIONS);

        body.messages = await Promise.all(history.map(async (msg) => {
            if (msg.role === 'tool') {
                const toolContent = await this.normalizeMessageContent(msg.content);
                return {
                    role: 'tool',
                    tool_call_id: msg.tool_call_id,
                    content: typeof toolContent === 'string' ? toolContent : JSON.stringify(toolContent)
                };
            } else if (msg.role === 'assistant' && msg.tool_calls) {
                const assistantContent = (msg.content === null || msg.content === undefined || msg.content === '')
                    ? null
                    : await this.normalizeMessageContent(msg.content);
                return {
                    role: 'assistant',
                    content: assistantContent,
                    tool_calls: msg.tool_calls
                };
            } else {
                const normalizedContent = await this.normalizeMessageContent(msg.content);
                return {
                    role: msg.role,
                    content: normalizedContent
                };
            }
        }));

        if (tools && tools.length > 0) {
            body.tools = tools;
            Object.assign(body, DEFAULT_TOOL_OPTIONS);
        }

        Object.assign(body, this.customOptions);

        // Check if already cancelled before making the request
        if (this.isCancelled) {
            throw new Error('Request cancelled');
        }

        if (typeof this.getApiKey !== 'function') throw new Error('OpenAIConnector: no API key provider configured');
        const apiKey = await this.getApiKey();

        const response = await fetch(`${this.endpoint}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                ...this.extraHeaders
            },
            body: JSON.stringify(body),
            signal: this.abortSignal
        });

        // Check if cancelled after the request completes
        if (this.isCancelled) {
            throw new Error('Request cancelled');
        }

        const data = await response.json();
        if (!response.ok) {
            const errorMsg = data?.error?.message || JSON.stringify(data);
            throw new Error(`OpenAIConnector error: ${errorMsg}`);
        }

        const choice = data.choices?.[0];
        if (!choice) {
            throw new Error('OpenAIConnector: No response choice returned');
        }

        const message = choice.message;

        return {
            content: message.content || '',
            tool_calls: message.tool_calls || null,
            finish_reason: choice.finish_reason
        };
    }
}
