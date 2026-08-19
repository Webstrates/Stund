import React from 'react';
const { useEffect, useState, useCallback } = React;

import { useDOMState } from '#CoreHelpers .dom-store';
import { useGlobalEvents } from '#CoreHelpers .global-events';



if (!window.clientStreams) {
    window.clientStreams = new Map();
}

const generateStreamId = (clientId, streamKey) => {
    return streamKey + clientId;
};

const addStreamObjectToWindowMap = (clientId, stream, streamKey) => {
    const streamId = generateStreamId(clientId, streamKey);
    window.clientStreams.set(streamId, stream);
};

const removeStreamObjectToWindowMap = (clientId, streamKey) => {
    const streamId = generateStreamId(clientId, streamKey);
    const stream = window.clientStreams.get(streamId);
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        window.clientStreams.delete(streamId);
    }
}


/**
 * StreamManager component that sets up stream signalling and management
 * @param {string} signalingElementSelector - Selector for the signaling element
 * @param {string} streamKey - Key for storing streams in DOM Store
 */
export function StreamManager({ signalingElementSelector, streamKey }) {
    const [clientStreams, setClientStreams] = useDOMState('client-streams-' + streamKey, new Map());
    const [clientNames, setClientNames] = useDOMState('client-names-' + streamKey, new Map());
    const { triggerEvent, subscribeEvent } = useGlobalEvents();

    const addOwnStream = useCallback((clientId, stream) => {
        console.log('StreamManager: acceptNewStream called for client', clientId, stream);

        const streamId = generateStreamId(clientId, streamKey);
        addStreamObjectToWindowMap(clientId, stream, streamKey);

        setClientStreams((clientStreams) => {
            const newMap = new Map(clientStreams);
            newMap.set(clientId, streamId);
            return newMap;
        });
        setClientNames((clientNames) => {
            const newMap = new Map(clientNames);
            newMap.set(clientId, webstrate.user?.displayName || 'Anonymous');
            return newMap;
        });
        triggerEvent('stream-added-' + streamKey, { clientId, stream });
    }, [streamKey, setClientStreams, setClientNames, triggerEvent]);

    const removeExistingStream = useCallback((clientId) => {
        console.log('StreamManager: removeExistingStream called for client', clientId);

        removeStreamObjectToWindowMap(clientId, streamKey);

        setClientStreams((clientStreams) => {
            const newMap = new Map(clientStreams);
            newMap.delete(clientId);
            return newMap;
        });
        setClientNames((clientNames) => {
            const newMap = new Map(clientNames);
            newMap.delete(clientId);
            return newMap;
        });
        triggerEvent('stream-removed-' + streamKey, { clientId });
    }, [streamKey, setClientStreams, setClientNames, triggerEvent]);

    useEffect(() => {
        const unsubscribeAdded = subscribeEvent('local-stream-added-' + streamKey, (event) => {
            console.log('StreamManager: local-stream-added event received:', event);
            addOwnStream(event.clientId, event.stream);
        });
        const unsubscribeRemoved = subscribeEvent('local-stream-removed-' + streamKey, (event) => {
            console.log('StreamManager: local-stream-removed event received:', event);
            removeExistingStream(event.clientId);
        });
        return () => {
            unsubscribeAdded();
            unsubscribeRemoved();
        };
    }, [subscribeEvent, streamKey, addOwnStream, removeExistingStream]);

    useEffect(() => {
        let newElement = document.querySelector(signalingElementSelector);
        if (!newElement) {
            const tagName = signalingElementSelector.replace(/^[#.]/, '').split(/[.#\s]/)[0] || 'div';
            newElement = document.createElement(tagName);
            if (signalingElementSelector.startsWith('#')) {
                newElement.id = signalingElementSelector.slice(1).split(/[.\s]/)[0];
            }
            document.body.appendChild(newElement);
            WPMv2.stripProtection(newElement);
        }

        if (!newElement.parentElement) {
            console.warn('StreamManager: StreamShare element must be in DOM', newElement);
            return;
        }

        if (!newElement.webstrate || !newElement.webstrate.signalStream) {
            console.warn('StreamManager: The webstrate implementation or element does not support webstrate stream signalling, stream sharing is disabled', newElement);
            return;
        }

        const signalStreamHandler = (clientId, meta, accept) => {
            accept((stream) => {
                console.log('StreamManager: Received new stream from client', clientId, stream);
                addStreamObjectToWindowMap(clientId, stream, streamKey);
                triggerEvent('stream-added-' + streamKey, { clientId, stream });
            });
        };

        newElement.webstrate.on('signalStream', signalStreamHandler);

        return () => {
            newElement.webstrate.off('signalStream', signalStreamHandler);
        };
    }, [signalingElementSelector, addOwnStream, streamKey, triggerEvent]);

    useEffect(() => {
        const cleanup = () => {
            // Remove streams when a client leaves or joins
            const activeStreams = new Map();
            for (const [clientId, streamId] of clientStreams.entries()) {
                if (webstrate.clients.includes(clientId)) {
                    activeStreams.set(clientId, streamId);
                }
            }
            if (activeStreams.size !== clientStreams.size) {
                setClientStreams(activeStreams);
            }

            const activeNames = new Map();
            for (const [clientId, name] of clientNames.entries()) {
                if (webstrate.clients.includes(clientId)) {
                    activeNames.set(clientId, name);
                }
            }
            if (activeNames.size !== clientNames.size) {
                setClientNames(activeNames);
            }
        };

        webstrate.on('clientPart', cleanup);
        webstrate.on('clientJoin', cleanup);
        const intervalId = setInterval(cleanup, 30000);
        cleanup();

        return () => {
            webstrate.off('clientPart', cleanup);
            webstrate.off('clientJoin', cleanup);
            clearInterval(intervalId);
        };
    }, [clientStreams, setClientStreams, clientNames, setClientNames]);

    return <div className={'stream-manager-' + streamKey} style={{ display: 'none' }}></div>;
};


/**
 * Custom hook for sharing and stopping media streams (display or user media)
 * @param {string} signalingElementSelector - Selector for the signaling element
 * @param {string} streamKey - Key for storing streams in DOM Store
 * @param {string} media - Type of media to share ('displayMedia' or 'userMedia')
 * @param {Object} displayOptions - Options for media display
 * @returns {Object} - Object with shareStream and stopSharing functions, plus currentStream state
 */
export function useStreamSharing(signalingElementSelector, streamKey, media, displayOptions = null) {
    const [element, setElement] = useState(null);
    const [currentStream, setCurrentStream] = useState(null);
    const [currentSignallingFunction, setCurrentSignallingFunction] = useState(null);
    const [supported, setSupported] = useState(true);
    const { triggerEvent } = useGlobalEvents();

    useEffect(() => {
        let newElement = document.querySelector(signalingElementSelector);
        if (!newElement) {
            newElement = document.createElement(signalingElementSelector);
            document.body.appendChild(newElement);
            WPMv2.stripProtection(newElement);
        }

        if (!newElement.parentElement) {
            console.error('useStreamSharing: StreamShare element must be in DOM');
            setSupported(false);
            return;
        }

        if (!newElement.webstrate || !newElement.webstrate.signalStream) {
            console.log('useStreamSharing: The webstrate implementation or element does not support webstrate stream signalling, stream sharing is disabled', newElement);
            setSupported(false);
            return;
        }

        setElement(newElement);
    }, [signalingElementSelector]);

    const startStreamSharing = async () => {
        console.log('useStreamSharing: startStreamSharing called', media, displayOptions);
        if (!supported) {
            console.log('useStreamSharing: Tried to share a stream on an unsupported StreamManager, see previous warnings');
            return;
        }

        if (!displayOptions) {
            console.error('useStreamSharing: displayOptions are required to share a stream.');
            return;
        }

        // Stop existing stream if any
        if (currentStream) {
            stopStreamSharing();
        }

        try {
            // Get the stream
            let newStream;
            if (media === 'displayMedia') {
                newStream = await navigator.mediaDevices.getDisplayMedia(displayOptions);
            } else {
                newStream = await navigator.mediaDevices.getUserMedia(displayOptions);
            }

            // Create signalling function
            // Track which clients have already received the stream to prevent duplicate signaling
            const signaledClients = new Set();
            const signalFunction = function signalStream(clientId, accept) {
                // Prevent signaling to self or re-signaling to same client
                if (clientId === webstrate.clientId || signaledClients.has(clientId)) {
                    return;
                }
                signaledClients.add(clientId);

                let con = accept(newStream, {}, () => {
                    console.log('useStreamSharing:  client ' + clientId + ' started receiving our stream');
                });
                con.onclose(() => {
                    console.log('useStreamSharing:  client ' + clientId + ' stopped receiving our stream');
                    signaledClients.delete(clientId);
                });
            };

            // Register the stream on the element
            console.log('useStreamSharing:  Starting stream');
            element.webstrate.signalStream(signalFunction);

            setCurrentStream(newStream);
            setCurrentSignallingFunction(() => signalFunction);
            triggerEvent('local-stream-added-' + streamKey, { clientId: webstrate.clientId, stream: newStream });

            return newStream;
        } catch (error) {
            console.error('Error sharing stream:', error);
            return null;
        }
    };

    const stopStreamSharing = () => {
        if (currentSignallingFunction && element) {
            element.webstrate.stopStreamSignal(currentSignallingFunction);
            setCurrentSignallingFunction(null);
        }
        if (currentStream) {
            currentStream.getTracks().forEach(track => track.stop());
            setCurrentStream(null);
        }
        triggerEvent('local-stream-removed-' + streamKey, { clientId: webstrate.clientId });
    };

    return [startStreamSharing, stopStreamSharing];
}

export function createStreamModule({ streamKey, signalingElementSelector, mediaAcquisitionMethod, constraints }) {
    const Main = () => (
        <StreamManager signalingElementSelector={signalingElementSelector} streamKey={streamKey} />
    );

    const useClientStreams = () => {
        const [clientStreams] = useDOMState('client-streams-' + streamKey);
        return clientStreams;
    };

    const useClientNames = () => {
        const [clientNames] = useDOMState('client-names-' + streamKey);
        return clientNames;
    };

    const useConfiguredStreamSharing = () => (
        useStreamSharing(signalingElementSelector, streamKey, mediaAcquisitionMethod, constraints)
    );

    return {
        Main,
        streamKey,
        useClientStreams,
        useClientNames,
        useStreamSharing: useConfiguredStreamSharing
    };
}
