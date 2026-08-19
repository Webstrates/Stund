import { createMediaStreamShape } from '#MediaStreamShapeFactory .media-stream-shape-factory';
import { useScreenStreamSharing, useScreenClientStreams, useScreenClientNames, STREAM_KEY } from '#ScreenStreamManager .default';

export const Main = createMediaStreamShape({
    shapeType: 'ScreenStream',
    streamKey: STREAM_KEY,
    hooks: {
        useStreamSharing: useScreenStreamSharing,
        useClientStreams: useScreenClientStreams,
        useClientNames: useScreenClientNames
    },
    style: {
        objectFit: 'contain',
        mirror: false
    },
    labels: {
        streamName: 'screen stream',
        selectorTitle: 'Toggle This Screen Stream',
        shareTitle: 'Create and share a new screen stream from your display',
        share: 'Share My Screen',
        stopTitle: 'Stop sharing your screen stream and remove it from this element',
        stop: 'Stop Sharing',
        restartTitle: 'Debug: Restart the screen stream if not playing correctly',
        restart: 'Restart Stream'
    },
    icons: {
        share: 'screen_share',
        stop: 'stop_screen_share',
        restart: 'refresh',
        placeholder: 'screen_share'
    }
});
