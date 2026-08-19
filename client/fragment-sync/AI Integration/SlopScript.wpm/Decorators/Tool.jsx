export function Tool(typeDescription) {
    return function (originalMethod, context) {
        // originalMethod: The actual function being decorated.
        // context: An object with metadata about the method.
        originalMethod.isInvokableTool = true;

        // Ensure parameters has proper structure
        if (!typeDescription.parameters) {
            typeDescription.parameters = {
                type: 'object',
                properties: {},
                required: [],
                additionalProperties: false
            };
        }

        originalMethod.typeDescription = typeDescription;
        originalMethod.context = context;
        return originalMethod;
    };
};
