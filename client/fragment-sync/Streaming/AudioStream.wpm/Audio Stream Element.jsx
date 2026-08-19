import React from 'react';
const { useCallback, useEffect, useRef, useState } = React;

import { useGlobalEvents } from '#CoreHelpers .global-events';
import {
    useAudioClientStreams,
    STREAM_KEY,
    MUTE_ALL_OTHERS_CHANGED_EVENT,
    MUTE_ALL_OTHERS_REQUEST_EVENT
} from '#AudioStreamManager .default';



function AudioStreamComponent({ clientId, muteAllOtherClients }) {
    const audioRef = useRef();
    const { subscribeEvent } = useGlobalEvents();

    const updateMediaStream = useCallback(async () => {
        if (!clientId || clientId === webstrate.clientId) {
            audioRef.current.srcObject = null;
            return;
        }

        console.log('AudioStreamComponent: updating audio stream for client:', clientId);
        const mediaStream = window.clientStreams?.get(STREAM_KEY + clientId);
        console.log('AudioStreamComponent: mediaStream found:', mediaStream);
        audioRef.current.srcObject = mediaStream?.active ? mediaStream : null;

        if (!audioRef.current.srcObject) return;

        audioRef.current.muted = muteAllOtherClients;

        console.log('AudioStreamComponent: playing audio stream');
        try {
            await audioRef.current.play();
            console.log('AudioStreamComponent: audio playback started successfully');
        } catch (error) {
            console.warn('AudioStreamComponent: autoplay failed, will play on user interaction:', error);
            // Add click handler to play audio if autoplay fails
            const playOnClick = async () => {
                console.log('AudioStreamComponent: user interaction detected, attempting to play audio...');
                try {
                    await audioRef.current.play();
                    document.querySelector('#app-root').removeEventListener('click', playOnClick);
                } catch (e) {
                    console.error('AudioStreamComponent: play on click failed:', e);
                }
            };
            document.querySelector('#app-root').addEventListener('click', playOnClick);
        }
    }, [clientId, muteAllOtherClients]);

    useEffect(() => {
        const unsubscribe = subscribeEvent('stream-added-' + STREAM_KEY, (event) => {
            console.log('AudioStreamComponent: stream-added event received in AudioStreamComponent:', event);
            updateMediaStream();
        });
        return () => unsubscribe();
    }, [subscribeEvent, updateMediaStream]);

    useEffect(() => {
        updateMediaStream();
    }, [updateMediaStream]);

    useEffect(() => {
        if (!audioRef.current || !audioRef.current.srcObject) return;
        audioRef.current.muted = muteAllOtherClients;
    }, [muteAllOtherClients]);

    return <audio client-id={clientId} ref={audioRef} />;
}

export function Main() {
    const audioClientStreams = useAudioClientStreams();
    const { triggerEvent, subscribeEvent } = useGlobalEvents();
    const [muteAllOtherClients, setMuteAllOtherClients] = useState(false);

    useEffect(() => {
        const unsubscribe = subscribeEvent(MUTE_ALL_OTHERS_CHANGED_EVENT, (event) => {
            setMuteAllOtherClients(Boolean(event?.muted));
        });
        return () => unsubscribe();
    }, [subscribeEvent]);

    useEffect(() => {
        triggerEvent(MUTE_ALL_OTHERS_REQUEST_EVENT);
    }, [triggerEvent]);

    return <div className="audio-stream-components" style={{ display: 'none' }}>
        {audioClientStreams ? Array.from(audioClientStreams.keys()).map((clientId) =>
            <AudioStreamComponent key={clientId} clientId={clientId} muteAllOtherClients={muteAllOtherClients} />
        ) : null}
    </div>;
}
