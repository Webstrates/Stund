import { createStreamModule } from '#StreamManager .default';

const audioStreamModule = createStreamModule({
    streamKey: 'audio-stream',
    signalingElementSelector: 'audio-signaling',
    mediaAcquisitionMethod: 'userMedia',
    constraints: {
        video: false,
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
        }
    }
});

export const STREAM_KEY = audioStreamModule.streamKey;
export const MUTE_ALL_OTHERS_CHANGED_EVENT = 'audio-stream-mute-all-others-changed';
export const MUTE_ALL_OTHERS_REQUEST_EVENT = 'audio-stream-mute-all-others-request';
export const Main = audioStreamModule.Main;
export const useAudioClientStreams = audioStreamModule.useClientStreams;
export const useAudioClientNames = audioStreamModule.useClientNames;
export const useAudioStreamSharing = audioStreamModule.useStreamSharing;
