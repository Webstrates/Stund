import React from 'react';
const { useEffect, useRef, useCallback } = React;

import {
    AI_CHAT_DOM_STORE_KEY,
    AI_CHAT_ENTRY_EVENT,
    AI_CHAT_STEP_EVENT
} from '#AIChatComponent .chat-contract';
import { ChatComposer, ChatHistory } from '#AIChatComponent .chat-views';
import { useChatContextController } from '#AIChatComponent .context-controller';
import { useSpeechInput } from '#AIChatComponent .speech-input';
import { useChatSession } from '#AIChatComponent .chat-session';



export {
    AI_CHAT_DOM_STORE_KEY,
    AI_CHAT_ENTRY_EVENT,
    AI_CHAT_STEP_EVENT
};



export function AIChatComponent({
    chatId = null,
    profiles = [],
    showProfileEditor = true,
    connectors = [],
    showConnectorEditor = true,
    persisted = false,
    hidden = false,
    onEntriesChange = null,
    onProcessingChange = null,
    onReset = null,
    onControlState = null
}) {
    const promptRef = useRef(null);
    const menuOverlayRef = useRef(null);
    const handleSubmitRef = useRef(null);

    const session = useChatSession({
        chatId,
        profiles,
        connectors,
        persisted,
        onEntriesChange,
        onProcessingChange,
        onReset
    });

    const context = useChatContextController({
        hidden,
        isDisabled: session.isDisabled,
        isProcessing: session.isProcessing
    });

    const appendPromptText = useCallback((text) => {
        if (!promptRef.current?.appendUserText) {
            return;
        }
        promptRef.current.appendUserText(text);
        promptRef.current.focus();
    }, []);

    const speech = useSpeechInput({
        isDisabled: session.isDisabled,
        isProcessing: session.isProcessing,
        appendPromptText
    });

    useEffect(() => {
        const overlay = document.createElement('transient');
        overlay.classList.add('ai-chat-component-global-menu-overlay');
        document.documentElement.appendChild(overlay);
        menuOverlayRef.current = overlay;

        return () => {
            overlay.remove();
        };
    }, []);

    useEffect(() => {
        if (session.currentProfile && promptRef.current) {
            promptRef.current.focus();
        }
    }, [session.currentProfile]);

    const handleSubmit = useCallback(() => {
        const text = promptRef.current?.getUserText ? promptRef.current.getUserText() : '';
        const currentContext = context.snapshot();
        return session.submit({
            text,
            images: currentContext.images,
            shapes: currentContext.shapes
        }, () => {
            context.clear();
            if (promptRef.current?.clearUserText) {
                promptRef.current.clearUserText();
            }
        });
    }, [context, session]);
    handleSubmitRef.current = handleSubmit;

    const handleReset = useCallback(async () => {
        if (speech.isRecording) {
            speech.stop();
        }

        const didReset = await session.reset();
        if (didReset && promptRef.current) {
            promptRef.current.focus();
        }
    }, [speech, session]);

    const handleSendOrCancel = useCallback(() => {
        if (session.isProcessing) {
            session.cancel();
        } else {
            handleSubmit();
        }
    }, [session, handleSubmit]);

    const handleProfileMenuClick = useCallback((event) => {
        if (!menuOverlayRef.current || !window.MenuSystem) {
            return;
        }

        const profileMenu = window.MenuSystem.MenuManager.createMenu('AIChatComponent.Profile.SelectMenu', {
            groupDividers: true
        });

        profiles.forEach((profile) => {
            profileMenu.addItem({
                label: profile.name,
                icon: window.IconRegistry?.createIcon('mdc:psychology'),
                onAction: async () => {
                    await session.setProfile(profile);
                    if (promptRef.current) {
                        promptRef.current.focus();
                    }
                }
            });
        });

        profileMenu.registerOnCloseCallback(() => profileMenu.html.remove());
        menuOverlayRef.current.appendChild(profileMenu.html);
        profileMenu.open({ x: event.pageX, y: event.pageY });
        event.preventDefault();
        event.stopPropagation();
    }, [profiles, session]);

    const handleConnectorMenuClick = useCallback((event) => {
        if (!menuOverlayRef.current || !window.MenuSystem || connectors.length < 1) {
            return;
        }

        const connectorMenu = window.MenuSystem.MenuManager.createMenu('AIChatComponent.Connector.SelectMenu', {
            groupDividers: true
        });

        connectors.forEach((connector) => {
            connectorMenu.addItem({
                label: connector.name,
                icon: window.IconRegistry?.createIcon('mdc:memory'),
                onAction: () => session.setConnector(connector)
            });
        });

        connectorMenu.registerOnCloseCallback(() => connectorMenu.html.remove());
        menuOverlayRef.current.appendChild(connectorMenu.html);
        connectorMenu.open({ x: event.pageX, y: event.pageY });
        event.preventDefault();
        event.stopPropagation();
    }, [connectors, session]);

    useEffect(() => {
        if (typeof onControlState !== 'function') {
            return;
        }

        const controls = {
            isReady: () => {
                return Boolean(
                    !session.isDisabled &&
                    session.currentProfile &&
                    session.currentConnector &&
                    promptRef.current?.setUserText &&
                    promptRef.current?.getUserText
                );
            },
            setPrompt: (prompt) => {
                if (!promptRef.current?.setUserText) {
                    return false;
                }
                promptRef.current.setUserText(typeof prompt === 'string' ? prompt : '');
                return true;
            },
            setToolGroups: session.applyExternalToolGroups,
            setImages: context.setImages,
            appendImages: context.appendImages,
            setShapes: context.setShapes,
            appendShapes: context.appendShapes,
            submit: () => {
                if (typeof handleSubmitRef.current !== 'function') {
                    return false;
                }
                handleSubmitRef.current();
                return true;
            }
        };

        onControlState(controls);
        return () => {
            onControlState(null);
        };
    }, [
        onControlState,
        session.isDisabled,
        session.currentProfile,
        session.currentConnector,
        session.applyExternalToolGroups,
        context.setImages,
        context.appendImages,
        context.setShapes,
        context.appendShapes
    ]);

    if (profiles.length < 1) {
        return <div className="ai-chat-component-error">Must provide at least one profile</div>;
    }

    const identity = {
        chatId,
        persisted,
        profiles,
        connectors,
        showProfileEditor,
        showConnectorEditor,
        currentProfile: session.currentProfile,
        currentConnector: session.currentConnector
    };
    const availability = {
        isDisabled: session.isDisabled,
        isProcessing: session.isProcessing,
        isLocalProcessing: session.isLocalProcessing
    };
    const actions = {
        submit: handleSubmit,
        sendOrCancel: handleSendOrCancel,
        reset: handleReset,
        openProfileMenu: handleProfileMenuClick,
        openConnectorMenu: handleConnectorMenuClick
    };
    const tools = {
        groups: session.displayedToolGroups,
        toggle: session.toggleToolGroup
    };

    return <div
        className={`ai-enhanced-chat ${session.isDisabled ? 'chat-disabled' : ''}`}
        style={hidden ? { display: 'none' } : undefined}
    >
        {persisted && (
            <div className="persistence-indicator">
                <span className="icon material-icons">group</span>
                <span className="label">Shared Chat — Synced with other users</span>
            </div>
        )}
        <ChatHistory
            entries={session.entries}
            persisted={persisted}
            isDisabled={session.isDisabled}
            menuOverlay={menuOverlayRef.current}
            entryImagePreviews={session.entryImagePreviews}
        />
        <ChatComposer
            identity={identity}
            availability={availability}
            context={context}
            speech={speech}
            tools={tools}
            actions={actions}
            entries={session.entries}
            entryImagePreviews={session.entryImagePreviews}
            promptRef={promptRef}
        />
    </div>;
}
