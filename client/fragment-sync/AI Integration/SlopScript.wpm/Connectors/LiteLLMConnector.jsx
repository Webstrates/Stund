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

export class LiteLLMConnector extends Connector {
    /**
     * @param {string} endpoint - LiteLLM host root
     * @param {string} model - Model identifier
     * @param {Object} [customOptions] - Request-body overrides (e.g. max_tokens)
     * @param {Function} [getApiKey] - Async provider of the API key, injected by the connector factory
     */
    constructor(endpoint, model, customOptions = {}, getApiKey = null) {
        super(model);
        this.endpoint = endpoint;
        this.model = model;
        this.customOptions = customOptions;
        this.getApiKey = getApiKey;

        if (!endpoint) throw new Error('No endpoint provided');
        if (!model) throw new Error('No model name provided');

        return this;
    }

    /**
     * Make a chat completion request
     * @param {Array} history - Array of message objects with role and content
     * @param {Array} tools - Optional array of tool definitions in OpenAI format
     * @returns {Object} Response object with content and/or tool_calls
     */
    async completion(history, tools = null) {
        const body = { model: this.model };
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

        if (typeof this.getApiKey !== 'function') throw new Error('LiteLLMConnector: no API key provider configured');
        const apiKey = await this.getApiKey();

        const response = await fetch(`${this.endpoint}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
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
            throw new Error(`LiteLLMConnector error: ${errorMsg}`);
        }

        // Extract the assistant's response
        const choice = data.choices?.[0];
        if (!choice) {
            throw new Error('LiteLLMConnector: No response choice returned');
        }

        const message = choice.message;

        // Return structured response supporting both text and tool calls
        return {
            content: message.content || '',
            tool_calls: message.tool_calls || null,
            finish_reason: choice.finish_reason
        };
    }
}
