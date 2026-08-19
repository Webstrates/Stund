import { createMediaStreamShape } from '#MediaStreamShapeFactory .media-stream-shape-factory';
import { useVideoStreamSharing, useVideoClientStreams, useVideoClientNames, STREAM_KEY } from '#VideoStreamManager .default';

export const Main = createMediaStreamShape({
    shapeType: 'VideoStream',
    streamKey: STREAM_KEY,
    hooks: {
        useStreamSharing: useVideoStreamSharing,
        useClientStreams: useVideoClientStreams,
        useClientNames: useVideoClientNames
    },
    style: {
        objectFit: 'cover',
        mirror: true
    },
    labels: {
        streamName: 'video stream',
        selectorTitle: 'Toggle This Video Stream',
        shareTitle: 'Create and share a new video stream from your webcam',
        share: 'Share My Video',
        stopTitle: 'Stop sharing your video stream and remove it from this element',
        stop: 'Stop Sharing',
        restartTitle: 'Debug: Restart the video stream if not playing correctly',
        restart: 'Restart Stream'
    },
    icons: {
        share: 'video_call',
        stop: 'videocam_off',
        restart: 'refreshbug_report',
        placeholder: 'videocam'
    }
});
