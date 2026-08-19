import React from 'react';
const { useRef, useState } = React;

import { useTransientDOMState } from '#CoreHelpers .dom-store';
import { Dialog, DialogHeader, DialogToggleRow, Section } from '#Dialog .default';
import {
    getDefaultStateTransferSelection,
    exportStateToFile,
    importStateFromFile,
    importStateFromWorkspaceUrl
} from '#StundInfo .state-transfer';


const CHANGELOG_FRAGMENT_NAME = 'Changelog';
const UNKNOWN_VERSION = 'Unknown';

function readStundVersion() {
    const descriptorFragment = document.querySelector('#StundInfo code-fragment[data-type="wpm/descriptor"]');
    if (!descriptorFragment) {
        return UNKNOWN_VERSION;
    }

    const rawDescriptor = descriptorFragment.textContent || '';
    if (!rawDescriptor.trim()) {
        return UNKNOWN_VERSION;
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
        console.warn('Stund Info: Failed to parse package descriptor version.', error);
    }

    return UNKNOWN_VERSION;
}

function readChangelogMarkdown() {
    const changelogFragment = document.querySelector(`#StundInfo code-fragment[name='${CHANGELOG_FRAGMENT_NAME}']`);
    if (!changelogFragment) {
        return 'No changelog fragment found. Create "Changelog.md" in #StundInfo.';
    }

    const changelogText = changelogFragment.textContent || '';
    if (!changelogText.trim()) {
        return 'Changelog is empty.';
    }

    return changelogText;
}

function renderMarkdown(markdownText) {
    const lines = markdownText.split('\n');
    const nodes = [];
    let listItems = [];
    let keyCounter = 0;

    const flushList = () => {
        if (listItems.length === 0) {
            return;
        }

        nodes.push(<ul key={`list-${keyCounter++}`} className="stund-info-markdown-list">
            {listItems.map((item) => <li key={`item-${keyCounter++}`}>{item}</li>)}
        </ul>);
        listItems = [];
    };

    lines.forEach((line) => {
        const trimmed = line.trim();

        if (!trimmed) {
            flushList();
            return;
        }

        if (trimmed.startsWith('- ')) {
            listItems.push(trimmed.slice(2).trim());
            return;
        }

        flushList();

        if (trimmed.startsWith('### ')) {
            nodes.push(<h4 key={`h4-${keyCounter++}`}>{trimmed.slice(4).trim()}</h4>);
            return;
        }

        if (trimmed.startsWith('## ')) {
            nodes.push(<h3 key={`h3-${keyCounter++}`}>{trimmed.slice(3).trim()}</h3>);
            return;
        }

        if (trimmed.startsWith('# ')) {
            nodes.push(<h2 key={`h2-${keyCounter++}`}>{trimmed.slice(2).trim()}</h2>);
            return;
        }

        nodes.push(<p key={`p-${keyCounter++}`}>{trimmed}</p>);
    });

    flushList();

    return nodes;
}

function formatWarnings(warnings) {
    if (!Array.isArray(warnings) || warnings.length === 0) {
        return [];
    }

    return warnings.filter((warning) => typeof warning === 'string' && warning.trim());
}

function formatExportSummary(result) {
    const summary = result?.summary || {};

    return [
        `Canvas records: ${summary.canvasRecordCount || 0}`,
        `Canvas schema included: ${summary.canvasSchemaIncluded ? 'Yes' : 'No'}`,
        `Document fragments: ${summary.documentFragmentCount || 0}`,
        `Widget fragments: ${summary.widgetFragmentCount || 0}`,
        `Processor fragments: ${summary.processorFragmentCount || 0}`,
        `Widget stores: ${summary.widgetStoreCount || 0}`,
        `Canvas assets: ${summary.exportedAssetCount || 0}`,
        `Activity session ID included: ${summary.activitySessionIncluded ? 'Yes' : 'No'}`
    ];
}

function formatImportSummary(result) {
    const summary = result?.summary || {};

    const lines = [
        `Canvas records imported: ${summary.canvasRecordCount || 0}`,
        `Canvas schema imported: ${summary.canvasSchemaIncluded ? 'Yes' : 'No'}`,
        `Document fragments imported: ${summary.documentFragmentCount || 0}`,
        `Widget fragments imported: ${summary.widgetFragmentCount || 0}`,
        `Processor fragments imported: ${summary.processorFragmentCount || 0}`,
        `Widget stores imported: ${summary.widgetStoreCount || 0}`,
        `Canvas assets imported: ${summary.importedAssetCount || 0}`,
        `Activity session updated: ${summary.activitySessionUpdated ? 'Yes' : 'No'}`
    ];

    if ((summary.canvasRecordCount || 0) > 0) {
        lines.push('The canvas reloads automatically after import.');
    }

    return lines;
}

function getErrorMessage(error) {
    if (error instanceof Error && typeof error.message === 'string' && error.message.trim()) {
        return error.message.trim();
    }

    const text = String(error || '').trim();
    return text || 'Unknown error';
}

function showImportSummaryPopup(sourceLabel, result) {
    const summaryLines = formatImportSummary(result);
    const warningLines = formatWarnings(result?.warnings);
    const popupLines = [
        `Import completed from ${sourceLabel}.`,
        '',
        'Summary:',
        ...summaryLines.map((line) => `- ${line}`)
    ];

    if (warningLines.length > 0) {
        popupLines.push('', 'Warnings:', ...warningLines.map((line) => `- ${line}`));
    }

    alert(popupLines.join('\n'));
}

function confirmImportWithWarnings(selection) {
    if (selection.canvasState) {
        const acceptedCanvasOverride = confirm(
            'Importing canvas state will overwrite your current board. Do you want to continue?'
        );

        if (!acceptedCanvasOverride) {
            return false;
        }
    }

    if (selection.canvasImageAssets) {
        const acceptedAssetCollisionRisk = confirm(
            'Importing canvas assets keeps original file names and may replace assets with the same names at the current version. Continue?'
        );

        if (!acceptedAssetCollisionRisk) {
            return false;
        }
    }

    return true;
}

function TransferStatus({ status }) {
    if (!status) {
        return null;
    }

    const title = status.type === 'error' ? 'Transfer Failed' : 'Transfer Completed';
    const details = Array.isArray(status.details) ? status.details : [];

    return <div className={`stund-info-transfer-status ${status.type}`}>
        <strong>{title}</strong>
        <span>{status.message}</span>
        {details.map((detail, index) => (
            <span key={`status-detail-${index}`} className="stund-info-transfer-status-detail">- {detail}</span>
        ))}
    </div>;
}

export function Main() {
    const [visible, setVisible] = useTransientDOMState('stund-info-visible', false);
    const [selection, setSelection] = useState(() => getDefaultStateTransferSelection());
    const [workspaceUrl, setWorkspaceUrl] = useState('');
    const [status, setStatus] = useState(null);
    const [isBusy, setIsBusy] = useState(false);
    const fileInputRef = useRef(null);

    const stundVersion = readStundVersion();
    const changelogMarkdown = readChangelogMarkdown();

    const updateSelection = (key, value) => {
        setSelection((previous) => {
            const next = {
                ...previous,
                [key]: Boolean(value)
            };

            if (key === 'canvasState' && !next.canvasState) {
                next.canvasImageAssets = false;
            }

            return next;
        });
    };

    const setSuccessStatus = (message, details = []) => {
        setStatus({
            type: 'success',
            message,
            details
        });
    };

    const setErrorStatus = (message, details = []) => {
        setStatus({
            type: 'error',
            message,
            details
        });
    };

    const handleExport = async () => {
        if (isBusy) {
            return;
        }

        setIsBusy(true);
        setStatus(null);

        try {
            const result = await exportStateToFile(selection);
            const details = [
                ...formatExportSummary(result),
                ...formatWarnings(result?.warnings)
            ];
            const containerType = result?.isZip ? 'ZIP' : 'JSON';
            setSuccessStatus(`Exported ${containerType} file: ${result?.fileName || 'state export'}.`, details);
        } catch (error) {
            setErrorStatus('Failed to export state.', [getErrorMessage(error)]);
        } finally {
            setIsBusy(false);
        }
    };

    const handleImportFileClick = () => {
        if (isBusy) {
            return;
        }

        if (!confirmImportWithWarnings(selection)) {
            return;
        }

        if (fileInputRef.current) {
            fileInputRef.current.click();
        }
    };

    const handleFileSelected = async (event) => {
        const selectedFile = event.target?.files?.[0];
        event.target.value = '';

        if (!selectedFile) {
            return;
        }

        setIsBusy(true);
        setStatus(null);

        try {
            const result = await importStateFromFile(selectedFile, selection);
            const details = [
                ...formatImportSummary(result),
                ...formatWarnings(result?.warnings)
            ];
            setSuccessStatus(`Imported state from ${selectedFile.name}.`, details);
            showImportSummaryPopup(selectedFile.name, result);
        } catch (error) {
            setErrorStatus('Failed to import state from file.', [getErrorMessage(error)]);
        } finally {
            setIsBusy(false);
        }
    };

    const handleImportFromUrl = async () => {
        if (isBusy) {
            return;
        }

        if (!workspaceUrl.trim()) {
            setErrorStatus('Workspace URL is required.');
            return;
        }

        if (!confirmImportWithWarnings(selection)) {
            return;
        }

        setIsBusy(true);
        setStatus(null);

        try {
            const result = await importStateFromWorkspaceUrl(workspaceUrl, selection);
            const details = [
                ...formatImportSummary(result),
                ...formatWarnings(result?.warnings)
            ];
            setSuccessStatus('Imported state from workspace URL.', details);
            showImportSummaryPopup(workspaceUrl.trim(), result);
        } catch (error) {
            setErrorStatus('Failed to import state from workspace URL.', [getErrorMessage(error)]);
        } finally {
            setIsBusy(false);
        }
    };

    return <Dialog className="stund-info-dialog" visible={visible} setVisible={setVisible}>
        <DialogHeader title="Stund Information" icon="info" onClose={() => setVisible(false)} />

        <Section title="Stund Version" color="#1976D2">
            <div>
                <span>{stundVersion}</span>
            </div>
        </Section>

        <Section title="Changelog" color="#F57C00" collapsable collapsedByDefault>
            <div className="stund-info-markdown">
                {renderMarkdown(changelogMarkdown)}
            </div>
        </Section>

        <Section title="State Transfer" color="#388E3C" collapsable collapsedByDefault>
            <div className="stund-info-transfer-layout">
                <p className="section-description">Export or import selected state between Stund workspaces. Imported changes are persistent and shared; transfer settings are local.</p>

                <div className="dialog-toggle-list">
                    <DialogToggleRow
                        label="Canvas State"
                        description="Includes canvas records and will overwrite the current board on import."
                        checked={selection.canvasState}
                        onChange={(checked) => updateSelection('canvasState', checked)}
                        disabled={isBusy}
                    />
                    <DialogToggleRow
                        label="Canvas Image Assets"
                        description="Exports referenced tldraw image assets and imports with original file names."
                        checked={selection.canvasImageAssets}
                        onChange={(checked) => updateSelection('canvasImageAssets', checked)}
                        disabled={isBusy || !selection.canvasState}
                    />
                    <DialogToggleRow
                        label="Document Markdown Fragments"
                        description="Imports overwrite local document fragments with matching IDs."
                        checked={selection.documentFragments}
                        onChange={(checked) => updateSelection('documentFragments', checked)}
                        disabled={isBusy}
                    />
                    <DialogToggleRow
                        label="Widget Code Fragments"
                        description="Imports overwrite local fragments with matching IDs."
                        checked={selection.widgetFragments}
                        onChange={(checked) => updateSelection('widgetFragments', checked)}
                        disabled={isBusy}
                    />
                    <DialogToggleRow
                        label="Processor Code Fragments"
                        description="Imports overwrite local fragments with matching IDs."
                        checked={selection.processorFragments}
                        onChange={(checked) => updateSelection('processorFragments', checked)}
                        disabled={isBusy}
                    />
                    <DialogToggleRow
                        label="Persisted Widget State"
                        description="Imports overwrite widget DOM stores with matching store IDs."
                        checked={selection.widgetState}
                        onChange={(checked) => updateSelection('widgetState', checked)}
                        disabled={isBusy}
                    />
                    <DialogToggleRow
                        label="Activity Session"
                        description="Transfers the session ID and history server. Import disconnects the active session."
                        checked={selection.activitySessionId}
                        onChange={(checked) => updateSelection('activitySessionId', checked)}
                        disabled={isBusy}
                    />
                </div>

                <div className="stund-info-file-actions">
                    <button
                        type="button"
                        className="dialog-action-button"
                        onClick={handleExport}
                        disabled={isBusy}
                        title="Export Selected State"
                    >
                        <span className="icon material-icons">download</span>
                        <span>Export Selected</span>
                    </button>
                    <button
                        type="button"
                        className="dialog-action-button"
                        onClick={handleImportFileClick}
                        disabled={isBusy}
                        title="Import State From File"
                    >
                        <span className="icon material-icons">upload_file</span>
                        <span>Import From File</span>
                    </button>
                </div>

                <hr className="stund-info-transfer-divider" />

                <div className="stund-info-url-import-row">
                    <div className="add-chip-input-container stund-info-url-input-container">
                        <input
                            type="text"
                            className="add-chip-input stund-info-url-input"
                            value={workspaceUrl}
                            onChange={(event) => setWorkspaceUrl(event.target.value)}
                            placeholder="Workspace URL..."
                            disabled={isBusy}
                        />
                    </div>
                    <button
                        type="button"
                        className="dialog-action-button"
                        onClick={handleImportFromUrl}
                        disabled={isBusy}
                        title="Import State From Workspace URL"
                    >
                        <span className="icon material-icons">link</span>
                        <span>Import From URL</span>
                    </button>
                </div>

                <TransferStatus status={status} />

                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json,.zip,application/json,application/zip"
                    className="stund-info-hidden-file-input"
                    onChange={handleFileSelected}
                />
            </div>
        </Section>
    </Dialog>;
}
