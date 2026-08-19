import { createStreamModule } from '#StreamManager .default';

const screenStreamModule = createStreamModule({
    streamKey: 'screen-stream',
    signalingElementSelector: 'screen-signaling',
    mediaAcquisitionMethod: 'displayMedia',
    constraints: {
        video: {
            displaySurface: 'browser'
        },
        audio: {
            suppressLocalAudioPlayback: false
        },
        preferCurrentTab: false,
        selfBrowserSurface: 'exclude',
        systemAudio: 'exclude',
        surfaceSwitching: 'include',
        monitorTypeSurfaces: 'include'
    }
});

export const STREAM_KEY = screenStreamModule.streamKey;
export const Main = screenStreamModule.Main;
export const useScreenClientStreams = screenStreamModule.useClientStreams;
export const useScreenClientNames = screenStreamModule.useClientNames;
export const useScreenStreamSharing = screenStreamModule.useStreamSharing;
