const LEGACY_TLDRAW_SCHEMA_4_2_1 = {
    schemaVersion: 2,
    sequences: {
        'com.tldraw.store': 5,
        'com.tldraw.asset': 1,
        'com.tldraw.camera': 1,
        'com.tldraw.document': 2,
        'com.tldraw.instance': 25,
        'com.tldraw.instance_page_state': 5,
        'com.tldraw.page': 1,
        'com.tldraw.instance_presence': 6,
        'com.tldraw.pointer': 1,
        'com.tldraw.shape': 4,
        'com.tldraw.asset.bookmark': 2,
        'com.tldraw.asset.image': 5,
        'com.tldraw.asset.video': 5,
        'com.tldraw.shape.group': 0,
        'com.tldraw.shape.text': 3,
        'com.tldraw.shape.bookmark': 2,
        'com.tldraw.shape.draw': 2,
        'com.tldraw.shape.geo': 10,
        'com.tldraw.shape.note': 9,
        'com.tldraw.shape.line': 5,
        'com.tldraw.shape.frame': 1,
        'com.tldraw.shape.arrow': 7,
        'com.tldraw.shape.highlight': 1,
        'com.tldraw.shape.embed': 4,
        'com.tldraw.shape.image': 5,
        'com.tldraw.shape.video': 4,
        'com.tldraw.binding.arrow': 1
    }
};



function schemasMatch(leftSchema, rightSchema) {
    return JSON.stringify(leftSchema) === JSON.stringify(rightSchema);
}



export function migrateTldrawStore({ store, records, persistedSchema }) {
    const currentSchema = store.schema.serialize();
    const sourceSchema = persistedSchema || LEGACY_TLDRAW_SCHEMA_4_2_1;
    const serializedStore = Object.fromEntries(records.map((record) => [record.id, record]));
    const migrationResult = store.schema.migrateStoreSnapshot({
        schema: sourceSchema,
        store: serializedStore
    });

    if (migrationResult.type !== 'success') {
        throw new Error(`Failed to migrate the persisted tldraw document: ${migrationResult.reason}`);
    }

    store.loadStoreSnapshot({
        schema: currentSchema,
        store: migrationResult.value
    });

    return {
        records: Object.values(migrationResult.value),
        schema: currentSchema,
        shouldRewriteSnapshot: !persistedSchema || !schemasMatch(persistedSchema, currentSchema)
    };
}
