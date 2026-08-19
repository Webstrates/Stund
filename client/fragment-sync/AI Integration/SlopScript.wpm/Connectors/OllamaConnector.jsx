import { Connector } from '#SlopScript .connector';



export class OllamaConnector extends Connector {
    constructor(endpoint, type, customOptions = {}) {
        super(type);
        this.type = type;
        // Mirror LiteLLM/OpenAI connectors so `model === connector.model` reuse
        // checks in the agents work.
        this.model = type;
        this.endpoint = endpoint;
        this.customOptions = customOptions;

        if (!type) throw new Error('No type given');
        if (!endpoint) throw new Error('No endpoint given');
    }

    /**
     * Make a chat completion request against Ollama's `/api/chat`.
     * Returns the same structured shape as the other connectors so it works
     * with the tool-driven agent loop.
     * @param {Array} history - Array of message objects with role and content
     * @param {Array} tools - Optional array of tool definitions in OpenAI format
     * @returns {Object} Response object with { content, tool_calls, finish_reason }
     */
    async completion(history, tools = null) {
        const messages = await Promise.all(history.map(async (msg) => {
            if (msg.role === 'tool') {
                const toolContent = await this.normalizeMessageContent(msg.content);
                return {
                    role: 'tool',
                    tool_call_id: msg.tool_call_id,
                    content: typeof toolContent === 'string' ? toolContent : JSON.stringify(toolContent)
                };
            } else if (msg.role === 'assistant' && msg.tool_calls) {
                const assistantContent = (msg.content === null || msg.content === undefined || msg.content === '')
                    ? ''
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

        const body = {
            model: this.type,
            stream: false,
            messages,
            options: {
                temperature: 0.7,
                num_predict: 8192
            }
        };

        if (tools && tools.length > 0) {
            body.tools = tools;
        }

        Object.assign(body, this.customOptions);

        if (this.isCancelled) {
            throw new Error('Request cancelled');
        }

        const response = await fetch(`${this.endpoint}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            mode: 'cors',
            body: JSON.stringify(body),
            signal: this.abortSignal
        });

        if (this.isCancelled) {
            throw new Error('Request cancelled');
        }

        const data = await response.json();
        if (!response.ok) {
            const errorMsg = data?.error || JSON.stringify(data);
            throw new Error(`OllamaConnector error: ${errorMsg}`);
        }

        const message = data.message || {};

        return {
            content: message.content || '',
            tool_calls: (message.tool_calls && message.tool_calls.length > 0) ? message.tool_calls : null,
            finish_reason: data.done_reason || null
        };
    }
};

// OLLAMA_ORIGINS="*" OLLAMA_HOST="0.0.0.0" ollama serve
// const connector = new OllamaConnector('http://localhost:11434', 'qwen3:14b');
