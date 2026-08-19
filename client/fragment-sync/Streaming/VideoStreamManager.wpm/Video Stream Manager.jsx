import { createStreamModule } from '#StreamManager .default';

const videoStreamModule = createStreamModule({
    streamKey: 'video-stream',
    signalingElementSelector: 'video-signaling',
    mediaAcquisitionMethod: 'userMedia',
    constraints: {
        video: true,
        audio: false
    }
});

export const STREAM_KEY = videoStreamModule.streamKey;
export const Main = videoStreamModule.Main;
export const useVideoClientStreams = videoStreamModule.useClientStreams;
export const useVideoClientNames = videoStreamModule.useClientNames;
export const useVideoStreamSharing = videoStreamModule.useStreamSharing;
