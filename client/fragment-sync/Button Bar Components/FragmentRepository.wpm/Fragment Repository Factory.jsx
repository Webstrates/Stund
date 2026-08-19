import React from 'react';
import { useState, useEffect, useRef, useCallback } from 'react';

import { useTransientDOMState } from '#CoreHelpers .dom-store';
import { useWebstrateCookieState } from '#CoreHelpers .webstrate-cookie-store';
import { Dialog, DialogHeader, Section } from '#Dialog .default';



const RepositoryConfigContext = React.createContext(null);

function useRepositoryConfig() {
    return React.useContext(RepositoryConfigContext);
}

function getDocumentPath() {
    return window.location.pathname.replace(/\/+/g, '');
}

function FragmentItem({ fragment, onUpload, onOpenEditor, onCreateOnCanvas, onDelete, expanded, onToggleExpand }) {
    const config = useRepositoryConfig();
    const [description, setDescription] = useState(fragment.getAttribute('description') || '');
    const [name, setName] = useState(fragment.getAttribute('name') || config.fallbackName);
    const [isRenaming, setIsRenaming] = useState(false);
    const [editName, setEditName] = useState(name);
    const id = fragment.id;

    const instanceCount = config.shapeType ? (() => {
        if (!window.tldrawEditor) return 0;
        const allShapes = window.tldrawEditor.getCurrentPageShapes() || [];
        return allShapes.filter(
            shape => shape.type === config.shapeType && shape.props?.sourceFragmentId === id
        ).length;
    })() : null;

    const handleDescriptionChange = (e) => {
        const newDescription = e.target.value;
        setDescription(newDescription);
        fragment.setAttribute('description', newDescription);
    };

    const handleRename = (e) => {
        e.stopPropagation();
        setEditName(name);
        setIsRenaming(true);
    };

    const handleRenameSubmit = (e) => {
        e.stopPropagation();
        fragment.setAttribute('name', editName);
        setName(editName);
        setIsRenaming(false);
    };

    const handleRenameKeyDown = (e) => {
        if (e.key === 'Enter') {
            handleRenameSubmit(e);
        } else if (e.key === 'Escape') {
            setEditName(name);
            setIsRenaming(false);
        }
    };

    return (
        <div className={`fragment-item ${expanded ? 'expanded' : ''}`}>
            <div className="fragment-header" onClick={() => !isRenaming && onToggleExpand(id)} title={id}>
                <span className="expand-icon material-icons">{expanded ? 'expand_less' : 'expand_more'}</span>
                {isRenaming ? (
                    <input
                        type="text"
                        className="fragment-name-input"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={handleRenameKeyDown}
                        onBlur={handleRenameSubmit}
                        onClick={(e) => e.stopPropagation()}
                        autoFocus
                    />
                ) : (
                    <span className="fragment-name">{name}</span>
                )}
                <div className="fragment-actions" onClick={(e) => e.stopPropagation()}>
                    {!isRenaming && (
                        <button className="fragment-action-btn" onClick={handleRename} title={`Rename ${config.singular}`}>
                            <span className="icon material-icons">edit</span>
                        </button>
                    )}
                    <button className="fragment-action-btn" onClick={() => onOpenEditor(fragment.id)} title="Open Source">
                        <span className="icon material-icons">code</span>
                    </button>
                    {config.shapeType && (
                        <button className="fragment-action-btn" onClick={() => onCreateOnCanvas(fragment)} title="Create On Canvas">
                            <span className="icon material-icons">add_box</span>
                        </button>
                    )}
                    <button className="fragment-action-btn" onClick={() => onUpload(fragment)} title="Upload to repository">
                        <span className="icon material-icons">cloud_upload</span>
                    </button>
                    <button className="fragment-action-btn delete-btn" onClick={() => onDelete(fragment)} title={`Delete ${config.singular}`}>
                        <span className="icon material-icons">delete</span>
                    </button>
                </div>
                {config.shapeType && (
                    <span className="instance-count" title={`${instanceCount} instances on canvas`}>{instanceCount}</span>
                )}
            </div>
            {expanded && (
                <div className="fragment-details">
                    <textarea
                        className="description-input"
                        value={description}
                        onChange={handleDescriptionChange}
                        placeholder={`Add a description for this ${config.singular.toLowerCase()}...`}
                        rows={2}
                    />
                </div>
            )}
        </div>
    );
}

function RepositoryFragmentItem({ fragment, folderName, onDownload, expanded, onToggleExpand }) {
    const config = useRepositoryConfig();
    const [name, setName] = useState(fragment.getAttribute('name') || config.fallbackName);
    const [isRenaming, setIsRenaming] = useState(false);
    const [editName, setEditName] = useState(name);
    const description = fragment.getAttribute('description') || '';
    const timestamp = fragment.getAttribute('timestamp');
    const fromDocument = fragment.getAttribute('from-document');
    const id = fragment.id;

    // Format timestamp to human readable string
    let timestampDisplay = '';
    if (timestamp) {
        const date = new Date(Number(timestamp));
        timestampDisplay = date.toLocaleString();
    }

    const handleRename = (e) => {
        e.stopPropagation();
        setEditName(name);
        setIsRenaming(true);
    };

    const handleRenameSubmit = (e) => {
        e.stopPropagation();
        fragment.setAttribute('name', editName);
        setName(editName);
        setIsRenaming(false);
    };

    const handleRenameKeyDown = (e) => {
        if (e.key === 'Enter') {
            handleRenameSubmit(e);
        } else if (e.key === 'Escape') {
            setEditName(name);
            setIsRenaming(false);
        }
    };

    return (
        <div className={`fragment-item repository ${expanded ? 'expanded' : ''}`}>
            <div className="fragment-header" onClick={() => !isRenaming && onToggleExpand(id)} title={`${id} (from ${folderName})`}>
                <span className="expand-icon material-icons">{expanded ? 'expand_less' : 'expand_more'}</span>
                {isRenaming ? (
                    <input
                        type="text"
                        className="fragment-name-input"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={handleRenameKeyDown}
                        onBlur={handleRenameSubmit}
                        onClick={(e) => e.stopPropagation()}
                        autoFocus
                    />
                ) : (
                    <span className="fragment-name">{name}</span>
                )}
                <div className="fragment-actions" onClick={(e) => e.stopPropagation()}>
                    {!isRenaming && (
                        <button className="fragment-action-btn" onClick={handleRename} title={`Rename ${config.singular}`}>
                            <span className="icon material-icons">edit</span>
                        </button>
                    )}
                    <button className="fragment-action-btn" onClick={() => onDownload(fragment)} title="Download to local">
                        <span className="icon material-icons">cloud_download</span>
                    </button>
                    <button className="fragment-action-btn delete-btn" onClick={() => {
                        if (confirm(`Are you sure you want to delete ${config.singular.toLowerCase()} "${name}" from the repository? This action cannot be undone.`)) {
                            fragment.remove();
                        }
                    }} title="Delete from repository">
                        <span className="icon material-icons">delete</span>
                    </button>
                </div>
            </div>
            {expanded && (
                <div className="fragment-details">
                    {fromDocument && (
                        <p className="fragment-from-document">From: {fromDocument}</p>
                    )}
                    {timestampDisplay && (
                        <p className="fragment-timestamp">{timestampDisplay}</p>
                    )}
                    {description && (
                        <p className="description-text">{description}</p>
                    )}
                </div>
            )}
        </div>
    );
}

function RepositoryFolder({ folder, onDownload, isSelected, onSelect, expanded, onToggleExpand, expandedFragments, onToggleFragmentExpand }) {
    const config = useRepositoryConfig();
    const [description, setDescription] = useState(folder.getAttribute('description') || '');
    const [isEditing, setIsEditing] = useState(false);
    const [editName, setEditName] = useState(folder.getAttribute('name') || 'Unnamed Folder');
    const folderName = folder.getAttribute('name') || 'Unnamed Folder';
    const fragments = Array.from(folder.querySelectorAll(':scope > code-fragment'))
        .sort((a, b) => {
            const aName = a.getAttribute('name') || '';
            const bName = b.getAttribute('name') || '';
            return aName.localeCompare(bName);
        });

    const handleDescriptionChange = (e) => {
        const newDescription = e.target.value;
        setDescription(newDescription);
        folder.setAttribute('description', newDescription);
    };

    const handleRename = (e) => {
        e.stopPropagation();
        setIsEditing(true);
    };

    const handleRenameSubmit = (e) => {
        e.stopPropagation();
        folder.setAttribute('name', editName);
        setIsEditing(false);
    };

    const handleRenameKeyDown = (e) => {
        if (e.key === 'Enter') {
            handleRenameSubmit(e);
        } else if (e.key === 'Escape') {
            setEditName(folderName);
            setIsEditing(false);
        }
    };

    const handleFolderClick = (e) => {
        if (isEditing) return;
        // If clicking on the folder icon or name area, toggle selection
        // Expand/collapse only when already selected or clicking expand icon
        if (isSelected) {
            onToggleExpand(folder.id);
        } else {
            onSelect(folder.id);
        }
    };

    return (
        <div className={`repository-folder ${isSelected ? 'selected' : ''}`}>
            <div className="folder-header" onClick={handleFolderClick}>
                <span className="icon material-icons">{expanded ? 'folder_open' : 'folder'}</span>
                {isEditing ? (
                    <input
                        type="text"
                        className="folder-name-input"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={handleRenameKeyDown}
                        onBlur={handleRenameSubmit}
                        onClick={(e) => e.stopPropagation()}
                        autoFocus
                    />
                ) : (
                    <span className="folder-name">{folderName}</span>
                )}
                {expanded && !isEditing ? (
                    <>
                        <button className="button small folder-rename" onClick={handleRename} title="Rename folder">
                            <span className="icon material-icons">edit</span>
                        </button>
                        <button className="button small folder-delete" onClick={(e) => {
                            e.stopPropagation();
                            if (confirm(`Are you sure you want to delete the entire folder "${folderName}" from the repository? This action cannot be undone.`)) {
                                folder.remove();
                            }
                        }} title="Delete folder from repository">
                            <span className="icon material-icons">delete</span>
                        </button>
                    </>
                ) : null}
                <span className="fragment-count" title={`${fragments.length} ${config.plural.toLowerCase()} in ${folderName}`}>{fragments.length}</span>
            </div>
            {expanded && (
                <div className="folder-contents">
                    <div className="folder-description">
                        <textarea
                            className="description-input"
                            value={description}
                            onChange={handleDescriptionChange}
                            onClick={(e) => e.stopPropagation()}
                            placeholder="Add a description for this folder..."
                            rows={1}
                        />
                    </div>
                    {fragments.length === 0 ? (
                        <p className="empty-message">No {config.plural.toLowerCase()} in this folder.</p>
                    ) : (
                        fragments.map((fragment) => (
                            <RepositoryFragmentItem
                                key={fragment.id}
                                fragment={fragment}
                                folderName={folderName}
                                onDownload={onDownload}
                                expanded={expandedFragments.has(fragment.id)}
                                onToggleExpand={onToggleFragmentExpand}
                            />
                        ))
                    )}
                </div>
            )}
        </div>
    );
}

function LocalFragments({ iframeRef, selectedFolderId, iframeLoaded }) {
    const config = useRepositoryConfig();
    const [fragments, setFragments] = useState([]);
    const [, setUpdateCounter] = useState(0);
    const [expandedFragments, setExpandedFragments] = useState(new Set());
    const attrWatchersRef = useRef([]);

    const toggleFragmentExpand = useCallback((fragmentId) => {
        setExpandedFragments(prev => {
            const newSet = new Set(prev);
            if (newSet.has(fragmentId)) {
                newSet.delete(fragmentId);
            } else {
                newSet.add(fragmentId);
            }
            return newSet;
        });
    }, []);

    useEffect(() => {
        const container = document.querySelector('#' + config.fragmentContainerId);
        if (!container) {
            setFragments([]);
            return;
        }

        const refreshFragments = () => {
            const fragments = Array.from(container.querySelectorAll('code-fragment'))
                .sort((a, b) => {
                    const aName = a.getAttribute('name') || '';
                    const bName = b.getAttribute('name') || '';
                    return aName.localeCompare(bName);
                });
            setFragments(fragments);
            setUpdateCounter(prev => prev + 1);
        };

        const setupAttrWatcher = (el) => {
            const watcher = cQuery(el).liveAttribute('name', () => {
                setUpdateCounter(prev => prev + 1);
            });
            attrWatchersRef.current.push(watcher);
        };

        // Set up watchers for existing fragments
        container.querySelectorAll('code-fragment').forEach(setupAttrWatcher);

        // Initial load
        refreshFragments();

        // Use cQuery liveQuery to automatically react to added/removed fragments
        const liveQuery = cQuery(container).liveQuery('code-fragment', {
            added: (el) => {
                setupAttrWatcher(el);
                refreshFragments();
            },
            removed: () => {
                refreshFragments();
            }
        });

        return () => {
            liveQuery.stop();
            attrWatchersRef.current.forEach(w => w.stop());
            attrWatchersRef.current = [];
        };
    }, [config.fragmentContainerId]);

    const handleUpload = useCallback((fragment) => {
        if (!iframeLoaded) {
            alert('Repository not loaded yet. Please wait.');
            return;
        }

        if (!selectedFolderId) {
            alert('Please select a folder in the repository first.');
            return;
        }

        const iframe = iframeRef.current;
        if (!iframe || !iframe.contentDocument) {
            return;
        }

        const iframeDoc = iframe.contentDocument;
        const fragmentContainer = iframeDoc.querySelector('#' + config.fragmentContainerId);

        if (!fragmentContainer) {
            alert(`Could not find #${config.fragmentContainerId} container in repository.`);
            return;
        }

        const folder = fragmentContainer.querySelector(`code-folder[id="${CSS.escape(selectedFolderId)}"]`);

        if (!folder) {
            alert('Selected folder not found in repository.');
            return;
        }

        // Check if fragment already exists in repository
        const existingFragment = folder.querySelector(`code-fragment[id="${CSS.escape(fragment.id)}"]`);
        if (existingFragment) {
            if (!confirm(`${config.singular} "${fragment.getAttribute('name') || fragment.id}" already exists in this folder. Overwrite?`)) {
                return;
            }
        }

        // Clone and add to repository
        const clone = fragment.cloneNode(true);
        // Set timestamp attribute to current epoch time
        clone.setAttribute('timestamp', Date.now().toString());
        // Store the source document path
        clone.setAttribute('from-document', getDocumentPath());
        if (existingFragment) {
            folder.insertBefore(clone, existingFragment);
            existingFragment.remove();
        } else {
            folder.appendChild(clone);
        }
        WPMv2.stripProtection(folder);
    }, [config.fragmentContainerId, config.singular, iframeRef, iframeLoaded, selectedFolderId]);

    const handleDelete = useCallback((fragment) => {
        const name = fragment.getAttribute('name') || fragment.id;

        // Check if fragment is in use on the canvas
        let inUseCount = 0;
        if (config.shapeType && window.tldrawEditor) {
            const allShapes = window.tldrawEditor.getCurrentPageShapes() || [];
            inUseCount = allShapes.filter(
                shape => shape.type === config.shapeType && shape.props?.sourceFragmentId === fragment.id
            ).length;
        }

        let confirmMessage = `Are you sure you want to delete ${config.singular.toLowerCase()} "${name}"? This action cannot be undone.`;
        if (inUseCount > 0) {
            confirmMessage = `Warning: This ${config.singular.toLowerCase()} is currently in use by ${inUseCount} shape${inUseCount > 1 ? 's' : ''} on the canvas.\n\n${confirmMessage}`;
        }

        if (confirm(confirmMessage)) {
            fragment.remove();
        }
    }, [config.shapeType, config.singular]);

    const handleCreateOnCanvas = useCallback((fragment) => {
        if (!window.tldrawEditor) {
            alert('tldraw editor not available.');
            return;
        }

        const viewportCenter = window.tldrawEditor.getViewportScreenCenter();
        const pagePoint = window.tldrawEditor.screenToPage(viewportCenter);

        window.tldrawEditor.createShape({
            type: config.shapeType,
            x: pagePoint.x - 150,
            y: pagePoint.y - 150,
            props: {
                sourceFragmentId: fragment.id
            }
        });

        // Select the new shape
        const shapes = window.tldrawEditor.getCurrentPageShapes();
        const newShape = shapes[shapes.length - 1];
        if (newShape) {
            window.tldrawEditor.select(newShape.id);
        }
    }, [config.shapeType]);

    const handleOpenEditor = useCallback((fragmentId) => {
        const runAsync = async () => {
            if (typeof Cauldron === 'undefined' || typeof Cauldron.Cauldron === 'undefined') {
                await WPMv2.require({ package: 'Cauldron', repository: 'cauldron-repos' });
            }
            if (typeof localCauldronEditor === 'undefined') {
                window.localCauldronEditor = new Cauldron.Cauldron();
            }
            localCauldronEditor.open();

            const fragment = Fragment.one('#' + fragmentId);
            if (!fragment) {
                console.warn(`${config.singular} fragment not found:`, fragmentId);
                return;
            }

            EventSystem.triggerEvent('Cauldron.Open.FragmentEditor', { fragment });
        };

        runAsync();
    }, [config.singular]);

    return (
        <div className="fragments-section">
            <div className="section-header">
                <h3>Local Repository {config.plural}</h3>
            </div>
            <p className="section-description">Manage {config.plural.toLowerCase()} in this document{config.shapeType ? ', place them on the canvas,' : ','} or upload them to the remote repository. Changes are persistent and shared.</p>
            <div className="fragments-list">
                {fragments.length === 0 ? (
                    <p className="empty-message">No {config.plural.toLowerCase()} found in this document.</p>
                ) : (
                    fragments.map((fragment) => (
                        <FragmentItem
                            key={fragment.id}
                            fragment={fragment}
                            onUpload={handleUpload}
                            onOpenEditor={handleOpenEditor}
                            onCreateOnCanvas={handleCreateOnCanvas}
                            onDelete={handleDelete}
                            expanded={expandedFragments.has(fragment.id)}
                            onToggleExpand={toggleFragmentExpand}
                        />
                    ))
                )}
            </div>
        </div>
    );
}

function RepositoryFragments({ iframeRef, iframeLoaded, iframeLoadVersion, onFoldersChange, selectedFolderId, onSelectFolder }) {
    const config = useRepositoryConfig();
    const [folders, setFolders] = useState([]);
    const [updateCounter, setUpdateCounter] = useState(0);
    const [expandedFolders, setExpandedFolders] = useState(new Set());
    const [expandedFragments, setExpandedFragments] = useState(new Set());
    const liveQueriesRef = useRef([]);

    const toggleFolderExpand = useCallback((folderId) => {
        setExpandedFolders(prev => {
            const newSet = new Set(prev);
            if (newSet.has(folderId)) {
                newSet.delete(folderId);
            } else {
                newSet.add(folderId);
            }
            return newSet;
        });
    }, []);

    const toggleFragmentExpand = useCallback((fragmentId) => {
        setExpandedFragments(prev => {
            const newSet = new Set(prev);
            if (newSet.has(fragmentId)) {
                newSet.delete(fragmentId);
            } else {
                newSet.add(fragmentId);
            }
            return newSet;
        });
    }, []);

    const refreshFolders = useCallback((fragmentContainer) => {
        if (!fragmentContainer) {
            setFolders([]);
            onFoldersChange([]);
            return;
        }

        // Get all folders from the repository
        const allFolders = Array.from(fragmentContainer.querySelectorAll(':scope > code-folder'));

        // Sort folders alphabetically by name
        allFolders.sort((a, b) => {
            const aName = a.getAttribute('name') || '';
            const bName = b.getAttribute('name') || '';
            return aName.localeCompare(bName);
        });

        setFolders([...allFolders]);
        onFoldersChange([...allFolders]);
    }, [onFoldersChange]);

    useEffect(() => {
        if (!iframeLoaded) {
            setFolders([]);
            return;
        }

        const iframe = iframeRef.current;
        if (!iframe || !iframe.contentDocument) {
            setFolders([]);
            return;
        }

        let cleanedUp = false;

        const setupRepository = () => {
            if (cleanedUp) return;

            // Re-check iframe reference in case it changed
            const currentIframe = iframeRef.current;
            if (!currentIframe || currentIframe !== iframe) {
                // Iframe changed, abort setup
                return;
            }

            const iframeDoc = currentIframe.contentDocument;
            if (!iframeDoc) {
                setFolders([]);
                return;
            }

            let fragmentContainer = iframeDoc.querySelector('#' + config.fragmentContainerId);

            if (!fragmentContainer) {
                fragmentContainer = iframeDoc.createElement('div');
                fragmentContainer.id = config.fragmentContainerId;
                iframeDoc.body.appendChild(fragmentContainer);
                WPMv2.stripProtection(fragmentContainer);
            }

            const triggerUpdate = () => {
                if (cleanedUp) return;
                refreshFolders(fragmentContainer);
                setUpdateCounter(prev => prev + 1);
            };

            const setupAttrWatcher = (el) => {
                if (cleanedUp) return;
                const watcher = cQuery(el).liveAttribute('name', triggerUpdate);
                liveQueriesRef.current.push(watcher);
            };

            // Set up watchers for existing fragments
            fragmentContainer.querySelectorAll('code-folder > code-fragment').forEach(setupAttrWatcher);

            // Initial load
            triggerUpdate();

            // Watch for folder additions/removals
            const folderQuery = cQuery(fragmentContainer).liveQuery('code-folder', {
                added: triggerUpdate,
                removed: triggerUpdate
            });
            liveQueriesRef.current.push(folderQuery);

            // Watch for fragment additions/removals within folders
            const fragmentQuery = cQuery(fragmentContainer).liveQuery('code-fragment', {
                added: (el) => {
                    setupAttrWatcher(el);
                    triggerUpdate();
                },
                removed: triggerUpdate
            });
            liveQueriesRef.current.push(fragmentQuery);
        };

        // Start the setup process
        setupRepository();

        return () => {
            cleanedUp = true;
            liveQueriesRef.current.forEach(q => q.stop());
            liveQueriesRef.current = [];
        };
    }, [config.fragmentContainerId, iframeLoaded, iframeLoadVersion, iframeRef, refreshFolders]);

    const handleDownload = useCallback((fragment) => {
        const localContainer = document.querySelector('#' + config.fragmentContainerId);
        if (!localContainer) {
            alert(`Could not find local ${config.singular.toLowerCase()} container.`);
            return;
        }

        // Check if fragment already exists locally
        const existingFragment = localContainer.querySelector(`#${CSS.escape(fragment.id)}`);
        if (existingFragment) {
            if (!confirm(`${config.singular} "${fragment.getAttribute('name') || fragment.id}" already exists locally. Overwrite?`)) {
                return;
            }
        }

        // Clone and add to local container
        const clone = fragment.cloneNode(true);
        clone.removeAttribute('timestamp');
        if (existingFragment) {
            localContainer.insertBefore(clone, existingFragment);
            existingFragment.remove();
        } else {
            localContainer.appendChild(clone);
        }

        // Strip WPM protection if needed
        if (typeof WPMv2 !== 'undefined' && WPMv2.stripProtection) {
            WPMv2.stripProtection(clone);
        }

    }, [config.fragmentContainerId, config.singular]);

    const handleCreateFolder = useCallback(() => {
        const folderName = prompt('Enter folder name:');
        if (!folderName || !folderName.trim()) return;

        const iframe = iframeRef.current;
        if (!iframe || !iframe.contentDocument) return;

        const iframeDoc = iframe.contentDocument;
        const fragmentContainer = iframeDoc.querySelector('#' + config.fragmentContainerId);
        if (!fragmentContainer) return;

        const folder = iframeDoc.createElement('code-folder');
        folder.id = crypto.randomUUID();
        folder.setAttribute('name', folderName.trim());
        fragmentContainer.appendChild(folder);
        WPMv2.stripProtection(folder);

        // Select the newly created folder
        onSelectFolder(folder.id);
    }, [config.fragmentContainerId, iframeRef, onSelectFolder]);

    return (
        <div className="fragments-section repository-section">
            <div className="section-header">
                <h3>Remote Repository {config.plural}</h3>
                <button className="button small create-folder-btn" onClick={handleCreateFolder} title="Create new folder">
                    <span className="icon material-icons">create_new_folder</span>
                </button>
            </div>
            <p className="section-description">Browse, download, and organize {config.plural.toLowerCase()} in the remote repository. Changes are persistent and shared.</p>
            <div className="fragments-list">
                {!iframeLoaded ? (
                    <p className="empty-message">Loading repository...</p>
                ) : folders.length === 0 ? (
                    <p className="empty-message">No folders in the repository yet. Create one to upload {config.plural.toLowerCase()}.</p>
                ) : (
                    folders.map((folder) => (
                        <RepositoryFolder
                            key={folder.id || 'folder'}
                            folder={folder}
                            onDownload={handleDownload}
                            isSelected={selectedFolderId === folder.id}
                            onSelect={onSelectFolder}
                            expanded={expandedFolders.has(folder.id)}
                            onToggleExpand={toggleFolderExpand}
                            expandedFragments={expandedFragments}
                            onToggleFragmentExpand={toggleFragmentExpand}
                        />
                    ))
                )}
            </div>
        </div>
    );
}

function RepositoryChip({ url, isSelected, isDefault, onSelect, onDelete, onOpenExternal }) {
    return (
        <div
            className={`chip selectable ${isSelected ? 'selected' : ''} ${isDefault ? 'default' : ''}`}
            onClick={() => onSelect(url)}
            title={url}
        >
            <span className="chip-name">{url}</span>
            <div className="chip-actions" onClick={(e) => e.stopPropagation()}>
                <button
                    className="chip-action-btn"
                    onClick={() => onOpenExternal(url)}
                    title="Open repository"
                >
                    <span className="icon material-icons">open_in_new</span>
                </button>
                {isSelected && !isDefault && (
                    <button
                        className="chip-action-btn delete-btn"
                        onClick={() => onDelete(url)}
                        title="Remove from list"
                    >
                        <span className="icon material-icons">close</span>
                    </button>
                )}
            </div>
        </div>
    );
}

function AddRepositoryButton({ onAdd }) {
    const [isAdding, setIsAdding] = useState(false);
    const [inputValue, setInputValue] = useState('');
    const inputRef = useRef(null);

    useEffect(() => {
        if (isAdding && inputRef.current) {
            inputRef.current.focus();
        }
    }, [isAdding]);

    const handleSubmit = () => {
        const trimmed = inputValue.trim();
        if (trimmed) {
            onAdd(trimmed);
        }
        setInputValue('');
        setIsAdding(false);
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') {
            handleSubmit();
        } else if (e.key === 'Escape') {
            setInputValue('');
            setIsAdding(false);
        }
    };

    const handleBlur = () => {
        if (inputValue.trim()) {
            handleSubmit();
        } else {
            setIsAdding(false);
        }
    };

    if (isAdding) {
        return (
            <div className="add-chip-input-container">
                <input
                    ref={inputRef}
                    type="text"
                    className="add-chip-input"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onBlur={handleBlur}
                    placeholder="Repository URL..."
                />
            </div>
        );
    }

    return (
        <button
            className="add-chip-btn"
            onClick={() => setIsAdding(true)}
            title="Add repository"
        >
            <span className="icon material-icons">add</span>
        </button>
    );
}

function FragmentRepository({ config }) {
    const [visible, setVisible] = useTransientDOMState(`${config.type}-repository-visible`, false);
    const [iframeLoadState, setIframeLoadState] = useState({ repository: null, version: 0 });
    const [selectedFolderId, setSelectedFolderId] = useState(null);
    const iframeRef = useRef(null);

    // Store custom repositories in webstrate cookie
    const [customRepositories, setCustomRepositories] = useWebstrateCookieState(
        `${config.type}-repository-urls`,
        []
    );

    // Currently selected repository
    const [selectedRepository, setSelectedRepository] = useWebstrateCookieState(
        `${config.type}-repository-selected`,
        config.defaultRepositoryUrl
    );
    const iframeLoaded = iframeLoadState.repository === selectedRepository;

    // Combine default with custom repositories
    const allRepositories = [config.defaultRepositoryUrl, ...(customRepositories || [])];

    const handleIframeLoad = useCallback((event) => {
        const loadedIframe = event.currentTarget;
        if (loadedIframe !== iframeRef.current) return;

        const iframeWebstrate = loadedIframe.contentWindow?.webstrate;
        if (!iframeWebstrate || typeof iframeWebstrate.on !== 'function') return;

        const handleWebstrateLoaded = () => {
            if (typeof iframeWebstrate.off === 'function') {
                iframeWebstrate.off('loaded', handleWebstrateLoaded);
            }
            if (loadedIframe !== iframeRef.current) return;

            setIframeLoadState(previousState => ({
                repository: loadedIframe.dataset.repository,
                version: previousState.version + 1
            }));
        };

        iframeWebstrate.on('loaded', handleWebstrateLoaded);
    }, []);

    const handleFoldersChange = useCallback((folders) => {
        // If selected folder no longer exists, clear selection
        if (selectedFolderId && !folders.some(f => f.id === selectedFolderId)) {
            setSelectedFolderId(null);
        }
    }, [selectedFolderId]);

    const handleSelectFolder = useCallback((folderId) => {
        setSelectedFolderId(folderId);
    }, []);

    const handleSelectRepository = useCallback((url) => {
        if (url !== selectedRepository) {
            setSelectedRepository(url);
            setSelectedFolderId(null);
        }
    }, [selectedRepository, setSelectedRepository]);

    const handleAddRepository = useCallback((url) => {
        // Don't add if it already exists
        if (url === config.defaultRepositoryUrl || (customRepositories || []).includes(url)) {
            return;
        }
        setCustomRepositories(prev => [...(prev || []), url]);
        setSelectedRepository(url);
        setSelectedFolderId(null);
    }, [config.defaultRepositoryUrl, customRepositories, setCustomRepositories, setSelectedRepository]);

    const handleDeleteRepository = useCallback((url) => {
        // Can't delete default repository
        if (url === config.defaultRepositoryUrl) return;

        setCustomRepositories(prev => (prev || []).filter(r => r !== url));

        // If we deleted the selected repository, switch to default
        if (url === selectedRepository) {
            setSelectedRepository(config.defaultRepositoryUrl);
            setSelectedFolderId(null);
        }
    }, [config.defaultRepositoryUrl, selectedRepository, setSelectedRepository, setCustomRepositories]);

    const handleOpenExternal = useCallback((url) => {
        window.open(`/${url}/`, '_blank', 'noopener,noreferrer');
    }, []);

    return <RepositoryConfigContext.Provider value={config}>
        <iframe
            ref={iframeRef}
            src={`/${selectedRepository}/?codestrates=false`}
            data-repository={selectedRepository}
            className="fragment-repository-iframe"
            onLoad={handleIframeLoad}
            key={selectedRepository}
            style={{ display: 'none' }}
        />

        <Dialog
            className="fragment-repository-dialog"
            visible={visible}
            setVisible={setVisible}
        >
            <DialogHeader title={`${config.singular} Repository`} icon={config.icon} onClose={() => setVisible(false)} />

            <Section title="Remote Repository" color="#2196f3">
                <p className="section-description">Choose which {config.singular.toLowerCase()} repository to browse. The list and selection are connected to the current Webstrates user.</p>

                <div className="chips">
                    {allRepositories.map((url) => (
                        <RepositoryChip
                            key={url}
                            url={url}
                            isSelected={url === selectedRepository}
                            isDefault={url === config.defaultRepositoryUrl}
                            onSelect={handleSelectRepository}
                            onDelete={handleDeleteRepository}
                            onOpenExternal={handleOpenExternal}
                        />
                    ))}
                    <AddRepositoryButton onAdd={handleAddRepository} />
                </div>
            </Section>

            <div className="fragments-container">
                <LocalFragments iframeRef={iframeRef} selectedFolderId={selectedFolderId} iframeLoaded={iframeLoaded} />
                <RepositoryFragments iframeRef={iframeRef} iframeLoaded={iframeLoaded} iframeLoadVersion={iframeLoadState.version} onFoldersChange={handleFoldersChange} selectedFolderId={selectedFolderId} onSelectFolder={handleSelectFolder} />
            </div>
        </Dialog>
    </RepositoryConfigContext.Provider>;
}

export function createFragmentRepository(repositoryConfig) {
    const config = Object.freeze({ ...repositoryConfig });

    return function ConfiguredFragmentRepository() {
        return <FragmentRepository config={config} />;
    };
}
