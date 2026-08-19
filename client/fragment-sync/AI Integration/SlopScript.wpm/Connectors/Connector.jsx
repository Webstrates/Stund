export class Connector {
    static EXECUTION_TYPE = {
        STACK_ENTRY: 'stackEntry',        // An entrypoint that starts a stack layer
        STACK_EXCEPTION: 'stackException',    // An exception was thrown inside a stack frame
        STACK_RETURN: 'stackReturn',       // Return from a call that pops a call from the stack
        SLOP_CALL: 'slopCall',               // Slop function call
        SLOP_SYNTAX_EXCEPTION: 'slopSyntaxException',  // Slop function execution failed to conform to syntax (possibly retried)
        SLOP_EXCEPTION: 'slopException',               // Slop function error
        SLOP_RETURN: 'slopReturn',           // Slop function completes and returns
        TOOL_CALL: 'toolCall',               // Tool is called
        TOOL_EXCEPTION: 'toolException',               // Tool is called but failed
        TOOL_RETURN: 'toolReturn',           // Tool returns
    };

    constructor(name) {
        this.name = name;
        this.executionListeners = [];
        this.abortController = null;
        this._isCancelled = false;
        // Each connector has its own stack for nested calls
        this.connectorStack = [];
    }

    /**
     * Cancel the current execution, aborting any in-flight requests.
     * Also cancels all child connectors on the stack (connectors pushed after this one).
     */
    cancel() {
        this.isCancelled = true;
    }

    /**
     * Get the abort signal for use in fetch calls
     */
    get abortSignal() {
        return this.abortController?.signal;
    }

    /**
     * Getter/setter for isCancelled that also triggers abort
     * and propagates cancellation to child connectors on the stack
     */
    get isCancelled() {
        return this._isCancelled;
    }

    set isCancelled(value) {
        this._isCancelled = value;
        if (value) {
            // Abort this connector's in-flight request
            if (this.abortController) {
                this.abortController.abort();
            }

            // Propagate cancellation to all child connectors on the stack
            // (connectors that were pushed after this one)
            const stack = this.connectorStack;
            if (stack) {
                const myIndex = stack.indexOf(this);
                if (myIndex !== -1) {
                    // Cancel all connectors after this one in the stack
                    for (let i = myIndex + 1; i < stack.length; i++) {
                        const childConnector = stack[i];
                        if (childConnector && !childConnector._isCancelled) {
                            childConnector._isCancelled = true;
                            if (childConnector.abortController) {
                                childConnector.abortController.abort();
                            }
                        }
                    }
                }
            }
        }
    }

    static normalizeImageDetail(detail) {
        const normalizedDetail = typeof detail === 'string' ? detail.trim().toLowerCase() : 'auto';
        return ['auto', 'low', 'high'].includes(normalizedDetail) ? normalizedDetail : 'auto';
    }

    static isImageDataUrl(value) {
        return typeof value === 'string' && value.startsWith('data:image/');
    }

    static async blobToDataUrl(blob, mimeType = null) {
        if (!(blob instanceof Blob)) {
            throw new Error('Expected a Blob when converting image to data URL');
        }

        const typedBlob = mimeType && blob.type !== mimeType
            ? new Blob([blob], { type: mimeType })
            : blob;

        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                if (typeof reader.result !== 'string') {
                    reject(new Error('Failed to convert blob to data URL'));
                    return;
                }
                resolve(reader.result);
            };
            reader.onerror = () => reject(new Error('Failed to read blob data'));
            reader.readAsDataURL(typedBlob);
        });
    }

    static createDataUrlFromBase64(base64, mimeType = 'image/png') {
        if (typeof base64 !== 'string' || !base64.trim()) {
            throw new Error('Invalid base64 image data');
        }

        return `data:${mimeType || 'image/png'};base64,${base64}`;
    }

    static async resolveImageDataUrl(part) {
        if (!part || typeof part !== 'object') {
            throw new Error('Invalid image content part');
        }

        const imageUrlFromPart = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
        const imageUrlCandidate = imageUrlFromPart || part.url || part.dataUrl;
        if (typeof imageUrlCandidate === 'string' && imageUrlCandidate.trim()) {
            const trimmedUrl = imageUrlCandidate.trim();
            if (Connector.isImageDataUrl(trimmedUrl)) {
                return trimmedUrl;
            }

            const fetchedImage = await fetch(trimmedUrl);
            if (!fetchedImage.ok) {
                throw new Error(`Could not fetch image URL (${fetchedImage.status})`);
            }
            const fetchedBlob = await fetchedImage.blob();
            return await Connector.blobToDataUrl(fetchedBlob);
        }

        if (typeof part.base64 === 'string' && part.base64.trim()) {
            const mimeType = part.mimeType || part.image_url?.mimeType || 'image/png';
            return Connector.createDataUrlFromBase64(part.base64, mimeType);
        }

        if (part.blob instanceof Blob) {
            return await Connector.blobToDataUrl(part.blob, part.mimeType || part.blob.type);
        }

        throw new Error('Unable to resolve image part to a data URL');
    }

    static async normalizeMessagePart(part) {
        if (part === null || part === undefined) {
            return {
                type: 'text',
                text: ''
            };
        }

        if (typeof part === 'string' || typeof part === 'number' || typeof part === 'boolean') {
            return {
                type: 'text',
                text: String(part)
            };
        }

        if (typeof part !== 'object') {
            return {
                type: 'text',
                text: JSON.stringify(part)
            };
        }

        if (part.type === 'text' || part.type === 'input_text') {
            return {
                type: 'text',
                text: typeof part.text === 'string' ? part.text : String(part.text ?? '')
            };
        }

        if (part.type === 'image_url' || part.type === 'input_image' || part.type === 'image_blob') {
            const url = await Connector.resolveImageDataUrl(part);
            const detail = Connector.normalizeImageDetail(part.detail || part.image_url?.detail);
            return {
                type: 'image_url',
                image_url: {
                    url: url,
                    detail: detail
                }
            };
        }

        return {
            type: 'text',
            text: JSON.stringify(part)
        };
    }

    static async normalizeMessageContent(content) {
        if (content === null || content === undefined) {
            return '';
        }

        if (typeof content === 'string') {
            return content;
        }

        if (Array.isArray(content)) {
            const normalizedParts = [];
            for (const part of content) {
                normalizedParts.push(await Connector.normalizeMessagePart(part));
            }
            return normalizedParts;
        }

        if (typeof content === 'object' && typeof content.type === 'string') {
            return [await Connector.normalizeMessagePart(content)];
        }

        return JSON.stringify(content);
    }

    async normalizeMessageContent(content) {
        return await Connector.normalizeMessageContent(content);
    }

    /**
     * Execute a piece of SlopScript using this connector
     * @param {type} callback
     * @returns {undefined}
     */
    async run(callback) {
        let callReference = {}; // Used to track this call across execution listener notifications

        // Create a new AbortController for this run
        this.abortController = new AbortController();
        this._isCancelled = false;

        // Push the connector to its own stack (for nested calls)
        this.connectorStack.push(this);
        this.notifyExecutionListeners({
            reference: callReference,
            type: Connector.EXECUTION_TYPE.STACK_ENTRY,
            context: {
                call: callback,
                connector: this
            }
        });

        // Call the provided code, and pop the stack regardless of whether it fails
        let result;
        try {
            result = await callback();
            console.log('Result is ', result);
        } catch (ex) {
            this.notifyExecutionListeners({
                reference: callReference,
                type: Connector.EXECUTION_TYPE.STACK_EXCEPTION,
                context: {
                    call: callback,
                    connector: this,
                    error: ex,
                }
            });
            throw ex;
        } finally {
            this.notifyExecutionListeners({
                reference: callReference,
                type: Connector.EXECUTION_TYPE.STACK_RETURN,
                context: {
                    call: callback,
                    connector: this,
                    returnValue: result
                }
            });

            // POP!
            let connector = this.connectorStack.pop();
            if (connector !== this) {
                console.warn('FIXME: SlopScript connector stack inconsistency detected, stack has crashed! Popped a connector different than the expected "this"', connector, this);
                throw new Error('SlopScript connector stack crashed! Execution stopped');
            }
        }
        return result;
    }

    notifyExecutionListeners(stateUpdate) {
        // Notify all listeners on the current connector
        this.executionListeners.forEach(listener => {
            try {
                listener.callback(stateUpdate);
            } catch (ex) {
                console.warn('SlopScript Connector execution listener failed during notify:', ex);
            }
        });

        // Then iterate the connector stack and notify listeners if they have the subtree property set to true
        this.connectorStack.forEach(stackFrame => {
            if (stackFrame === this) return;
            stackFrame.executionListeners.forEach(listener => {
                if (listener.subtree) {
                    try {
                        listener.callback(stateUpdate);
                    } catch (ex) {
                        console.warn('SlopScript Connector execution listener failed during notify:', ex);
                    }
                }
            });
        });
    }

    addExecutionListener(callback, options = {}) {
        let listener = Object.assign({}, options, { callback: callback });
        this.executionListeners.push(listener);
    }

    removeExecutionListener(callback) {
        this.executionListeners = this.executionListeners.filter(listener => listener.callback !== callback);
    }

    /**
     * @deprecated Use instance method or access connector via this.connector on slop instances
     * This static method is kept for backwards compatibility but should not be used in concurrent scenarios
     */
    static getCurrent() {
        if (!window.SlopScript || !window.SlopScript.connectorStack) throw new Error('Attempt to access Connector.getCurrent() without a running SlopScript environment, was SlopScript properly initialized?');
        if (window.SlopScript.connectorStack.length < 1) throw new Error('No SlopScript Connector while calling Connector.getCurrent() - Are you calling SlopScript code without a wrapping aiConnector.run(()=>{...} call?');
        return window.SlopScript.connectorStack[window.SlopScript.connectorStack.length - 1];
    }

    /**
     * Get the current connector from the instance stack
     * @returns {Connector} The current connector (top of stack)
     */
    getCurrent() {
        if (this.connectorStack.length < 1) {
            return this; // If stack is empty, return self
        }
        return this.connectorStack[this.connectorStack.length - 1];
    }
};
