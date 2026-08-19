import { zipSync, unzipSync, strFromU8, strToU8 } from 'fflate';
import { setDOMState } from '#CoreHelpers .dom-store';
import { safeJsonParse } from '#CoreHelpers .string-utils';
import {
    DEFAULT_SESSION_HISTORY_SERVER,
    normalizeSessionHistoryServerUrl
} from '#SessionHistory .api';


const DEFAULT_STORE_ID = 'default';
const DEFAULT_EXPORT_BASE_NAME = 'stund-state-transfer';
const UNKNOWN_STUND_VERSION = 'Unknown';

const CANVAS_SELECTOR = 'tldraw-document';
const CANVAS_SCHEMA_SELECTOR = ':scope > tldraw-schema';
const CANVAS_STATE_REPLACING_EVENT = 'tldraw-canvas-state-replacing';
const CANVAS_RELOAD_COUNTER_KEY = 'canvas-reload-counter';
const DOCUMENT_FRAGMENT_CONTAINER_SELECTOR = '#document-fragments';
const WIDGET_FRAGMENT_CONTAINER_SELECTOR = '#widget-fragments';
const PROCESSOR_FRAGMENT_CONTAINER_SELECTOR = '#processor-fragments';
const WIDGET_STORE_PARENT_SELECTOR = '#widget-stores';
const META_ELEMENTS_SELECTOR = '#meta-elements';

const ACTIVITY_SESSION_ID_KEY = 'history-session-id';
const ACTIVITY_SESSION_JOINED_KEY = 'history-session-joined';
const ACTIVITY_SESSION_SERVER_KEY = 'history-model-server';

const DEFAULT_SELECTION = Object.freeze({
    canvasState: true,
    documentFragments: true,
    widgetFragments: true,
    processorFragments: true,
    widgetState: true,
    activitySessionId: true,
    canvasImageAssets: true
});

function getTimestampSuffix() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function toErrorMessage(error, fallback = 'Unknown error') {
    if (error instanceof Error && typeof error.message === 'string' && error.message.trim()) {
        return error.message.trim();
    }

    if (typeof error === 'string' && error.trim()) {
        return error.trim();
    }

    try {
        const serialized = JSON.stringify(error);
        if (serialized && serialized !== '{}') {
            return serialized;
        }
    } catch (serializationError) {
        // Ignore serialization errors and fall back to string conversion.
    }

    const asString = String(error || '').trim();
    return asString || fallback;
}

function ensureStripProtection(element) {
    if (!element) {
        return;
    }

    if (typeof window.WPMv2 !== 'undefined' && typeof window.WPMv2.stripProtection === 'function') {
        window.WPMv2.stripProtection(element);
    }
}

function escapeCssSelector(value) {
    const text = typeof value === 'string' ? value : String(value || '');
    if (typeof window.CSS !== 'undefined' && typeof window.CSS.escape === 'function') {
        return window.CSS.escape(text);
    }

    return text.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function normalizeSelection(selectionInput = {}) {
    const normalized = {
        ...DEFAULT_SELECTION,
        ...(selectionInput || {})
    };

    Object.keys(DEFAULT_SELECTION).forEach((key) => {
        normalized[key] = Boolean(normalized[key]);
    });

    if (!normalized.canvasState) {
        normalized.canvasImageAssets = false;
    }

    return normalized;
}

function isObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function readCanvasRecordsFromDocument(doc = document) {
    const canvasElement = doc.querySelector(CANVAS_SELECTOR);
    if (!canvasElement) {
        return [];
    }

    const records = [];
    canvasElement.childNodes.forEach((childNode) => {
        if (childNode.nodeType !== Node.ELEMENT_NODE) {
            return;
        }
        if (childNode.matches(CANVAS_SCHEMA_SELECTOR.replace(':scope > ', ''))) {
            return;
        }

        const raw = childNode.textContent || '';
        const parsedRecord = safeJsonParse(raw, null);
        if (parsedRecord && typeof parsedRecord.id === 'string' && parsedRecord.id.trim()) {
            records.push(parsedRecord);
        }
    });

    return records;
}

function readCanvasSchemaFromDocument(doc = document) {
    const canvasElement = doc.querySelector(CANVAS_SELECTOR);
    const schemaElement = canvasElement?.querySelector(CANVAS_SCHEMA_SELECTOR);
    if (!schemaElement) {
        return null;
    }

    const schema = safeJsonParse(schemaElement.textContent || '', null);
    return isObject(schema) ? schema : null;
}

function readSessionIdFromDocument(doc = document) {
    const store = doc.querySelector(`[data-store-id="${DEFAULT_STORE_ID}"]`);
    if (!store) {
        return '';
    }

    const keyElement = store.querySelector(`[data-key="${ACTIVITY_SESSION_ID_KEY}"]`);
    if (!keyElement) {
        return '';
    }

    const parsed = safeJsonParse(keyElement.textContent || '', '');
    if (parsed === undefined || parsed === null) {
        return '';
    }

    return String(parsed);
}

function readActivitySessionServerFromDocument(doc = document) {
    const store = doc.querySelector(`[data-store-id="${DEFAULT_STORE_ID}"]`);
    if (!store) {
        return DEFAULT_SESSION_HISTORY_SERVER;
    }

    const keyElement = store.querySelector(`[data-key="${ACTIVITY_SESSION_SERVER_KEY}"]`);
    if (!keyElement) {
        return DEFAULT_SESSION_HISTORY_SERVER;
    }

    const parsed = safeJsonParse(keyElement.textContent || '', '');
    return normalizeSessionHistoryServerUrl(typeof parsed === 'string' ? parsed : '');
}

function serializeCodeFragments(doc, containerSelector) {
    const container = doc.querySelector(containerSelector);
    if (!container) {
        return [];
    }

    return Array.from(container.querySelectorAll(':scope > code-fragment'))
        .map((fragmentElement) => {
            const fragmentId = fragmentElement.id || '';
            if (!fragmentId) {
                return null;
            }

            return {
                id: fragmentId,
                html: fragmentElement.outerHTML
            };
        })
        .filter(Boolean);
}

function serializeWidgetStores(doc) {
    const storeParent = doc.querySelector(WIDGET_STORE_PARENT_SELECTOR);
    if (!storeParent) {
        return [];
    }

    return Array.from(storeParent.querySelectorAll(':scope > dom-store[data-store-id]'))
        .map((storeElement) => {
            const storeId = storeElement.getAttribute('data-store-id') || '';
            if (!storeId) {
                return null;
            }

            return {
                storeId,
                html: storeElement.outerHTML
            };
        })
        .filter(Boolean);
}

function serializeDocumentMarkdownFragments(doc) {
    const container = doc.querySelector(DOCUMENT_FRAGMENT_CONTAINER_SELECTOR);
    if (!container) {
        return [];
    }

    return Array.from(container.querySelectorAll(':scope > code-fragment'))
        .filter((fragmentElement) => {
            return fragmentElement.getAttribute('data-type') === 'text/markdown';
        })
        .map((fragmentElement) => {
            const fragmentId = fragmentElement.id || '';
            if (!fragmentId) {
                return null;
            }

            return {
                id: fragmentId,
                html: fragmentElement.outerHTML
            };
        })
        .filter(Boolean);
}

function readStundInfoPackageVersion(doc = document) {
    const descriptorFragment = doc.querySelector('#StundInfo code-fragment[data-type="wpm/descriptor"]');
    if (!descriptorFragment) {
        return UNKNOWN_STUND_VERSION;
    }

    const rawDescriptor = descriptorFragment.textContent || '';
    if (!rawDescriptor.trim()) {
        return UNKNOWN_STUND_VERSION;
    }

    try {
        const parsedDescriptor = JSON.parse(rawDescriptor);
        const version = parsedDescriptor?.version;
        if (typeof version === 'string' && version.trim()) {
            return version.trim();
        }

        if (typeof version === 'number' && Number.isFinite(version)) {
            return String(version);
        }
    } catch (error) {
        console.warn('Stund State Transfer: Failed to parse StundInfo descriptor version.', error);
    }

    return UNKNOWN_STUND_VERSION;
}

function buildExportPayload(doc, workspaceUrl, selectionInput) {
    const selection = normalizeSelection(selectionInput);
    const data = {};

    const canvasRecords = selection.canvasState
        ? readCanvasRecordsFromDocument(doc)
        : [];

    if (selection.canvasState) {
        data.canvasRecords = canvasRecords;
        const canvasSchema = readCanvasSchemaFromDocument(doc);
        if (canvasSchema) {
            data.canvasSchema = canvasSchema;
        }
    }

    if (selection.documentFragments) {
        data.documentFragments = serializeDocumentMarkdownFragments(doc);
    }

    if (selection.widgetFragments) {
        data.widgetFragments = serializeCodeFragments(doc, WIDGET_FRAGMENT_CONTAINER_SELECTOR);
    }

    if (selection.processorFragments) {
        data.processorFragments = serializeCodeFragments(doc, PROCESSOR_FRAGMENT_CONTAINER_SELECTOR);
    }

    if (selection.widgetState) {
        data.widgetStores = serializeWidgetStores(doc);
    }

    if (selection.activitySessionId) {
        data.activitySessionId = readSessionIdFromDocument(doc);
        data.activitySessionServer = readActivitySessionServerFromDocument(doc);
    }

    return {
        payload: {
            stundVersion: readStundInfoPackageVersion(doc),
            exportedAt: new Date().toISOString(),
            workspaceUrl,
            data
        },
        selection,
        canvasRecords
    };
}

function resolveAbsoluteAssetUrl(assetSrc, baseHref) {
    if (typeof assetSrc !== 'string' || !assetSrc.trim()) {
        return null;
    }

    const trimmed = assetSrc.trim();
    if (trimmed.startsWith('data:') || trimmed.startsWith('blob:')) {
        return null;
    }

    try {
        return new URL(trimmed, baseHref);
    } catch (error) {
        return null;
    }
}

function getAssetFileNameFromSrc(assetSrc, fallback = '') {
    if (typeof assetSrc !== 'string' || !assetSrc.trim()) {
        return fallback;
    }

    try {
        const resolved = new URL(assetSrc, window.location.href);
        const pathParts = resolved.pathname.split('/').filter(Boolean);
        const lastPathPart = pathParts[pathParts.length - 1] || '';
        const decodedName = decodeURIComponent(lastPathPart);
        if (decodedName) {
            return decodedName;
        }
    } catch (error) {
        const cleaned = assetSrc.split('?')[0].split('#')[0];
        const pathParts = cleaned.split('/').filter(Boolean);
        const fallbackName = pathParts[pathParts.length - 1] || '';
        if (fallbackName) {
            return fallbackName;
        }
    }

    return fallback;
}

function collectCanvasImageAssetReferences(canvasRecords, baseHref) {
    const referencesByFileName = new Map();

    (canvasRecords || []).forEach((record, index) => {
        if (!isObject(record)) {
            return;
        }

        if (record.typeName !== 'asset' || record.type !== 'image') {
            return;
        }

        const assetSrc = record?.props?.src;
        if (typeof assetSrc !== 'string' || !assetSrc.trim()) {
            return;
        }

        const resolvedAssetUrl = resolveAbsoluteAssetUrl(assetSrc, baseHref);
        if (!resolvedAssetUrl) {
            return;
        }

        const fileName = getAssetFileNameFromSrc(assetSrc, `canvas-asset-${index}`);
        if (!fileName) {
            return;
        }

        if (referencesByFileName.has(fileName)) {
            return;
        }

        referencesByFileName.set(fileName, {
            fileName,
            entryPath: `assets/${fileName}`,
            sourceUrl: resolvedAssetUrl.href
        });
    });

    return Array.from(referencesByFileName.values());
}

async function fetchAssetBinary(assetUrl) {
    const response = await fetch(assetUrl, {
        credentials: 'include'
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch asset (${response.status}) ${assetUrl}`);
    }

    const mimeType = response.headers.get('content-type') || 'application/octet-stream';
    const buffer = await response.arrayBuffer();

    return {
        mimeType,
        bytes: new Uint8Array(buffer)
    };
}

async function uploadAssetToCurrentWorkspace(fileName, bytes, mimeType = 'application/octet-stream') {
    if (!fileName || !(bytes instanceof Uint8Array)) {
        throw new Error('Invalid asset upload payload.');
    }

    const formData = new FormData();
    const blob = new Blob([bytes], {
        type: mimeType || 'application/octet-stream'
    });
    formData.append('file', blob, fileName);

    const request = new XMLHttpRequest();
    request.open('POST', window.location.pathname);
    request.send(formData);

    await new Promise((resolve, reject) => {
        request.addEventListener('load', () => {
            if (request.status >= 200 && request.status < 300) {
                resolve();
                return;
            }

            reject(new Error(`Asset upload failed (${request.status}) for ${fileName}`));
        });
        request.addEventListener('error', () => {
            reject(new Error(`Asset upload request failed for ${fileName}`));
        });
    });
}

function downloadBlob(blob, fileName) {
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(downloadUrl);
}

function ensureWidgetStoreParent() {
    let parent = document.querySelector(WIDGET_STORE_PARENT_SELECTOR);
    if (parent) {
        return parent;
    }

    const metaElements = document.querySelector(META_ELEMENTS_SELECTOR) || document.body;
    parent = document.createElement('div');
    parent.id = WIDGET_STORE_PARENT_SELECTOR.slice(1);
    metaElements.appendChild(parent);
    ensureStripProtection(parent);
    return parent;
}

function parseFragmentHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = typeof html === 'string' ? html.trim() : '';
    return template.content.firstElementChild || null;
}

function upsertCodeFragments(containerSelector, rawFragments) {
    const container = document.querySelector(containerSelector);
    if (!container) {
        throw new Error(`Missing container: ${containerSelector}`);
    }

    if (!Array.isArray(rawFragments)) {
        return 0;
    }

    const dedupedById = new Map();
    rawFragments.forEach((entry) => {
        if (!isObject(entry)) {
            return;
        }

        const fragmentId = typeof entry.id === 'string' ? entry.id.trim() : '';
        if (!fragmentId) {
            return;
        }

        const fragmentHtml = typeof entry.html === 'string' ? entry.html : '';
        if (!fragmentHtml.trim()) {
            return;
        }

        dedupedById.set(fragmentId, fragmentHtml);
    });

    let updatedCount = 0;
    dedupedById.forEach((fragmentHtml, fragmentId) => {
        const parsedElement = parseFragmentHtml(fragmentHtml);
        if (!parsedElement || parsedElement.tagName.toLowerCase() !== 'code-fragment') {
            return;
        }

        parsedElement.id = fragmentId;
        const existing = container.querySelector(`:scope > code-fragment#${escapeCssSelector(fragmentId)}`);
        if (existing) {
            container.insertBefore(parsedElement, existing);
            existing.remove();
        } else {
            container.appendChild(parsedElement);
        }

        ensureStripProtection(parsedElement);
        updatedCount += 1;
    });

    return updatedCount;
}

function upsertWidgetStores(rawStores) {
    if (!Array.isArray(rawStores)) {
        return 0;
    }

    const storeParent = ensureWidgetStoreParent();
    const dedupedByStoreId = new Map();

    rawStores.forEach((entry) => {
        if (!isObject(entry)) {
            return;
        }

        const storeId = typeof entry.storeId === 'string' ? entry.storeId.trim() : '';
        if (!storeId) {
            return;
        }

        const storeHtml = typeof entry.html === 'string' ? entry.html : '';
        if (!storeHtml.trim()) {
            return;
        }

        dedupedByStoreId.set(storeId, storeHtml);
    });

    let updatedCount = 0;
    dedupedByStoreId.forEach((storeHtml, storeId) => {
        const parsedElement = parseFragmentHtml(storeHtml);
        if (!parsedElement || parsedElement.tagName.toLowerCase() !== 'dom-store') {
            return;
        }

        parsedElement.setAttribute('data-store-id', storeId);
        const existing = storeParent.querySelector(`:scope > dom-store[data-store-id="${escapeCssSelector(storeId)}"]`);
        if (existing) {
            storeParent.insertBefore(parsedElement, existing);
            existing.remove();
        } else {
            storeParent.appendChild(parsedElement);
        }

        ensureStripProtection(parsedElement);
        updatedCount += 1;
    });

    return updatedCount;
}

function applyCanvasRecords(records, schema = null) {
    const canvasElement = document.querySelector(CANVAS_SELECTOR);
    if (!canvasElement) {
        throw new Error('Missing tldraw canvas element.');
    }

    const safeRecords = Array.isArray(records) ? records : [];
    if (schema !== null && schema !== undefined && !isObject(schema)) {
        throw new Error('Canvas schema must be an object.');
    }

    const fragment = document.createDocumentFragment();
    if (isObject(schema)) {
        const schemaElement = document.createElement('tldraw-schema');
        schemaElement.textContent = JSON.stringify(schema);
        ensureStripProtection(schemaElement);
        fragment.appendChild(schemaElement);
    }

    safeRecords.forEach((record, index) => {
        if (!isObject(record)) {
            throw new Error(`Canvas record ${index + 1} must be an object.`);
        }

        const recordId = typeof record.id === 'string' ? record.id.trim() : '';
        if (!recordId || !recordId.includes(':')) {
            throw new Error(`Canvas record ${index + 1} has an invalid id.`);
        }

        const [type, ...rest] = recordId.split(':');
        const id = rest.join(':');
        if (!type || !id) {
            throw new Error(`Canvas record ${index + 1} has an invalid id.`);
        }

        const recordElement = document.createElement(type);
        recordElement.id = id;
        recordElement.textContent = JSON.stringify(record);
        ensureStripProtection(recordElement);
        fragment.appendChild(recordElement);
    });

    window.dispatchEvent(new Event(CANVAS_STATE_REPLACING_EVENT));
    canvasElement.replaceChildren(fragment);
    setDOMState(CANVAS_RELOAD_COUNTER_KEY, crypto.randomUUID(), DEFAULT_STORE_ID, false);

    return safeRecords.length;
}

function disconnectActivitySession() {
    const activeSession = window.sessionHistory?.session;
    if (activeSession && typeof activeSession.dispose === 'function') {
        try {
            activeSession.dispose();
        } catch (error) {
            console.warn('Stund State Transfer: Failed to dispose active session.', error);
        }
    }

    if (!window.sessionHistory) {
        window.sessionHistory = {};
    }

    window.sessionHistory.session = null;
    window.sessionHistory.model = null;
    window.sessionHistory.ingest = null;
}

function applyActivitySession(sessionIdValue, serverUrlValue = DEFAULT_SESSION_HISTORY_SERVER) {
    const normalizedServerUrl = normalizeSessionHistoryServerUrl(serverUrlValue);
    const normalizedServerOverride = normalizedServerUrl === DEFAULT_SESSION_HISTORY_SERVER
        ? ''
        : normalizedServerUrl;

    disconnectActivitySession();
    setDOMState(ACTIVITY_SESSION_JOINED_KEY, false, DEFAULT_STORE_ID, false);
    setDOMState(ACTIVITY_SESSION_SERVER_KEY, normalizedServerOverride, DEFAULT_STORE_ID, true);
    setDOMState(ACTIVITY_SESSION_ID_KEY, String(sessionIdValue || ''), DEFAULT_STORE_ID, true);
}

function validatePayload(rawPayload) {
    if (!isObject(rawPayload)) {
        throw new Error('Import payload must be an object.');
    }

    if (!isObject(rawPayload.data)) {
        throw new Error('Import payload is missing a "data" object.');
    }

    return rawPayload;
}

function normalizeWorkspaceUrlWithRaw(workspaceUrl) {
    const trimmedUrl = typeof workspaceUrl === 'string' ? workspaceUrl.trim() : '';
    if (!trimmedUrl) {
        throw new Error('Workspace URL is empty.');
    }

    let url;
    try {
        url = new URL(trimmedUrl, window.location.origin);
    } catch (error) {
        throw new Error('Invalid workspace URL.');
    }

    if (url.origin !== window.location.origin) {
        throw new Error('Workspace URL must be same-origin for iframe import.');
    }

    if (!url.pathname.endsWith('/')) {
        url.pathname = `${url.pathname}/`;
    }

    const params = new URLSearchParams(url.search);
    if (!params.has('raw')) {
        params.append('raw', '');
    }
    url.search = params.toString();

    return url.toString();
}

function loadWorkspaceIframe(workspaceUrl, timeoutMs = 25000) {
    return new Promise((resolve, reject) => {
        let isDone = false;
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.setAttribute('aria-hidden', 'true');

        const cleanup = () => {
            iframe.removeEventListener('load', onLoad);
            iframe.removeEventListener('error', onError);
            if (iframe.parentNode) {
                iframe.parentNode.removeChild(iframe);
            }
        };

        const finish = (fn, value) => {
            if (isDone) {
                return;
            }
            isDone = true;
            clearTimeout(timer);
            fn(value);
        };

        const onLoad = () => {
            try {
                const iframeWindow = iframe.contentWindow;
                const iframeDocument = iframe.contentDocument;
                if (!iframeWindow || !iframeDocument) {
                    throw new Error('Could not access workspace iframe document.');
                }

                finish(resolve, {
                    iframe,
                    iframeWindow,
                    iframeDocument,
                    cleanup
                });
            } catch (error) {
                cleanup();
                finish(reject, error);
            }
        };

        const onError = () => {
            cleanup();
            finish(reject, new Error('Failed to load workspace iframe.'));
        };

        const timer = setTimeout(() => {
            cleanup();
            finish(reject, new Error('Workspace iframe load timed out.'));
        }, timeoutMs);

        iframe.addEventListener('load', onLoad);
        iframe.addEventListener('error', onError);
        document.body.appendChild(iframe);
        iframe.src = workspaceUrl;
    });
}

function pickZipAssetEntries(zipEntries, listedAssetPaths) {
    if (!Array.isArray(zipEntries) || zipEntries.length === 0) {
        return [];
    }

    if (!Array.isArray(listedAssetPaths) || listedAssetPaths.length === 0) {
        return zipEntries;
    }

    const wanted = new Set(listedAssetPaths.filter((path) => typeof path === 'string'));
    const filtered = zipEntries.filter((entry) => wanted.has(entry.entryPath));
    return filtered.length > 0 ? filtered : zipEntries;
}

async function importPayload(payloadInput, selectionInput, options = {}) {
    const payload = validatePayload(payloadInput);
    const selection = normalizeSelection(selectionInput);
    const data = payload.data || {};
    const warnings = [];

    let importedAssetCount = 0;
    const zipAssetEntries = Array.isArray(options.zipAssetEntries) ? options.zipAssetEntries : [];
    const urlAssetReferences = Array.isArray(options.urlAssetReferences) ? options.urlAssetReferences : [];

    if (selection.canvasImageAssets) {
        if (zipAssetEntries.length > 0) {
            const selectedEntries = pickZipAssetEntries(zipAssetEntries, data.canvasAssetFiles);
            for (const entry of selectedEntries) {
                try {
                    await uploadAssetToCurrentWorkspace(entry.fileName, entry.bytes, entry.mimeType);
                    importedAssetCount += 1;
                } catch (error) {
                    warnings.push(`Failed to import asset "${entry.fileName}": ${toErrorMessage(error)}`);
                }
            }
        } else if (urlAssetReferences.length > 0) {
            for (const reference of urlAssetReferences) {
                try {
                    const fetched = await fetchAssetBinary(reference.sourceUrl);
                    await uploadAssetToCurrentWorkspace(reference.fileName, fetched.bytes, fetched.mimeType);
                    importedAssetCount += 1;
                } catch (error) {
                    warnings.push(`Failed to import asset "${reference.fileName}": ${toErrorMessage(error)}`);
                }
            }
        } else if (Array.isArray(data.canvasAssetFiles) && data.canvasAssetFiles.length > 0) {
            warnings.push('Import payload references canvas assets, but no asset binaries were available.');
        }
    }

    const widgetFragmentCount = selection.widgetFragments
        ? upsertCodeFragments(WIDGET_FRAGMENT_CONTAINER_SELECTOR, data.widgetFragments)
        : 0;

    const documentFragmentCount = selection.documentFragments
        ? upsertCodeFragments(DOCUMENT_FRAGMENT_CONTAINER_SELECTOR, data.documentFragments)
        : 0;

    const processorFragmentCount = selection.processorFragments
        ? upsertCodeFragments(PROCESSOR_FRAGMENT_CONTAINER_SELECTOR, data.processorFragments)
        : 0;

    const widgetStoreCount = selection.widgetState
        ? upsertWidgetStores(data.widgetStores)
        : 0;

    let activitySessionUpdated = false;
    if (selection.activitySessionId && Object.prototype.hasOwnProperty.call(data, 'activitySessionId')) {
        applyActivitySession(data.activitySessionId, data.activitySessionServer);
        activitySessionUpdated = true;
    }

    const canvasRecordCount = selection.canvasState
        ? applyCanvasRecords(data.canvasRecords, data.canvasSchema)
        : 0;

    return {
        selection,
        warnings,
        summary: {
            canvasRecordCount,
            canvasSchemaIncluded: isObject(data.canvasSchema),
            documentFragmentCount,
            widgetFragmentCount,
            processorFragmentCount,
            widgetStoreCount,
            importedAssetCount,
            activitySessionUpdated
        }
    };
}

function isZipFile(file) {
    if (!(file instanceof File)) {
        return false;
    }

    const fileName = typeof file.name === 'string' ? file.name.toLowerCase() : '';
    const fileType = typeof file.type === 'string' ? file.type.toLowerCase() : '';
    return fileName.endsWith('.zip') || fileType.includes('zip');
}

async function readZipImportFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const entries = unzipSync(bytes);
    const entryNames = Object.keys(entries);
    const stateEntryName = entryNames.find((entryName) => entryName === 'state.json' || entryName.endsWith('/state.json'));

    if (!stateEntryName) {
        throw new Error('ZIP import must contain a state.json file.');
    }

    const payloadText = strFromU8(entries[stateEntryName]);
    const payload = safeJsonParse(payloadText, null);
    if (!payload) {
        throw new Error('Could not parse state.json inside ZIP import.');
    }

    const assetEntries = entryNames
        .filter((entryName) => entryName.startsWith('assets/'))
        .map((entryName) => {
            const pathParts = entryName.split('/').filter(Boolean);
            const fileName = pathParts[pathParts.length - 1] || '';
            if (!fileName) {
                return null;
            }

            return {
                entryPath: entryName,
                fileName,
                bytes: entries[entryName],
                mimeType: 'application/octet-stream'
            };
        })
        .filter(Boolean);

    return {
        payload,
        assetEntries
    };
}

async function readJsonImportFile(file) {
    const payloadText = await file.text();
    const payload = safeJsonParse(payloadText, null);
    if (!payload) {
        throw new Error('Could not parse JSON import file.');
    }

    return {
        payload,
        assetEntries: []
    };
}

function formatSelectionForExport(selectionInput) {
    return normalizeSelection(selectionInput);
}

export function getDefaultStateTransferSelection() {
    return {
        ...DEFAULT_SELECTION
    };
}

export async function exportStateToFile(selectionInput = {}) {
    const selection = formatSelectionForExport(selectionInput);
    const built = buildExportPayload(document, window.location.href, selection);
    const payload = built.payload;
    const warnings = [];

    let assetFiles = [];
    if (selection.canvasImageAssets) {
        const references = collectCanvasImageAssetReferences(built.canvasRecords, window.location.href);
        assetFiles = [];

        for (const reference of references) {
            try {
                const fetched = await fetchAssetBinary(reference.sourceUrl);
                assetFiles.push({
                    ...reference,
                    mimeType: fetched.mimeType,
                    bytes: fetched.bytes
                });
            } catch (error) {
                warnings.push(`Failed to export asset "${reference.fileName}": ${toErrorMessage(error)}`);
            }
        }

        payload.data.canvasAssetFiles = assetFiles.map((assetFile) => assetFile.entryPath);
    }

    const fileStamp = getTimestampSuffix();
    const summary = {
        canvasRecordCount: Array.isArray(payload.data.canvasRecords) ? payload.data.canvasRecords.length : 0,
        canvasSchemaIncluded: isObject(payload.data.canvasSchema),
        documentFragmentCount: Array.isArray(payload.data.documentFragments) ? payload.data.documentFragments.length : 0,
        widgetFragmentCount: Array.isArray(payload.data.widgetFragments) ? payload.data.widgetFragments.length : 0,
        processorFragmentCount: Array.isArray(payload.data.processorFragments) ? payload.data.processorFragments.length : 0,
        widgetStoreCount: Array.isArray(payload.data.widgetStores) ? payload.data.widgetStores.length : 0,
        activitySessionIncluded: Object.prototype.hasOwnProperty.call(payload.data, 'activitySessionId'),
        exportedAssetCount: assetFiles.length
    };

    let fileName = `${DEFAULT_EXPORT_BASE_NAME}-${fileStamp}.json`;
    let fileBlob = new Blob([JSON.stringify(payload, null, 4)], {
        type: 'application/json'
    });
    let isZip = false;

    if (assetFiles.length > 0) {
        const zipInput = {
            'state.json': strToU8(JSON.stringify(payload, null, 4))
        };

        assetFiles.forEach((assetFile) => {
            zipInput[assetFile.entryPath] = assetFile.bytes;
        });

        const zipped = zipSync(zipInput);
        fileBlob = new Blob([zipped], {
            type: 'application/zip'
        });
        fileName = `${DEFAULT_EXPORT_BASE_NAME}-${fileStamp}.zip`;
        isZip = true;
    }

    downloadBlob(fileBlob, fileName);

    return {
        isZip,
        fileName,
        warnings,
        summary
    };
}

export async function importStateFromFile(file, selectionInput = {}) {
    if (!(file instanceof File)) {
        throw new Error('No import file selected.');
    }

    const parsed = isZipFile(file)
        ? await readZipImportFile(file)
        : await readJsonImportFile(file);

    return await importPayload(parsed.payload, selectionInput, {
        zipAssetEntries: parsed.assetEntries
    });
}

export async function importStateFromWorkspaceUrl(workspaceUrl, selectionInput = {}) {
    const normalizedUrl = normalizeWorkspaceUrlWithRaw(workspaceUrl);
    const iframeResult = await loadWorkspaceIframe(normalizedUrl);
    const cleanup = typeof iframeResult.cleanup === 'function'
        ? iframeResult.cleanup
        : () => {};

    try {
        const sourceDoc = iframeResult.iframeDocument;
        const sourceWindow = iframeResult.iframeWindow;
        const sourceUrl = sourceWindow?.location?.href || normalizedUrl;

        const selection = normalizeSelection(selectionInput);
        const built = buildExportPayload(sourceDoc, sourceUrl, selection);
        const payload = built.payload;

        let urlAssetReferences = [];
        if (selection.canvasImageAssets) {
            urlAssetReferences = collectCanvasImageAssetReferences(built.canvasRecords, sourceUrl);
            payload.data.canvasAssetFiles = urlAssetReferences.map((reference) => reference.entryPath);
        }

        return await importPayload(payload, selection, {
            urlAssetReferences
        });
    } finally {
        cleanup();
    }
}
