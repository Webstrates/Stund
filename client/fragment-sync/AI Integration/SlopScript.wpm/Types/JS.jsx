export class js {
    static getJSONSchema() {
        return {
            type: 'string',
            description: 'JavaScript code as a string. For arrow functions use format: "(arg) => { ...code... }"'
        };
    }

    static getValueFromJSON(value) {
        // The value is a string containing JavaScript code
        // We evaluate it to get the actual function
        if (typeof value !== 'string') {
            throw new Error('JavaScript code must be provided as a string');
        }
        try {
            return eval(value);
        } catch (ex) {
            throw new Error('Failed to evaluate JavaScript code: ' + ex.message);
        }
    }
}
