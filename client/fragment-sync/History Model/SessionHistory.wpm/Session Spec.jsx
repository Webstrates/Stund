const applicationOutputs = {
    'application.chat.entry': false,
    'application.chat.step': false,
    'application.interaction.document.textChanged': false,
    'application.interaction.shape.colorChanged': true,
    'application.interaction.shape.created': false,
    'application.interaction.shape.deleted': false,
    'application.interaction.shape.moved': true,
    'application.interaction.shape.textChanged': true,
    'application.state.event': false,
    'application.widget.widgetEvent': false
};

function readSchema(name) {
    const fragment = Fragment.one(`#EventSchema code-fragment[name="${name}"]`);
    if (!fragment) throw new Error(`Session schema fragment is missing: ${name}.`);
    let schema;
    try {
        schema = JSON.parse(fragment.raw);
    } catch {
        throw new Error(`Session schema fragment contains invalid JSON: ${name}.`);
    }
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        throw new Error(`Session schema fragment must contain an object: ${name}.`);
    }
    return schema;
}

function normalizeSchemaReferences(value) {
    if (Array.isArray(value)) return value.map(normalizeSchemaReferences);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.entries(value).map(([key, child]) => {
            if (
                (key === '$ref' || key === '$id') &&
                typeof child === 'string' &&
                /^[\w.-]+\.json(?:#.*)?$/.test(child)
            ) {
                return [key, `stund://${child}`];
            }
            return [key, normalizeSchemaReferences(child)];
        })
    );
}

function validateReferences(schema, schemas, schemaId, root = schema) {
    if (!schema || typeof schema !== 'object') return;
    if (typeof schema.$ref === 'string') {
        const [target, pointer] = schema.$ref.split('#');
        let referenced = target ? schemas[target] : root;
        if (!referenced) throw new Error(`Session schema ${schemaId} has an unresolved reference: ${schema.$ref}.`);
        if (pointer) {
            if (!pointer.startsWith('/'))
                throw new Error(`Session schema ${schemaId} has an unsupported reference: ${schema.$ref}.`);
            for (const segment of pointer.slice(1).split('/')) {
                const key = decodeURIComponent(segment).replace(/~1/g, '/').replace(/~0/g, '~');
                referenced = referenced && Object.hasOwn(referenced, key) ? referenced[key] : undefined;
            }
            if (referenced === undefined)
                throw new Error(`Session schema ${schemaId} has an unresolved reference: ${schema.$ref}.`);
        }
    }
    for (const child of Object.values(schema)) validateReferences(child, schemas, schemaId, root);
}

export function buildSessionSpec(defaultSpec) {
    if (!Array.isArray(defaultSpec?.processors) || !Array.isArray(defaultSpec?.models)) {
        throw new Error('The history server returned an invalid default spec.');
    }
    const schemas = {};
    const outputs = {};
    for (const [eventType, internal] of Object.entries(applicationOutputs)) {
        const schemaId = `stund://${eventType}.json`;
        schemas[schemaId] = normalizeSchemaReferences(readSchema(eventType));
        outputs[eventType] = { schemaId, internal };
    }
    schemas['stund://shape.json'] = normalizeSchemaReferences(readSchema('shape'));
    for (const [schemaId, schema] of Object.entries(schemas)) validateReferences(schema, schemas, schemaId);

    const spec = JSON.parse(JSON.stringify(defaultSpec));
    spec.processors = spec.processors.filter((processor) => processor.name !== 'application0');
    spec.processors.push({
        name: 'application0',
        type: 'EventStreamProcessor',
        config: { inputs: { 'application\\.(.*)': {} }, outputs, schemas }
    });
    return spec;
}
