import React from 'react';
const { useEffect, useState } = React;

import {
    useAudioStreamSharing,
    useAudioClientStreams,
    useAudioClientNames,
    MUTE_ALL_OTHERS_CHANGED_EVENT,
    MUTE_ALL_OTHERS_REQUEST_EVENT
} from '#AudioStreamManager .default';
import { useVideoStreamSharing, useVideoClientStreams, useVideoClientNames } from '#VideoStreamManager .default';
import { useScreenStreamSharing, useScreenClientStreams, useScreenClientNames } from '#ScreenStreamManager .default';
import { useGlobalEvents } from '#CoreHelpers .global-events';



function ClientAvatar({ clientId, name, type, deactivated = false }) {
    return <div className={`stream-center-client ${type} ${deactivated ? 'deactivated' : ''}`} title={`${name} (${clientId})`}>
        <div className="icon material-icons">{type === 'audio' ? 'mic' : type === 'video' ? 'videocam' : 'screen_share'}</div>
    </div>;
}

export function Main() {
    const { triggerEvent, subscribeEvent } = useGlobalEvents();
    const [startAudioStreamSharing, stopAudioStreamSharing] = useAudioStreamSharing();
    const [startVideoStreamSharing, stopVideoStreamSharing] = useVideoStreamSharing();
    const [, stopScreenStreamSharing] = useScreenStreamSharing();
    const [muteAllOtherClients, setMuteAllOtherClients] = useState(false);

    const audioClientStreams = useAudioClientStreams();
    const videoClientStreams = useVideoClientStreams();
    const screenClientStreams = useScreenClientStreams();

    const audioClientNames = useAudioClientNames();
    const videoClientNames = useVideoClientNames();
    const screenClientNames = useScreenClientNames();
    const audioClientIds = audioClientStreams ? Array.from(audioClientStreams.keys()) : [];
    const hasOtherAudioClients = audioClientIds.some((clientId) => clientId !== webstrate.clientId);
    const audioClientListClassName = muteAllOtherClients && hasOtherAudioClients
        ? 'stream-center-client-list stream-center-client-list-deactivated'
        : 'stream-center-client-list';

    useEffect(() => {
        const unsubscribe = subscribeEvent(MUTE_ALL_OTHERS_REQUEST_EVENT, () => {
            triggerEvent(MUTE_ALL_OTHERS_CHANGED_EVENT, { muted: muteAllOtherClients });
        });
        return () => unsubscribe();
    }, [subscribeEvent, triggerEvent, muteAllOtherClients]);

    const toggleMuteAllOtherClients = () => {
        setMuteAllOtherClients((previousMutedState) => {
            const nextMutedState = !previousMutedState;
            triggerEvent(MUTE_ALL_OTHERS_CHANGED_EVENT, { muted: nextMutedState });
            return nextMutedState;
        });
    };

    return <>
        {audioClientStreams.has(webstrate.clientId) ?
            <div className="button red" onClick={() => stopAudioStreamSharing()} title="Stop Sharing My Audio">
                <div className="icon material-icons">mic_off</div>
            </div>
            :
            <div className="button" onClick={() => startAudioStreamSharing()} title="Share My Audio">
                <div className="icon material-icons">mic</div>
            </div>
        }
        <div className={audioClientListClassName}>
            {hasOtherAudioClients ?
                <div
                    className={`stream-center-client stream-center-mute-toggle ${muteAllOtherClients ? 'muted' : ''}`}
                    onClick={toggleMuteAllOtherClients}
                    title={muteAllOtherClients ? 'Unmute All Other Clients' : 'Mute All Other Clients'}
                >
                    <div className="icon material-icons">{muteAllOtherClients ? 'volume_off' : 'volume_up'}</div>
                </div>
                : null
            }
            {audioClientIds.map((clientId) =>
                <ClientAvatar
                    key={clientId}
                    clientId={clientId}
                    name={audioClientNames.get(clientId) || 'Anonymous'}
                    type="audio"
                    deactivated={muteAllOtherClients && clientId !== webstrate.clientId}
                />
            )}
        </div>

        {videoClientStreams.has(webstrate.clientId) ?
            <div className="button red" onClick={() => stopVideoStreamSharing()} title="Stop Sharing My Video">
                <div className="icon material-icons">videocam_off</div>
            </div>
            :
            <div className="button" onClick={() => startVideoStreamSharing()} title="Share My Video">
                <div className="icon material-icons">videocam</div>
            </div>
        }
        <div className="stream-center-client-list">
            {Array.from(videoClientStreams.keys()).map((clientId) =>
                <ClientAvatar key={clientId} clientId={clientId} name={videoClientNames.get(clientId) || 'Anonymous'} type="video" />
            )}
        </div>

        <div className={`button red ${screenClientStreams.has(webstrate.clientId) ? '' : 'disabled'}`} onClick={() => stopScreenStreamSharing()} title="Stop Sharing My Screen">
            <div className="icon material-icons">{screenClientStreams.has(webstrate.clientId) ? 'stop_screen_share' : 'screen_share'}</div>
        </div>
        <div className="stream-center-client-list">
            {screenClientStreams ? Array.from(screenClientStreams.keys()).map((clientId) =>
                <ClientAvatar key={clientId} clientId={clientId} name={screenClientNames.get(clientId) || 'Anonymous'} type="screen" />
            ) : null}
        </div>
    </>;
}
