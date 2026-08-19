import React from 'react';
const { useEffect, useRef, useMemo } = React;

import { useCookieState } from '#CoreHelpers .cookie-store';
import { useAudioClientStreams, STREAM_KEY as AUDIO_STREAM_KEY } from '#AudioStreamManager .default';
import { useVideoClientStreams, STREAM_KEY as VIDEO_STREAM_KEY } from '#VideoStreamManager .default';
import { useScreenClientStreams, STREAM_KEY as SCREEN_STREAM_KEY } from '#ScreenStreamManager .default';
import { useSessionIngest } from '#SessionHistory .default';

function useMediaRecorder({ active, ingest, hasLocalStream, streamKey, ingestType }) {
    const mediaStreamRef = useRef(null);
    const ingestStartedRef = useRef(null);

    useEffect(() => {
        if (!ingest || !active || !hasLocalStream) return;

        const runAsync = async () => {
            mediaStreamRef.current = window.clientStreams?.get(streamKey + webstrate.clientId);
            if (mediaStreamRef.current?.active) {
                await ingest.startMediaStream(ingestType, mediaStreamRef.current);
                ingestStartedRef.current = true;
            }
        };

        runAsync();

        return () => {
            if (ingestStartedRef.current) {
                ingest?.stopMediaStream(mediaStreamRef.current);
                ingestStartedRef.current = null;
            }
        };
    }, [active, hasLocalStream, ingest, ingestType, streamKey]);
}

export function Main() {
    const ingest = useSessionIngest();
    const audioClientStreams = useAudioClientStreams();
    const videoClientStreams = useVideoClientStreams();
    const screenClientStreams = useScreenClientStreams();
    const [active] = useCookieState('streamRecorderActive', true);

    const hasLocalAudioStream = useMemo(() => audioClientStreams?.has(webstrate.clientId), [audioClientStreams]);
    const hasLocalVideoStream = useMemo(() => videoClientStreams?.has(webstrate.clientId), [videoClientStreams]);
    const hasLocalScreenStream = useMemo(() => screenClientStreams?.has(webstrate.clientId), [screenClientStreams]);

    useMediaRecorder({ active, ingest, hasLocalStream: hasLocalAudioStream, streamKey: AUDIO_STREAM_KEY, ingestType: 'user.voice' });
    useMediaRecorder({ active, ingest, hasLocalStream: hasLocalVideoStream, streamKey: VIDEO_STREAM_KEY, ingestType: 'user.camera' });
    useMediaRecorder({ active, ingest, hasLocalStream: hasLocalScreenStream, streamKey: SCREEN_STREAM_KEY, ingestType: 'user.screen' });

    return <div className="stream-recorder" style={{ display: 'none' }}></div>;
}
