import React from 'react';
const { useEffect, useState } = React;
import {
    DocumentRecordType,
    InstancePresenceRecordType,
    PageRecordType,
    createPresenceStateDerivation,
    react
} from 'tldraw';
import { migrateTldrawStore } from '#App .tldraw-migration';
import { readLastJsonObject } from '#CoreHelpers .string-utils';



const SCHEMA_TAG_NAME = 'tldraw-schema';
const CANVAS_STATE_REPLACING_EVENT = 'tldraw-canvas-state-replacing';



function isSchemaElement(element) {
    return element?.nodeType === Node.ELEMENT_NODE
        && element.tagName.toLowerCase() === SCHEMA_TAG_NAME;
}

function stripProtection(element) {
    if (typeof WPMv2 !== 'undefined' && typeof WPMv2.stripProtection === 'function') {
        WPMv2.stripProtection(element);
    }
}

export function useDOMSync({ store, node }) {
    const [migrationState, setMigrationState] = useState({
        store: null,
        error: undefined
    });

    useEffect(() => {
        setMigrationState({ store, error: undefined });

        if (!store) {
            setMigrationState({
                store,
                error: new Error('The tldraw store is unavailable.')
            });
            return;
        }
        if (!node) {
            setMigrationState({
                store,
                error: new Error('The persisted tldraw document is unavailable.')
            });
            return;
        }

        const cleanups = [];
        let observer = null;
        let isReplacingCanvasState = false;

        function runCleanups() {
            cleanups.splice(0).reverse().forEach((cleanup) => {
                try {
                    cleanup();
                } catch (error) {
                    console.warn('Failed to clean up tldraw DOM synchronization.', error);
                }
            });
        }

        function getPath(record) {
            const separatorIndex = record.id.indexOf(':');
            if (separatorIndex < 1 || separatorIndex === record.id.length - 1) {
                throw new Error(`Invalid tldraw record id: ${record.id}`);
            }

            return [record.id.slice(0, separatorIndex), record.id.slice(separatorIndex + 1)];
        }

        function findElement(record) {
            const [type, id] = getPath(record);
            return node.querySelector(`${type}[id="${CSS.escape(id)}"]`);
        }

        function createRecordElement(record) {
            const [type, id] = getPath(record);
            const element = document.createElement(type);
            element.id = id;
            element.textContent = JSON.stringify(record);
            stripProtection(element);
            return element;
        }

        function addRecord(record) {
            node.appendChild(createRecordElement(record));
        }

        function upsertRecord(record) {
            const element = findElement(record);
            if (!element) {
                addRecord(record);
                return;
            }

            element.textContent = JSON.stringify(record);
        }

        function removeRecord(record) {
            const element = findElement(record);
            if (!element) return;
            element.remove();
        }

        function readRecordElement(element) {
            const expectedId = `${element.tagName.toLowerCase()}:${element.id}`;
            const record = readLastJsonObject(element, (value) => value.id === expectedId);
            if (!record) {
                throw new Error(`Invalid tldraw record in <${element.tagName.toLowerCase()}>.`);
            }
            return record;
        }

        function getSchemaElement() {
            return Array.from(node.children).find(isSchemaElement) || null;
        }

        function readPersistedSchema() {
            const schemaElement = getSchemaElement();
            if (!schemaElement) return null;

            const schema = readLastJsonObject(schemaElement);
            if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
                throw new Error('The persisted tldraw schema is invalid.');
            }
            return schema;
        }

        function writePersistedSchema(schema) {
            let schemaElement = getSchemaElement();
            if (!schemaElement) {
                schemaElement = document.createElement(SCHEMA_TAG_NAME);
                stripProtection(schemaElement);
                node.insertBefore(schemaElement, node.firstChild);
            }
            schemaElement.textContent = JSON.stringify(schema);
        }

        function replacePersistedSnapshot(records, schema) {
            const fragment = document.createDocumentFragment();
            const schemaElement = document.createElement(SCHEMA_TAG_NAME);
            schemaElement.textContent = JSON.stringify(schema);
            stripProtection(schemaElement);
            fragment.appendChild(schemaElement);

            records.forEach((record) => {
                fragment.appendChild(createRecordElement(record));
            });

            node.replaceChildren(fragment);
        }

        function initializeStoreFromDOM() {
            const recordElements = Array.from(node.children).filter((element) => !isSchemaElement(element));
            const currentSchema = store.schema.serialize();

            if (recordElements.length === 0) {
                store.clear();
                store.put([
                    DocumentRecordType.create({
                        id: 'document:document'
                    }),
                    PageRecordType.create({
                        id: 'page:page',
                        name: 'Page 1',
                        index: 'a1'
                    })
                ]);

                replacePersistedSnapshot(store.allRecords(), currentSchema);
                return;
            }

            const records = recordElements.map(readRecordElement);
            const persistedSchema = readPersistedSchema();
            const migration = migrateTldrawStore({
                store,
                records,
                persistedSchema
            });

            if (migration.shouldRewriteSnapshot) {
                replacePersistedSnapshot(migration.records, migration.schema);
            } else {
                writePersistedSchema(migration.schema);
            }
        }

        function getDirectRecordElement(target) {
            let current = target?.nodeType === Node.ELEMENT_NODE
                ? target
                : target?.parentElement;

            while (current && current.parentElement !== node) {
                current = current.parentElement;
            }

            if (!current || current.parentElement !== node || isSchemaElement(current)) return null;
            return current;
        }

        function processMutations(mutationsList) {
            if (isReplacingCanvasState) return;

            const recordsToPut = new Map();
            const recordIdsToRemove = new Set();

            for (const mutation of mutationsList) {
                if (mutation.target !== node) {
                    const recordElement = getDirectRecordElement(mutation.target);
                    if (!recordElement) continue;

                    try {
                        const record = readRecordElement(recordElement);
                        recordIdsToRemove.delete(record.id);
                        recordsToPut.set(record.id, record);
                    } catch (error) {
                        console.warn('Ignoring unreadable updated tldraw DOM record.', error);
                    }
                    continue;
                }

                mutation.removedNodes.forEach((removedNode) => {
                    if (removedNode.nodeType !== Node.ELEMENT_NODE || isSchemaElement(removedNode)) return;

                    try {
                        const record = readRecordElement(removedNode);
                        recordsToPut.delete(record.id);
                        recordIdsToRemove.add(record.id);
                    } catch (error) {
                        console.warn('Ignoring unreadable removed tldraw DOM record.', error);
                    }
                });

                mutation.addedNodes.forEach((addedNode) => {
                    if (addedNode.nodeType !== Node.ELEMENT_NODE || isSchemaElement(addedNode)) return;

                    try {
                        const record = readRecordElement(addedNode);
                        recordIdsToRemove.delete(record.id);
                        recordsToPut.set(record.id, record);
                    } catch (error) {
                        console.warn('Ignoring unreadable added tldraw DOM record.', error);
                    }
                });
            }

            if (recordIdsToRemove.size === 0 && recordsToPut.size === 0) return;

            store.mergeRemoteChanges(() => {
                if (recordIdsToRemove.size > 0) {
                    store.remove(Array.from(recordIdsToRemove));
                }
                if (recordsToPut.size > 0) {
                    store.put(Array.from(recordsToPut.values()));
                }
            });
        }

        function startObserver() {
            if (!observer || isReplacingCanvasState) return;
            observer.observe(node, {
                childList: true,
                subtree: true,
                characterData: true
            });
        }

        function stopObserver({ processPending = true } = {}) {
            if (!observer) return;

            const pendingMutations = observer.takeRecords();
            observer.disconnect();
            if (processPending && pendingMutations.length > 0) {
                processMutations(pendingMutations);
            }
        }

        function executeNonObserved(method) {
            stopObserver();
            try {
                method();
            } finally {
                startObserver();
            }
        }

        try {
            initializeStoreFromDOM();

            observer = new MutationObserver(processMutations);
            startObserver();
            cleanups.push(() => stopObserver({ processPending: false }));

            const canvasStateReplacingHandler = () => {
                isReplacingCanvasState = true;
                stopObserver({ processPending: false });
            };
            window.addEventListener(CANVAS_STATE_REPLACING_EVENT, canvasStateReplacingHandler);
            cleanups.push(() => {
                window.removeEventListener(CANVAS_STATE_REPLACING_EVENT, canvasStateReplacingHandler);
            });

            cleanups.push(store.listen(function syncTldrawToDOM({ changes }) {
                if (isReplacingCanvasState) return;
                const recordIds = new Set([
                    ...Object.keys(changes.added),
                    ...Object.keys(changes.updated),
                    ...Object.keys(changes.removed)
                ]);

                executeNonObserved(() => {
                    // Draining queued remote mutations can supersede this event.
                    // Persist the current store values, including deletions.
                    recordIds.forEach((id) => {
                        const record = store.get(id);
                        if (record) upsertRecord(record);
                        else removeRecord({ id });
                    });
                });
            }, { source: 'user', scope: 'document' }));

            const clientPresenceId = InstancePresenceRecordType.createId(webstrate.clientId);
            const currentUser = store.props.users.currentUser;
            const reactivePresence = createPresenceStateDerivation(currentUser, {
                instanceId: clientPresenceId
            })(store);
            cleanups.push(react('sync presence to webstrates', () => {
                const presence = reactivePresence.get();
                if (presence) {
                    node.webstrate.signal(presence);
                }
            }));

            const signalHandler = (message, senderId) => {
                if (senderId === webstrate.clientId) return;
                if (!message || message.typeName !== 'instance_presence') return;

                store.mergeRemoteChanges(() => {
                    store.put([message]);
                });
            };
            node.webstrate.on('signal', signalHandler);
            cleanups.push(() => node.webstrate.off('signal', signalHandler));

            const clientPartHandler = (id) => {
                store.mergeRemoteChanges(() => {
                    store.remove([InstancePresenceRecordType.createId(id)]);
                });
            };
            webstrate.on('clientPart', clientPartHandler);
            cleanups.push(() => webstrate.off('clientPart', clientPartHandler));

            setMigrationState({ store, error: null });
        } catch (error) {
            console.error('Failed to initialize the persisted tldraw document.', error);
            runCleanups();
            setMigrationState({
                store,
                error: error instanceof Error ? error : new Error(String(error))
            });
        }

        return () => {
            runCleanups();
        };
    }, [store, node]);

    const migrationError = migrationState.store === store
        ? migrationState.error
        : undefined;
    return [store, migrationError];
}
