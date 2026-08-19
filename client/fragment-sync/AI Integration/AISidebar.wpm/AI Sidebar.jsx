import React from 'react';
const { useEffect, useRef, useState, useMemo, useCallback } = React;

import { createConnector } from '#SlopScript .connector-factory';
import { AIChatComponent, AI_CHAT_DOM_STORE_KEY } from '#AIChatComponent .default';
import { useCookieState } from '#CoreHelpers .cookie-store';
import { useDOMState, deleteDOMState } from '#CoreHelpers .dom-store';
import { useGlobalEvents } from '#CoreHelpers .global-events';
import { useModel } from '#ModelManager .default';



const DEFAULT_WIDTH = 400;
const MIN_WIDTH = 384;
const MAX_WIDTH = 800;

const AGENT_FRAGMENT_ID = '#main-agent-slop';
const { MainAgent } = await Fragment.one(AGENT_FRAGMENT_ID).require();

const NEW_LOCAL_CHAT_NAME = 'New Chat';
const NEW_SHARED_CHAT_NAME = 'New Shared Chat';

const TAB_TYPES = {
    LOCAL: 'local',
    SHARED: 'shared'
};

const AI_SIDEBAR_CREATE_CHAT_EVENT = 'ai-sidebar-create-chat';
const AI_SIDEBAR_UPDATE_ACTIVE_CHAT_EVENT = 'ai-sidebar-update-active-chat';

const generateTabId = () => `chat-${crypto.randomUUID()}`;

// Extract tab name from the last user message
const getTabNameFromEntries = (entries, fallbackName) => {
    const userEntries = entries?.filter(e => e.type === 'you' || e.type === 'user');
    const lastUserEntry = userEntries?.[userEntries.length - 1];
    if (lastUserEntry?.content) {
        const name = lastUserEntry.content.trim();
        return name || fallbackName;
    }
    return fallbackName;
};



function UserIndicator({ user }) {
    const firstLetter = (user.userId || 'A').charAt(0).toUpperCase();
    return <span className="user-indicator" title={user.userId}>{firstLetter}</span>;
}

function ChatTab({ tab, isActive, processingInfo, onSelect, onClose, activeUsers }) {
    const normalizedUsers = Array.isArray(activeUsers)
        ? activeUsers
        : (activeUsers && typeof activeUsers === 'object')
            ? Object.values(activeUsers)
            : [];

    // Show unique users by userId (fall back to clientId for anonymous/legacy entries).
    const uniqueUsers = [...new Map(normalizedUsers.map((u) => [u.userId || u.clientId, u])).values()];

    const isProcessing = processingInfo?.isProcessing || false;
    const isLocal = processingInfo?.isLocal ?? true;

    const closeTab = (e) => {
        e.stopPropagation();
        onClose(tab.id);
    };

    return <div className={`chat-tab${isActive ? ' active' : ''}${isProcessing ? ' processing' : ''}${isProcessing && !isLocal ? ' remote' : ''}`}
        onClick={() => onSelect(tab.id)} title={tab.name}>

        {isProcessing && <span className="processing-indicator" title={isLocal ? 'Processing' : 'Processing Remotely'}>
            <span className="spinnerCircle" />
        </span>}

        <span className="tab-name">{tab.name}</span>

        {uniqueUsers.length > 0 && <span className="active-users">
            {uniqueUsers.map(user => (
                <UserIndicator key={user.clientId} user={user} />
            ))}
        </span>}

        <button className="tab-close" onClick={closeTab}>
            <span className="material-icons">close</span>
        </button>
    </div>;
}

function TabRegion({ title, tabs, activeTabId, processingTabs, onSelectTab, onCloseTab, onAddTab, icon, activeUsersMap }) {
    return <div className="tab-region">
        <div className="tab-region-header">
            <span className="material-icons">{icon}</span>
            <span className="tab-region-title">{title}</span>
            <button className="add-tab-button" onClick={onAddTab} title={`New ${title.toLowerCase()}`}>
                <span className="material-icons">add</span>
            </button>
        </div>
        <div className="tab-list">
            {tabs.map(tab => (
                <ChatTab
                    key={tab.id}
                    tab={tab}
                    isActive={activeTabId === tab.id}
                    processingInfo={processingTabs[tab.id] || null}
                    onSelect={onSelectTab}
                    onClose={onCloseTab}
                    activeUsers={activeUsersMap?.[tab.id]}
                />
            ))}
            {tabs.length === 0 && (
                <div className="no-tabs-message">No chats yet</div>
            )}
        </div>
    </div>;
}

export function Main() {
    const { subscribeEvent } = useGlobalEvents();

    // CONNECTOR

    const [mainAgentModel] = useModel('main-agent');
    // Map of tabId -> connector instance
    const tabConnectorsRef = useRef({});

    // Clean up connector when tab is closed
    const cleanupTabConnector = useCallback((tabId) => {
        delete tabConnectorsRef.current[tabId];
    }, []);



    // RESIZING

    const [minimized, setMinimized] = useCookieState('ai-sidebar-minimized', false);
    const [width, setWidth] = useCookieState('ai-sidebar-width', DEFAULT_WIDTH);
    const [isResizing, setIsResizing] = useState(false);
    const resizeStartRef = useRef(null);

    const startResize = (e) => {
        e.preventDefault();
        resizeStartRef.current = {
            startX: e.clientX,
            startWidth: width
        };
        setIsResizing(true);
    };

    useEffect(() => {
        if (!isResizing || !resizeStartRef.current) return;

        const handleMouseMove = (e) => {
            const { startX, startWidth } = resizeStartRef.current;
            const delta = startX - e.clientX;
            setWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth + delta)));
        };

        const handleMouseUp = () => {
            setIsResizing(false);
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);

        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isResizing]);

    useEffect(() => {
        document.querySelector('#app-root').style.setProperty('--sidebar-width', `${minimized ? 0 : width}px`);
    }, [minimized, width]);



    // TABS

    const slopInstancesRef = useRef({});  // Map of tabId -> slop instance
    const [processingTabs, setProcessingTabs] = useState({});  // Map of tabId -> { isProcessing, isLocal }

    const [localTabs, setLocalTabs] = useState(() => {
        const initialTab = { id: generateTabId(), name: NEW_LOCAL_CHAT_NAME, createdAt: Date.now() };
        return [initialTab];
    });
    const [sharedTabs, setSharedTabs] = useDOMState('ai-sidebar-shared-tabs', []);

    const [activeTabId, setActiveTabId] = useState(() => localTabs[0]?.id || null);
    const [activeTabType, setActiveTabType] = useState(TAB_TYPES.LOCAL);

    // Track active users on shared tabs: { tabId: [{ clientId, userId }] }
    const [activeUsersMap, setActiveUsersMap] = useDOMState('ai-sidebar-active-users', {});
    const prevActiveSharedTabRef = useRef(null);

    const pruneDisconnectedUsers = useCallback((usersByTab) => {
        const connectedClients = window.webstrate?.clients || [];
        const connectedClientSet = new Set(connectedClients);
        const cleanedUsersByTab = {};

        Object.entries(usersByTab || {}).forEach(([tabId, rawUsers]) => {
            const users = Array.isArray(rawUsers)
                ? rawUsers
                : (rawUsers && typeof rawUsers === 'object')
                    ? Object.values(rawUsers)
                    : [];
            const uniqueLiveUsers = new Map();
            users.forEach((user) => {
                if (connectedClientSet.has(user.clientId)) {
                    uniqueLiveUsers.set(user.clientId, user);
                }
            });

            if (uniqueLiveUsers.size > 0) {
                cleanedUsersByTab[tabId] = Array.from(uniqueLiveUsers.values());
            }
        });

        return cleanedUsersByTab;
    }, []);

    // Update active users when switching tabs
    useEffect(() => {
        const clientId = window.webstrate?.clientId;
        const userId = window.webstrate?.user?.userId || 'anonymous';

        if (!clientId) return;

        const currentSharedTabId = activeTabType === TAB_TYPES.SHARED ? activeTabId : null;
        const prevSharedTabId = prevActiveSharedTabRef.current;

        // Skip if no change
        if (currentSharedTabId === prevSharedTabId) return;

        setActiveUsersMap((prev) => {
            const updated = pruneDisconnectedUsers(prev);

            // Remove from previous shared tab
            if (prevSharedTabId && updated[prevSharedTabId]) {
                updated[prevSharedTabId] = updated[prevSharedTabId].filter(
                    (u) => u.clientId !== clientId
                );
                if (updated[prevSharedTabId].length === 0) {
                    delete updated[prevSharedTabId];
                }
            }

            // Add to current shared tab
            if (currentSharedTabId) {
                const currentUsers = updated[currentSharedTabId] || [];
                // Only add if not already present
                if (!currentUsers.some((u) => u.clientId === clientId)) {
                    updated[currentSharedTabId] = [...currentUsers, { clientId, userId }];
                }
            }

            return updated;
        });

        prevActiveSharedTabRef.current = currentSharedTabId;
    }, [activeTabId, activeTabType, pruneDisconnectedUsers, setActiveUsersMap]);

    // Prune disconnected users whenever clients join/leave.
    useEffect(() => {
        const webstrate = window.webstrate;
        if (!webstrate || typeof webstrate.on !== 'function') return;

        const handleClientChange = () => {
            setActiveUsersMap((prev) => pruneDisconnectedUsers(prev));
        };

        handleClientChange();
        webstrate.on('clientJoin', handleClientChange);
        webstrate.on('clientPart', handleClientChange);

        return () => {
            if (typeof webstrate.off === 'function') {
                webstrate.off('clientJoin', handleClientChange);
                webstrate.off('clientPart', handleClientChange);
            }
        };
    }, [pruneDisconnectedUsers, setActiveUsersMap]);

    // Clean up user from all tabs when component unmounts or window closes
    useEffect(() => {
        const clientId = window.webstrate?.clientId;
        if (!clientId) return;

        const cleanup = () => {
            setActiveUsersMap((prev) => {
                const updated = pruneDisconnectedUsers(prev);
                for (const tabId of Object.keys(updated)) {
                    updated[tabId] = updated[tabId].filter((u) => u.clientId !== clientId);
                    if (updated[tabId].length === 0) {
                        delete updated[tabId];
                    }
                }
                return updated;
            });
        };

        window.addEventListener('beforeunload', cleanup);
        return () => {
            window.removeEventListener('beforeunload', cleanup);
            cleanup();
        };
    }, [pruneDisconnectedUsers, setActiveUsersMap]);

    // Memoized handlers and profiles per tab to prevent infinite update loops
    const tabHandlersRef = useRef({});
    const tabControlHandlersRef = useRef({});
    const pendingChatRequestRef = useRef({});
    const tabControlsRef = useRef({});

    const applyPendingChatRequest = useCallback((chatId) => {
        const pendingChatRequest = pendingChatRequestRef.current[chatId];
        const controls = tabControlsRef.current[chatId];

        if (!pendingChatRequest || !controls || typeof controls.isReady !== 'function' || !controls.isReady()) {
            return false;
        }
        const hasPrompt = typeof pendingChatRequest.prompt === 'string';
        const prompt = hasPrompt ? pendingChatRequest.prompt : '';
        const autoSend = pendingChatRequest.autoSend === true;
        const activeToolGroupIds = pendingChatRequest.activeToolGroupIds;
        const hasImagesValue = Object.prototype.hasOwnProperty.call(pendingChatRequest, 'images');
        const images = Array.isArray(pendingChatRequest.images) ? pendingChatRequest.images : [];
        const mergeImages = pendingChatRequest.mergeImages === true;
        const hasShapesValue = Object.prototype.hasOwnProperty.call(pendingChatRequest, 'shapes');
        const shapes = Array.isArray(pendingChatRequest.shapes) ? pendingChatRequest.shapes : [];
        const mergeShapes = pendingChatRequest.mergeShapes === true;
        const hasImages = Array.isArray(images) && images.length > 0;
        const hasShapes = Array.isArray(shapes) && shapes.length > 0;

        if (Array.isArray(activeToolGroupIds) && typeof controls.setToolGroups === 'function') {
            const didApplyToolGroups = controls.setToolGroups(activeToolGroupIds);
            if (!didApplyToolGroups) {
                return false;
            }
        }

        if (hasPrompt && typeof controls.setPrompt === 'function') {
            controls.setPrompt(prompt);
        }

        if (hasImagesValue) {
            if (mergeImages && typeof controls.appendImages === 'function') {
                controls.appendImages(images);
            } else if (typeof controls.setImages === 'function') {
                controls.setImages(images);
            }
        }

        if (hasShapesValue) {
            if (mergeShapes && typeof controls.appendShapes === 'function') {
                controls.appendShapes(shapes);
            } else if (typeof controls.setShapes === 'function') {
                controls.setShapes(shapes);
            }
        }

        if (autoSend && (prompt.trim() || hasImages || hasShapes) && typeof controls.submit === 'function') {
            requestAnimationFrame(() => {
                controls.submit();
            });
        }

        delete pendingChatRequestRef.current[chatId];
        return true;
    }, []);

    const retryApplyPendingChatRequest = useCallback((chatId, retries = 20) => {
        if (!pendingChatRequestRef.current[chatId]) return;
        const didApply = applyPendingChatRequest(chatId);
        if (!didApply && retries > 0) {
            requestAnimationFrame(() => {
                retryApplyPendingChatRequest(chatId, retries - 1);
            });
        }
    }, [applyPendingChatRequest]);

    const getTabControlHandler = useCallback((tabId) => {
        if (!tabControlHandlersRef.current[tabId]) {
            tabControlHandlersRef.current[tabId] = (controls) => {
                if (controls) {
                    tabControlsRef.current[tabId] = controls;
                } else {
                    delete tabControlsRef.current[tabId];
                }

                retryApplyPendingChatRequest(tabId);
            };
        }

        return tabControlHandlersRef.current[tabId];
    }, [retryApplyPendingChatRequest]);

    const handleCreateChatRequest = useCallback(({
        chatId,
        prompt = '',
        activeToolGroupIds,
        persisted = false,
        autoSend = true,
        images = [],
        shapes = []
    } = {}) => {
        const tabType = persisted ? TAB_TYPES.SHARED : TAB_TYPES.LOCAL;
        const fallbackName = tabType === TAB_TYPES.SHARED ? NEW_SHARED_CHAT_NAME : NEW_LOCAL_CHAT_NAME;
        const tabName = prompt.trim() || fallbackName;
        const newTab = {
            id: chatId,
            name: tabName,
            createdAt: Date.now(),
            ...(tabType === TAB_TYPES.SHARED ? { createdBy: window.webstrate?.user?.userId || 'anonymous' } : {})
        };

        if (tabType === TAB_TYPES.LOCAL) {
            setLocalTabs((prev) => {
                if (prev.some((tab) => tab.id === chatId)) return prev;
                return [...prev, newTab];
            });
        } else {
            setSharedTabs((prev) => {
                if (prev.some((tab) => tab.id === chatId)) return prev;
                return [...prev, newTab];
            });
        }

        pendingChatRequestRef.current[chatId] = { chatId, prompt, activeToolGroupIds, persisted, autoSend, images, shapes };
        setActiveTabId(chatId);
        setActiveTabType(tabType);
        setMinimized(false);

        requestAnimationFrame(() => {
            retryApplyPendingChatRequest(chatId);
        });
    }, [setSharedTabs, setMinimized, retryApplyPendingChatRequest]);

    const handleUpdateActiveChatRequest = useCallback(({
        prompt,
        activeToolGroupIds,
        persisted = false,
        autoSend = false,
        images,
        mergeImages = false,
        shapes,
        mergeShapes = false,
        createIfMissing = true
    } = {}) => {
        const currentActiveTabId = activeTabId;
        const hasActiveTab = Boolean(currentActiveTabId) && (
            localTabs.some((tab) => tab.id === currentActiveTabId) ||
            sharedTabs.some((tab) => tab.id === currentActiveTabId)
        );

        if (!hasActiveTab) {
            if (!createIfMissing) {
                return;
            }

            const chatId = generateTabId();
            handleCreateChatRequest({
                chatId,
                prompt: typeof prompt === 'string' ? prompt : '',
                activeToolGroupIds,
                persisted,
                autoSend,
                images: Array.isArray(images) ? images : [],
                shapes: Array.isArray(shapes) ? shapes : []
            });
            return;
        }

        const pendingChatRequest = {
            chatId: currentActiveTabId,
            autoSend: autoSend === true
        };

        if (typeof prompt === 'string') {
            pendingChatRequest.prompt = prompt;
        }

        if (Array.isArray(activeToolGroupIds)) {
            pendingChatRequest.activeToolGroupIds = activeToolGroupIds;
        }

        if (images !== undefined) {
            pendingChatRequest.images = Array.isArray(images) ? images : [];
            pendingChatRequest.mergeImages = mergeImages === true;
        }

        if (shapes !== undefined) {
            pendingChatRequest.shapes = Array.isArray(shapes) ? shapes : [];
            pendingChatRequest.mergeShapes = mergeShapes === true;
        }

        pendingChatRequestRef.current[currentActiveTabId] = pendingChatRequest;
        setMinimized(false);

        requestAnimationFrame(() => {
            retryApplyPendingChatRequest(currentActiveTabId);
        });
    }, [activeTabId, localTabs, sharedTabs, handleCreateChatRequest, setMinimized, retryApplyPendingChatRequest]);

    useEffect(() => {
        if (typeof subscribeEvent !== 'function') return;
        const unsubscribeCreateChat = subscribeEvent(AI_SIDEBAR_CREATE_CHAT_EVENT, handleCreateChatRequest);
        const unsubscribeUpdateActiveChat = subscribeEvent(AI_SIDEBAR_UPDATE_ACTIVE_CHAT_EVENT, handleUpdateActiveChatRequest);
        return () => {
            if (typeof unsubscribeCreateChat === 'function') {
                unsubscribeCreateChat();
            }
            if (typeof unsubscribeUpdateActiveChat === 'function') {
                unsubscribeUpdateActiveChat();
            }
        };
    }, [subscribeEvent, handleCreateChatRequest, handleUpdateActiveChatRequest]);

    const addLocalTab = useCallback(() => {
        const newTab = {
            id: generateTabId(),
            name: NEW_LOCAL_CHAT_NAME,
            createdAt: Date.now()
        };
        setLocalTabs(prev => [...prev, newTab]);
        setActiveTabId(newTab.id);
        setActiveTabType(TAB_TYPES.LOCAL);
    }, [localTabs.length]);

    const addSharedTab = useCallback(() => {
        const newTab = {
            id: generateTabId(),
            name: NEW_SHARED_CHAT_NAME,
            createdAt: Date.now(),
            createdBy: window.webstrate?.user?.userId || 'anonymous'
        };
        setSharedTabs(prev => [...prev, newTab]);
        setActiveTabId(newTab.id);
        setActiveTabType(TAB_TYPES.SHARED);
    }, [sharedTabs.length, setSharedTabs]);

    const closeTab = useCallback((tabId, tabType) => {
        if (processingTabs[tabId]?.isProcessing) {
            if (!confirm('This chat is still processing. Are you sure you want to close it?')) {
                return;
            }
        }

        // Clean up handlers ref
        const handlerKey = `${tabType}-${tabId}`;
        delete tabHandlersRef.current[handlerKey];
        delete tabControlHandlersRef.current[tabId];
        delete tabControlsRef.current[tabId];
        delete pendingChatRequestRef.current[tabId];
        cleanupTabConnector(tabId);

        const setTabsFunction = tabType === TAB_TYPES.LOCAL ? setLocalTabs : setSharedTabs;
        const otherTabs = tabType === TAB_TYPES.LOCAL ? sharedTabs : localTabs;
        const otherTabType = tabType === TAB_TYPES.LOCAL ? TAB_TYPES.SHARED : TAB_TYPES.LOCAL;

        setTabsFunction(prev => {
            const newTabs = prev.filter(t => t.id !== tabId);

            // If we're closing the active tab, switch to another
            if (activeTabId === tabId && activeTabType === tabType) {
                if (newTabs.length > 0) {
                    setActiveTabId(newTabs[newTabs.length - 1].id);
                } else if (otherTabs.length > 0) {
                    setActiveTabId(otherTabs[0].id);
                    setActiveTabType(otherTabType);
                } else {
                    setActiveTabId(null);
                }
            }

            // Clean up slop instance
            delete slopInstancesRef.current[tabId];
            return newTabs;
        });

        // Clean up persisted DOM state for shared chats
        if (tabType === TAB_TYPES.SHARED) {
            deleteDOMState(`chat-entries-${tabId}`, AI_CHAT_DOM_STORE_KEY);
            deleteDOMState(`chat-processing-${tabId}`, AI_CHAT_DOM_STORE_KEY);
            deleteDOMState(`chat-input-${tabId}`, AI_CHAT_DOM_STORE_KEY);
            deleteDOMState(`chat-toolgroups-${tabId}`, AI_CHAT_DOM_STORE_KEY);
        }
    }, [activeTabId, activeTabType, localTabs, sharedTabs, processingTabs, setSharedTabs]);

    const selectTab = useCallback((tabId, type) => {
        setActiveTabId(tabId);
        setActiveTabType(type);
    }, []);

    // Get or create stable handlers for a specific tab
    const getTabHandlers = useCallback((tabId, tabType) => {
        const key = `${tabType}-${tabId}`;
        if (!tabHandlersRef.current[key]) {
            tabHandlersRef.current[key] = {
                onEntriesChange: (newEntries) => {
                    const newName = getTabNameFromEntries(newEntries, null);
                    if (!newName) return;

                    // Always update the tab name to the last message
                    if (tabType === TAB_TYPES.LOCAL) {
                        setLocalTabs(prev => prev.map(tab =>
                            tab.id === tabId
                                ? { ...tab, name: newName, nameSet: true }
                                : tab
                        ));
                    } else {
                        setSharedTabs(prev => prev.map(tab =>
                            tab.id === tabId
                                ? { ...tab, name: newName, nameSet: true }
                                : tab
                        ));
                    }
                },
                onProcessingChange: (isProcessing, isLocal) => {
                    setProcessingTabs(prev => ({
                        ...prev,
                        [tabId]: { isProcessing, isLocal }
                    }));
                },
                onReset: () => {
                    if (tabType === TAB_TYPES.LOCAL) {
                        setLocalTabs(prev => prev.map(tab =>
                            tab.id === tabId
                                ? { ...tab, name: NEW_LOCAL_CHAT_NAME, nameSet: false }
                                : tab
                        ));
                    } else {
                        setSharedTabs(prev => prev.map(tab =>
                            tab.id === tabId
                                ? { ...tab, name: NEW_SHARED_CHAT_NAME, nameSet: false }
                                : tab
                        ));
                    }
                }
            };
        }
        return tabHandlersRef.current[key];
    }, [setSharedTabs]);

    const getProfilesForTab = useCallback((tabId) => {
        const mainAgentProfile = {
            name: 'Main Agent',
            connector: tabConnectorsRef.current[tabId] || null,
            onInit: async () => {
                if (!tabConnectorsRef.current[tabId]) {
                    tabConnectorsRef.current[tabId] = createConnector(mainAgentModel);
                }

                const connector = tabConnectorsRef.current[tabId];
                mainAgentProfile.connector = connector;

                if (!slopInstancesRef.current[tabId]) {
                    const instance = new MainAgent();
                    instance.connector = connector;
                    slopInstancesRef.current[tabId] = instance;
                } else if (slopInstancesRef.current[tabId].connector !== connector) {
                    slopInstancesRef.current[tabId].connector = connector;
                }
            },
            onPrompt: async (messages, activeToolGroupIds, imageContext = [], shapeContext = []) => {
                return await slopInstancesRef.current[tabId]?.prompt(messages, activeToolGroupIds, imageContext, shapeContext);
            },
            getToolGroups: () => slopInstancesRef.current[tabId]?.getToolGroups() || []
        };

        return [mainAgentProfile];
    }, [mainAgentModel]);

    // Combine all tabs for rendering
    const allTabs = useMemo(() => {
        const local = localTabs.map(tab => ({ ...tab, type: TAB_TYPES.LOCAL }));
        const shared = sharedTabs.map(tab => ({ ...tab, type: TAB_TYPES.SHARED }));
        return [...local, ...shared];
    }, [localTabs, sharedTabs]);

    return <div className={`ai-sidebar${minimized ? ' minimized' : ''}${isResizing ? ' resizing' : ''}`}>
        <div className="ai-sidebar-resize-handle" onMouseDown={startResize} />
        <div className="ai-sidebar-tabs">
            <TabRegion
                title="Local Chats"
                icon="person"
                tabs={localTabs}
                activeTabId={activeTabType === TAB_TYPES.LOCAL ? activeTabId : null}
                processingTabs={processingTabs}
                onSelectTab={(id) => selectTab(id, TAB_TYPES.LOCAL)}
                onCloseTab={(id) => closeTab(id, TAB_TYPES.LOCAL)}
                onAddTab={addLocalTab}
            />
            <TabRegion
                title="Shared Chats"
                icon="group"
                tabs={sharedTabs}
                activeTabId={activeTabType === TAB_TYPES.SHARED ? activeTabId : null}
                processingTabs={processingTabs}
                onSelectTab={(id) => selectTab(id, TAB_TYPES.SHARED)}
                onCloseTab={(id) => closeTab(id, TAB_TYPES.SHARED)}
                onAddTab={addSharedTab}
                activeUsersMap={activeUsersMap}
            />
        </div>

        <div className="ai-sidebar-chat">
            {allTabs.map(tab => {
                const handlers = getTabHandlers(tab.id, tab.type);
                return <AIChatComponent
                    key={tab.id}
                    chatId={tab.id}
                    profiles={getProfilesForTab(tab.id)}
                    showProfileEditor={false}
                    connectors={[]}
                    showConnectorEditor={false}
                    persisted={tab.type === TAB_TYPES.SHARED}
                    hidden={!(activeTabId === tab.id && activeTabType === tab.type)}
                    onEntriesChange={handlers.onEntriesChange}
                    onProcessingChange={handlers.onProcessingChange}
                    onReset={handlers.onReset}
                    onControlState={getTabControlHandler(tab.id)}
                />;
            })}
            {allTabs.length === 0 && (
                <div className="no-active-chat">
                    <span className="material-icons">chat</span>
                    <p>No chat selected</p>
                    <p>Create a new local or shared chat to get started</p>
                </div>
            )}
        </div>
    </div>;
}

export const useAISidebar = () => {
    const { triggerEvent } = useGlobalEvents();

    const createChatWithGlobalEvents = useCallback((prompt, activeToolGroupIds, persisted, autoSend, images, shapes) => {
        const chatId = generateTabId();
        triggerEvent(AI_SIDEBAR_CREATE_CHAT_EVENT, {
            chatId,
            prompt,
            activeToolGroupIds,
            persisted,
            autoSend,
            images,
            shapes
        });
        return chatId;
    }, [triggerEvent]);

    const updateCurrentChatWithGlobalEvents = useCallback(({
        prompt,
        activeToolGroupIds,
        persisted = false,
        autoSend = false,
        images,
        mergeImages = false,
        shapes,
        mergeShapes = false,
        createIfMissing = true
    } = {}) => {
        triggerEvent(AI_SIDEBAR_UPDATE_ACTIVE_CHAT_EVENT, {
            prompt,
            activeToolGroupIds,
            persisted,
            autoSend,
            images,
            mergeImages,
            shapes,
            mergeShapes,
            createIfMissing
        });
    }, [triggerEvent]);

    const attachImagesToCurrentChatWithGlobalEvents = useCallback((images, options = {}) => {
        updateCurrentChatWithGlobalEvents({
            ...options,
            images,
            mergeImages: true
        });
    }, [updateCurrentChatWithGlobalEvents]);

    const attachShapesToCurrentChatWithGlobalEvents = useCallback((shapes, options = {}) => {
        updateCurrentChatWithGlobalEvents({
            ...options,
            shapes,
            mergeShapes: true
        });
    }, [updateCurrentChatWithGlobalEvents]);

    return {
        createChat: createChatWithGlobalEvents,
        updateCurrentChat: updateCurrentChatWithGlobalEvents,
        attachImagesToCurrentChat: attachImagesToCurrentChatWithGlobalEvents,
        attachShapesToCurrentChat: attachShapesToCurrentChatWithGlobalEvents
    };
};
