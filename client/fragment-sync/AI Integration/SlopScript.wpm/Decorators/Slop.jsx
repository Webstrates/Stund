import { Tool } from '#SlopScript .decorator-tool';
import { Connector } from '#SlopScript .connector';
import { js } from '#SlopScript .type-js';
import { image } from '#SlopScript .type-image';
import { shape } from '#SlopScript .type-shape';



const MAX_TOOL_CALLS = 32;
const MAX_CONSEQUTIVE_TOOL_ERRORS = 4;
const CUSTOM_TYPES = {
    'js': js,
    'image': image,
    'shape': shape
};

function convertSchemaCustomTypes(schema) {
    if (!schema || typeof schema !== 'object') {
        return schema;
    }

    const customType = getCustomType(schema);
    if (customType && typeof customType.getJSONSchema === 'function') {
        const customSchema = customType.getJSONSchema();
        return {
            ...customSchema,
            description: schema.description || customSchema.description
        };
    }

    const convertedSchema = Array.isArray(schema) ? [...schema] : { ...schema };

    if (Array.isArray(schema.anyOf)) {
        convertedSchema.anyOf = schema.anyOf.map((entry) => convertSchemaCustomTypes(entry));
    }
    if (Array.isArray(schema.oneOf)) {
        convertedSchema.oneOf = schema.oneOf.map((entry) => convertSchemaCustomTypes(entry));
    }
    if (Array.isArray(schema.allOf)) {
        convertedSchema.allOf = schema.allOf.map((entry) => convertSchemaCustomTypes(entry));
    }

    if (schema.items) {
        convertedSchema.items = convertSchemaCustomTypes(schema.items);
    }

    if (schema.properties && typeof schema.properties === 'object') {
        convertedSchema.properties = {};
        for (const [key, value] of Object.entries(schema.properties)) {
            convertedSchema.properties[key] = convertSchemaCustomTypes(value);
        }
    }

    if (schema.additionalProperties && typeof schema.additionalProperties === 'object' && !Array.isArray(schema.additionalProperties)) {
        convertedSchema.additionalProperties = convertSchemaCustomTypes(schema.additionalProperties);
    }

    return convertedSchema;
}

function convertCustomParameterTypes(tool) {
    const parameters = tool.typeDescription.parameters ? JSON.parse(JSON.stringify(tool.typeDescription.parameters)) : {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false
    };

    const convertedParameters = convertSchemaCustomTypes(parameters);

    return {
        type: 'function',
        function: {
            name: tool.context.name,
            description: tool.typeDescription.description,
            parameters: convertedParameters
        }
    };
}

function getCustomType(propSchema) {
    return CUSTOM_TYPES[propSchema?.type];
}

function getParameterNames(parameters) {
    const properties = parameters?.properties || {};
    const required = Array.isArray(parameters?.required) ? parameters.required : [];
    const optional = Object.keys(properties).filter((key) => !required.includes(key));
    return [...required, ...optional];
}

// Check return structure before accepting resolve; custom values are checked
// against their JSON schema before conversion to runtime values.
function validateReturnStructure(schema, value, path = 'result') {
    if (!schema || !schema.type) {
        return;
    }
    const actualType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const expectedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matchesType = expectedTypes.some(type => type === 'integer' ? Number.isInteger(value) : type === actualType);
    if (!matchesType) {
        throw new Error(`${path} must be ${expectedTypes.join(' or ')}; received ${actualType}. Return objects and arrays directly, without JSON.stringify.`);
    }
    if (actualType === 'object') {
        const properties = schema.properties || {};
        for (const key of schema.required || []) {
            if (!Object.prototype.hasOwnProperty.call(value, key)) {
                throw new Error(`${path}.${key} is required.`);
            }
        }
        for (const [key, childValue] of Object.entries(value)) {
            if (!Object.prototype.hasOwnProperty.call(properties, key)) {
                if (schema.additionalProperties === false) {
                    throw new Error(`${path}.${key} is not allowed by the return schema.`);
                }
                continue;
            }
            validateReturnStructure(properties[key], childValue, `${path}.${key}`);
        }
    } else if (actualType === 'array' && schema.items) {
        value.forEach((item, index) => validateReturnStructure(schema.items, item, `${path}[${index}]`));
    }
}

async function convertCustomTypeValue(customType, value) {
    if (!customType || typeof customType.getValueFromJSON !== 'function') {
        return value;
    }

    const convertedValue = customType.getValueFromJSON(value);
    if (convertedValue && typeof convertedValue.then === 'function') {
        return await convertedValue;
    }

    return convertedValue;
}

async function convertSchemaValueFromJSON(schema, value) {
    const customType = getCustomType(schema);
    if (customType) {
        return await convertCustomTypeValue(customType, value);
    }

    if (schema?.type === 'array' && schema.items) {
        if (!Array.isArray(value)) {
            return value;
        }

        const convertedItems = [];
        for (let index = 0; index < value.length; index++) {
            convertedItems.push(await convertSchemaValueFromJSON(schema.items, value[index]));
        }
        return convertedItems;
    }

    if (schema?.type === 'object' && schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
        const convertedValue = { ...value };
        for (const [key, childSchema] of Object.entries(schema.properties)) {
            if (!Object.prototype.hasOwnProperty.call(convertedValue, key)) {
                continue;
            }
            convertedValue[key] = await convertSchemaValueFromJSON(childSchema, convertedValue[key]);
        }
        return convertedValue;
    }

    return value;
}

function buildMethodBodyMessageWithImages(methodBody, imageAttachments) {
    if (!Array.isArray(imageAttachments) || imageAttachments.length < 1) {
        return methodBody;
    }

    const content = [{
        type: 'text',
        text: methodBody
    }];

    imageAttachments.forEach((attachment) => {
        content.push({
            type: 'image_blob',
            blob: attachment.blob,
            mimeType: attachment.mimeType,
            detail: attachment.detail || 'auto'
        });
    });

    return content;
}

export function Slop(typeDescription) {
    return function (originalMethod, context) {
        var methodName = String(context.name);
        var extractedContent = null;

        // Convert the function to a string
        var functionString = originalMethod.toString();

        // Attempt to extract the string literal from the function body string.
        // This is brittle and relies on a very specific function body format.
        // It looks for functionName() { `...` }
        var match = functionString.match(/\{[\s]*[`]([^`]+)[`][\s]*;?[\s]*\}/);

        if (match && match[1]) {
            extractedContent = match[1];
        }
        if (extractedContent === null) {
            console.log(methodName, functionString);
            throw new Error('[Slop Decorator] No AI slop string literal content found via toString or format mismatch, must use backticks `...` because programmer lazy');
        }

        // TODO: Check returnTypeDescription

        // Force a fake function onto the stack for stacktrace purposes
        async function slopFunctionParser(...args) {
            // Get connector from the slop instance
            const connector = this.connector;
            if (!connector) {
                throw new Error('No connector set on slop instance. Make sure to set instance.connector before calling slop methods.');
            }

            const imageArgumentAttachments = [];

            let callReference = {};
            connector.getCurrent().notifyExecutionListeners({
                reference: callReference,
                type: Connector.EXECUTION_TYPE.SLOP_CALL,
                context: {
                    args: args,
                    target: this,
                    name: methodName,
                    rawPrompt: extractedContent
                }
            });

            async function mapArgument(argument, index) {
                const params = typeDescription.parameters;
                const paramNames = getParameterNames(params);
                let result = null;

                async function prepareArgumentValueForPrompt(value, schema, contextInfo) {
                    const customType = getCustomType(schema);
                    if (customType && typeof customType.prepareValueForPrompt === 'function') {
                        const preparedValue = await customType.prepareValueForPrompt(value, contextInfo);
                        let preparedArgumentValue = value;

                        if (preparedValue && preparedValue.valueForPrompt !== undefined) {
                            preparedArgumentValue = preparedValue.valueForPrompt;
                        }

                        if (Array.isArray(preparedValue?.attachments) && preparedValue.attachments.length > 0) {
                            imageArgumentAttachments.push(...preparedValue.attachments);
                        }

                        return preparedArgumentValue;
                    }

                    if (schema?.type === 'array' && schema.items) {
                        if (value === undefined || value === null) {
                            return [];
                        }
                        if (!Array.isArray(value)) {
                            throw new Error(`Argument "${contextInfo.paramName}" must be an array.`);
                        }

                        const convertedItems = [];
                        for (let itemIndex = 0; itemIndex < value.length; itemIndex++) {
                            convertedItems.push(await prepareArgumentValueForPrompt(value[itemIndex], schema.items, {
                                ...contextInfo,
                                paramName: `${contextInfo.paramName}[${itemIndex}]`,
                                paramArrayIndex: itemIndex
                            }));
                        }
                        return convertedItems;
                    }

                    if (schema?.type === 'object' && schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
                        const convertedObject = { ...value };
                        for (const [childKey, childSchema] of Object.entries(schema.properties)) {
                            if (!Object.prototype.hasOwnProperty.call(convertedObject, childKey)) {
                                continue;
                            }
                            convertedObject[childKey] = await prepareArgumentValueForPrompt(convertedObject[childKey], childSchema, {
                                ...contextInfo,
                                paramName: `${contextInfo.paramName}.${childKey}`
                            });
                        }
                        return convertedObject;
                    }

                    return value;
                }

                if (index < paramNames.length) {
                    const paramName = paramNames[index];
                    const paramSchema = params.properties?.[paramName] || {};
                    const argumentValue = await prepareArgumentValueForPrompt(argument, paramSchema, {
                        methodName: methodName,
                        paramName: paramName,
                        paramIndex: index
                    });

                    result = {
                        name: paramName,
                        ...convertSchemaCustomTypes(paramSchema),
                        value: argumentValue
                    };
                } else {
                    if (argument === undefined) throw new Error('Argument ' + (index + 1) + ' from ' + methodName + '(...) could not be resolved, if you linked a tool check the spelling');
                    throw new Error('Argument ' + (index + 1) + ' from ' + methodName + '(...) ignored as type description only specifies ' + paramNames.length + ' arguments');
                }

                return result;
            }

            function mapReturnType() {
                if (!typeDescription.returns) return 'The method has no return type';
                // Handle JSON Schema format
                if (typeof typeDescription.returns === 'object' && typeDescription.returns.type) {
                    return typeDescription.returns.type;
                }
                // Handle custom types with name property
                if (typeDescription.returns.name) {
                    return typeDescription.returns.name;
                }
                return JSON.stringify(typeDescription.returns);
            }

            function parseImplicitResolveContent(content, returnSchema) {
                const textContent = typeof content === 'string' ? content : (content ?? '');

                if (!returnSchema) {
                    return undefined;
                }

                if (returnSchema.type === 'string') {
                    return String(textContent);
                }

                if (returnSchema.type === 'object') {
                    if (typeof textContent === 'string' && textContent.trim()) {
                        try {
                            const parsedContent = JSON.parse(textContent);
                            if (parsedContent && typeof parsedContent === 'object' && !Array.isArray(parsedContent)) {
                                return parsedContent;
                            }
                        } catch (ex) {
                            // JSON-looking replies must be repaired by the model, not
                            // wrapped in content and shown verbatim in the chat.
                            if (/^\s*[\[{]/.test(textContent) || /^\s*```/.test(textContent)) {
                                return textContent;
                            }
                        }
                    }

                    if (returnSchema.properties?.content?.type === 'string') {
                        return {
                            content: String(textContent)
                        };
                    }
                }

                if (returnSchema.type === 'array' && typeof textContent === 'string' && textContent.trim()) {
                    try {
                        const parsedContent = JSON.parse(textContent);
                        if (Array.isArray(parsedContent)) {
                            return parsedContent;
                        }
                    } catch (ex) {
                        // Keep the raw content as the implicit result below.
                    }
                }

                if ((returnSchema.type === 'number' || returnSchema.type === 'integer' || returnSchema.type === 'boolean') &&
                    typeof textContent === 'string' && textContent.trim()) {
                    try {
                        return JSON.parse(textContent);
                    } catch (ex) {
                        return textContent;
                    }
                }

                return textContent;
            }

            function getImplicitResolveArguments(content) {
                if (!typeDescription.returns) {
                    return '{}';
                }

                const returnSchema = typeof typeDescription.returns === 'object' && typeDescription.returns.type
                    ? typeDescription.returns
                    : { type: 'string' };

                return JSON.stringify({
                    result: parseImplicitResolveContent(content, returnSchema)
                });
            }

            let tools = args.filter(o => o && o.isInvokableTool);

            // Special tools
            let resolveTool = function resolve(...args) {
            }
            resolveTool.context = {
                name: 'resolve'
            };
            resolveTool.typeDescription = {
                description: 'Return from the method call with the return value as argument. If the method does not return anything and only has side-effects you may use resolve() without an argument.',
                parameters: {
                    type: 'object',
                    properties: {},
                    required: [],
                    additionalProperties: false
                }
            };
            if (typeDescription.returns) {
                // Add result parameter if there's a return type
                const returnSchema = typeof typeDescription.returns === 'object' && typeDescription.returns.type
                    ? typeDescription.returns
                    : { type: 'string' };
                resolveTool.typeDescription.parameters.properties.result = {
                    ...returnSchema,
                    description: 'The return value from the method call'
                };
                resolveTool.typeDescription.parameters.required.push('result');
                if (returnSchema.type === 'object' && returnSchema.properties?.content?.type === 'string') {
                    resolveTool.typeDescription.description += ' Send arguments as {"result":{"content":"Your answer","shapeContext":[]}}. result is an object; content contains only the user-facing answer. Never put a serialized reply object inside result or content.';
                    resolveTool.typeDescription.parameters.properties.result.description = 'The reply object itself, not a JSON string. Put the answer text in content and optional shape metadata in shapeContext.';
                }
                // Store custom type if present
                if (typeDescription.returns.getJSONSchema) {
                    resolveTool.typeDescription._customTypes = { result: typeDescription.returns };
                }
            }
            tools.push(resolveTool);

            let rejectTool = function reject(...args) {
            }
            rejectTool.context = {
                name: 'reject'
            };
            rejectTool.typeDescription = {
                description: 'Throw an exception in the method, the reason must be provided as string argument. This can also be used to communicate that it is impossible to complete the method call.',
                parameters: {
                    type: 'object',
                    properties: {
                        error: {
                            type: 'string',
                            description: 'The exception description'
                        }
                    },
                    required: ['error'],
                    additionalProperties: false
                }
            };
            tools.push(rejectTool);

            // Convert tools to OpenAI function format
            const openAITools = tools.map(convertCustomParameterTypes);

            // The current object properties are:
            // ${JSON.stringify(this)}

            const methodArguments = args.filter((argument) => !(argument && argument.isInvokableTool));
            const mappedArguments = (await Promise.all(methodArguments.map((argument, index) => mapArgument(argument, index)))).filter((entry) => entry != null);
            const methodBodyContent = buildMethodBodyMessageWithImages(extractedContent, imageArgumentAttachments);

            const instruction = `You are being called as part of a program.
The user called a method on an object and you must carry out the method body given to you.

The method argument list is:
${JSON.stringify(mappedArguments)}

Return value type:
${mapReturnType()}

You have access to the tools defined in this request. Use them to execute the method.
You can call multiple tools in parallel if they are independent.
When you have completed the method execution, call the 'resolve' tool with the return value (if any).
If you cannot complete the method, call the 'reject' tool with an error message.

The method body will be posted by the user immediately after this instruction. Please "execute" the method based
on the method body and the arguments given.`;

            // TODO: Check runtime arguments

            let history = [];
            history.push({ role: 'system', content: instruction });
            history.push({ role: 'user', content: methodBodyContent });

            // Parse the tool call using native function calling
            let currentConsequtiveToolErrors = 0;
            for (let i = 0; i < MAX_TOOL_CALLS; i++) {
                // Check if execution has been cancelled
                if (connector.getCurrent().isCancelled) {
                    throw new Error('Execution cancelled');
                }

                if (currentConsequtiveToolErrors > MAX_CONSEQUTIVE_TOOL_ERRORS) throw new Error('Slop function failed with a consequtive error limit of ' + MAX_CONSEQUTIVE_TOOL_ERRORS);

                let result = await connector.getCurrent().completion(history, openAITools);
                if (!result || typeof result !== 'object') {
                    result = {
                        content: result || ''
                    };
                }

                // Treat a text-only response as an implicit resolve() call.
                if (!result.tool_calls || result.tool_calls.length === 0) {
                    result = {
                        ...result,
                        content: result.content || null,
                        tool_calls: [{
                            id: 'implicit_resolve_' + i,
                            type: 'function',
                            function: {
                                name: 'resolve',
                                arguments: getImplicitResolveArguments(result.content)
                            },
                            isImplicitResolve: true
                        }]
                    };
                }

                // Add assistant message with tool calls to history
                history.push({
                    role: 'assistant',
                    content: result.content || null,
                    tool_calls: result.tool_calls
                });

                // Process all tool calls (supports parallel function calling)
                const toolResults = [];
                let shouldReturn = false;
                let returnValue = undefined;
                let isImplicitResolveReturn = false;
                let shouldThrow = false;
                let throwError = null;

                for (const toolCall of result.tool_calls) {
                    const toolName = toolCall.function.name;
                    let toolArgs;

                    try {
                        toolArgs = JSON.parse(toolCall.function.arguments);
                    } catch (ex) {
                        connector.getCurrent().notifyExecutionListeners({
                            reference: callReference,
                            type: Connector.EXECUTION_TYPE.SLOP_SYNTAX_EXCEPTION,
                            context: {
                                rawReply: toolCall.function.arguments,
                                error: new Error('Failed to parse tool arguments: ' + ex.message)
                            }
                        });
                        currentConsequtiveToolErrors++;
                        toolResults.push({
                            tool_call_id: toolCall.id,
                            role: 'tool',
                            content: JSON.stringify({ error: 'Failed to parse arguments: ' + ex.message })
                        });
                        continue;
                    }

                    // Find the matching tool
                    let tool = tools.find(t => t.context.name === toolName);
                    if (!tool) {
                        currentConsequtiveToolErrors++;
                        toolResults.push({
                            tool_call_id: toolCall.id,
                            role: 'tool',
                            content: JSON.stringify({ error: "No such tool '" + toolName + "'" })
                        });
                        continue;
                    }

                    // Map arguments to values based on parameter types
                    let argumentValues;
                    try {
                        const parameters = tool.typeDescription.parameters;
                        if (tool === resolveTool) {
                            try {
                                validateReturnStructure(convertSchemaCustomTypes(parameters), toolArgs, 'arguments');
                                if (parameters.properties?.result?.properties?.content?.type === 'string') {
                                    let embeddedReply;
                                    try {
                                        embeddedReply = JSON.parse(toolArgs.result.content);
                                    } catch (error) {
                                        // User-facing text normally is not JSON.
                                    }
                                    if (embeddedReply && typeof embeddedReply.content === 'string' && Array.isArray(embeddedReply.shapeContext)) {
                                        throw new Error('result.content contains a serialized reply. Move its content text to result.content and its shapes to result.shapeContext.');
                                    }
                                }
                            } catch (error) {
                                throw new Error(`Invalid resolve arguments: ${error.message} ${resolveTool.typeDescription.description} Retry resolve with the corrected result; do not repeat completed actions.`);
                            }
                        }
                        const requiredParams = parameters?.required || [];
                        const properties = parameters?.properties || {};
                        const parameterOrder = getParameterNames(parameters);
                        argumentValues = [];

                        for (const paramName of parameterOrder) {
                            const hasValue = Object.prototype.hasOwnProperty.call(toolArgs, paramName);
                            if (!hasValue) {
                                if (requiredParams.includes(paramName)) {
                                    throw new Error('Missing required argument: ' + paramName);
                                }
                                continue;
                            }

                            const value = toolArgs[paramName];
                            argumentValues.push(await convertSchemaValueFromJSON(properties[paramName], value));
                        }
                    } catch (ex) {
                        currentConsequtiveToolErrors++;
                        toolResults.push({
                            tool_call_id: toolCall.id,
                            role: 'tool',
                            content: JSON.stringify({ error: ex.message })
                        });
                        continue;
                    }

                    // Execute the tool
                    let toolResult;
                    let toolCallReference = {};
                    try {
                        connector.getCurrent().notifyExecutionListeners({
                            reference: toolCallReference,
                            type: Connector.EXECUTION_TYPE.TOOL_CALL,
                            context: {
                                slopCallReference: callReference,
                                args: argumentValues,
                                target: this,
                                name: tool.context.name,
                                tool: tool,
                                isImplicitResolve: Boolean(toolCall.isImplicitResolve)
                            }
                        });

                        // Handle special control flow tools
                        if (tool === resolveTool) {
                            shouldReturn = true;
                            isImplicitResolveReturn = Boolean(toolCall.isImplicitResolve);
                            if (argumentValues.length > 0) {
                                returnValue = argumentValues[0];
                            }
                            toolResult = 'Method will return' + (returnValue !== undefined ? ' with value: ' + JSON.stringify(returnValue) : '');
                        } else if (tool === rejectTool) {
                            shouldThrow = true;
                            throwError = new Error(argumentValues[0]);
                            toolResult = 'Method will throw: ' + argumentValues[0];
                        } else {
                            toolResult = await tool.call(this, ...argumentValues);
                        }

                        // TODO: Check length against context window

                        toolResults.push({
                            tool_call_id: toolCall.id,
                            role: 'tool',
                            content: JSON.stringify(toolResult)
                        });

                    } catch (ex) {
                        connector.getCurrent().notifyExecutionListeners({
                            reference: toolCallReference,
                            type: Connector.EXECUTION_TYPE.TOOL_EXCEPTION,
                            context: {
                                slopCallReference: callReference,
                                name: tool.context.name,
                                tool: tool,
                                error: ex
                            }
                        });
                        toolResults.push({
                            tool_call_id: toolCall.id,
                            role: 'tool',
                            content: JSON.stringify({ error: ex.toString() })
                        });
                        continue;
                    } finally {
                        connector.getCurrent().notifyExecutionListeners({
                            reference: toolCallReference,
                            type: Connector.EXECUTION_TYPE.TOOL_RETURN,
                            context: {
                                slopCallReference: callReference,
                                name: tool.context.name,
                                tool: tool,
                                isImplicitResolve: Boolean(toolCall.isImplicitResolve),
                                returnValue: toolResult
                            }
                        });
                    }
                }

                // Add all tool results to history
                history.push(...toolResults);

                // Handle control flow after processing all tool calls
                if (shouldReturn) {
                    connector.getCurrent().notifyExecutionListeners({
                        reference: callReference,
                        type: Connector.EXECUTION_TYPE.SLOP_RETURN,
                        context: {
                            name: methodName,
                            returnValue: returnValue,
                            isImplicitResolve: isImplicitResolveReturn,
                            history: history
                        }
                    });
                    return returnValue;
                }

                if (shouldThrow) {
                    connector.getCurrent().notifyExecutionListeners({
                        reference: callReference,
                        type: Connector.EXECUTION_TYPE.SLOP_EXCEPTION,
                        context: {
                            target: this,
                            name: methodName,
                            error: throwError,
                            history: history
                        }
                    });
                    throw throwError;
                }

                // Reset consecutive errors on successful tool execution
                currentConsequtiveToolErrors = 0;
            }

            throw new Error('Slop function could not complete within a call limit of ' + MAX_TOOL_CALLS);
        };

        // Push a function with a name similar to the called slop function onto the stack to aid in debugging
        // Also make this Slop a Tool
        return new Tool(typeDescription)(new Function('slopFunctionParser', 'return function ' + methodName + '$slopWrapper(...args){return slopFunctionParser.call(this, ...args)}')(slopFunctionParser), context);
    };
};
