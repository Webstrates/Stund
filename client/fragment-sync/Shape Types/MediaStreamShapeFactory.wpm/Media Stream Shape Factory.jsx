import React from 'react';
const { useEffect, useRef, useMemo } = React;
import { T, useEditor, HTMLContainer, BaseBoxShapeUtil, stopEventPropagation } from 'tldraw';

import { useGlobalEvents } from '#CoreHelpers .global-events';



const DEFAULT_SIZE = 300;



export function createMediaStreamShape(config) {
    function MediaStreamSelector({ shape, clientId, username }) {
        const editor = useEditor();
        const selected = useMemo(() => clientId === shape.props.client, [clientId, shape.props.client]);

        const selectStream = () => {
            if (!selected) {
                editor.updateShape({
                    id: shape.id,
                    type: config.shapeType,
                    props: {
                        client: clientId,
                        username: username
                    }
                });
            } else {
                editor.updateShape({
                    id: shape.id,
                    type: config.shapeType,
                    props: {
                        client: '',
                        username: ''
                    }
                });
            }
        };

        return <button className="button" data-selected={selected} onClick={selectStream} title={config.labels.selectorTitle}>
            <span className="icon material-icons">{selected ? 'radio_button_checked' : 'radio_button_unchecked'}</span>
            <span>{username} ({clientId})</span>
        </button>;
    }

    function MediaStreamComponent({ shape, isEditing }) {
        const editor = useEditor();
        const videoRef = useRef();
        const [startStreamSharing, stopStreamSharing] = config.hooks.useStreamSharing();
        const clientStreams = config.hooks.useClientStreams();
        const clientNames = config.hooks.useClientNames();
        const { subscribeEvent } = useGlobalEvents();

        const updateMediaStream = async () => {
            if (!shape.props.client) {
                videoRef.current.srcObject = null;
                return;
            }

            const mediaStream = window.clientStreams?.get(config.streamKey + shape.props.client);
            videoRef.current.srcObject = mediaStream?.active ? mediaStream : null;

            if (!videoRef.current.srcObject) return;

            try {
                await videoRef.current.play();
                console.log('MediaStreamComponent: video playback started successfully');
            } catch (error) {
                console.warn('MediaStreamComponent: autoplay failed, will play on user interaction:', error);

                // Add click handler to play video if autoplay fails
                const playOnClick = async () => {
                    try {
                        await videoRef.current.play();
                        document.querySelector('#app-root').removeEventListener('click', playOnClick);
                    } catch (e) {
                        console.error('MediaStreamComponent: play on click failed:', e);
                    }
                };
                document.querySelector('#app-root').addEventListener('click', playOnClick);
            }
        };

        useEffect(() => {
            const unsubscribe = subscribeEvent('stream-added-' + config.streamKey, (event) => {
                if (event.clientId === shape.props.client) {
                    console.log('MediaStreamComponent: stream-added event received in MediaStreamComponent:', event);
                    updateMediaStream();
                }
            });
            return () => unsubscribe();
        }, [subscribeEvent]);

        useEffect(() => {
            updateMediaStream();
        }, [shape.props.client, editor]);

        useEffect(() => {
            if (!shape.props.client) return;
            if (!clientStreams.has(shape.props.client)) {
                // Check window.clientStreams as fallback for streams that haven't propagated to DOM state yet
                const stream = window.clientStreams?.get(config.streamKey + shape.props.client);
                if (!stream || !stream.active) {
                    editor.updateShape({
                        id: shape.id,
                        type: config.shapeType,
                        props: {
                            client: '',
                            username: ''
                        }
                    });
                }
            }
        }, [clientStreams, shape.props.client]);



        const startSharingButtonCallback = async () => {
            console.log(`MediaStreamComponent: Starting ${config.labels.streamName} sharing...`);
            await startStreamSharing();
            editor.updateShape({
                id: shape.id,
                type: config.shapeType,
                props: {
                    client: webstrate.clientId,
                    username: webstrate.user.displayName || 'Anonymous'
                }
            });
        };

        const stopSharingButtonCallback = async () => {
            console.log(`MediaStreamComponent: Stopping ${config.labels.streamName} sharing...`);
            stopStreamSharing();
        };

        const restartStreamButtonCallback = async () => {
            console.log(`MediaStreamComponent: Restarting ${config.labels.streamName} for client:`, shape.props.client);
            updateMediaStream();
        };

        return <HTMLContainer className="media-stream-shape" data-is-editing={isEditing} style={{
            width: shape.props.w + 'px',
            height: shape.props.h + 'px',
            pointerEvents: isEditing ? 'all' : 'none',
            '--media-stream-object-fit': config.style.objectFit || 'contain',
            '--media-stream-transform': config.style.mirror ? 'scaleX(-1)' : 'none'
        }}>
            {isEditing ? <div className="editing-menu"
                onPointerDown={stopEventPropagation}
                onPointerMove={stopEventPropagation}>

                {shape.props.client !== webstrate.clientId && !clientStreams.has(webstrate.clientId) ? <button className="button primary" onClick={startSharingButtonCallback} onTouchEnd={startSharingButtonCallback} title={config.labels.shareTitle}>
                    <span className="icon material-icons">{config.icons.share}</span>
                    <span>{config.labels.share}</span>
                </button> : null}

                {shape.props.client === webstrate.clientId ? <button className="button danger" onClick={stopSharingButtonCallback} onTouchEnd={stopSharingButtonCallback} title={config.labels.stopTitle}>
                    <span className="icon material-icons">{config.icons.stop}</span>
                    <span>{config.labels.stop}</span>
                </button> : null}

                <div className="options">
                    {Array.from(clientStreams.keys()).map((clientId) =>
                        <MediaStreamSelector key={clientId} shape={shape} clientId={clientId} username={`${clientNames.get(clientId)}`} />
                    )}
                </div>
                {shape.props.client ? <>
                    <button className="button" onClick={restartStreamButtonCallback} onTouchEnd={restartStreamButtonCallback} title={config.labels.restartTitle}>
                        <span className="icon material-icons">{config.icons.restart}</span>
                        <span>{config.labels.restart}</span>
                    </button>
                </> : null}
            </div> : null}

            <div className="placeholder-icon">
                <span className="material-icons">{config.icons.placeholder}</span>
            </div>
            {shape.props.username || shape.props.client ? <div className="user-text">{`${shape.props.username} (${shape.props.client})`}</div> : null}
            <video ref={videoRef} autoPlay playsInline muted />
        </HTMLContainer>;
    }

    class MediaStreamShapeUtil extends BaseBoxShapeUtil {
        static type = config.shapeType;
        static props = {
            w: T.positiveNumber,
            h: T.positiveNumber,
            client: T.string,
            username: T.string
        };

        getDefaultProps() {
            return {
                w: DEFAULT_SIZE,
                h: DEFAULT_SIZE,
                client: '',
                username: ''
            };
        }

        canBind = () => true;
        canEdit = () => true;

        canResize = () => true;
        canCrop = () => false;
        canScroll = () => false;
        hideRotateHandle = () => false;

        getIndicatorPath(shape) {
            const path = new Path2D();
            path.roundRect(0, 0, shape.props.w, shape.props.h, 8);
            return path;
        }

        component(shape) {
            const isEditing = this.editor.getEditingShapeId() === shape.id;
            return <MediaStreamComponent shape={shape} isEditing={isEditing} />;
        }
    }

    return MediaStreamShapeUtil;
}
