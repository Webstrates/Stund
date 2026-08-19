import React from 'react';
const { useState, useEffect, useRef, useCallback } = React;

import { transcribeAudioBlob, getTranscriptionSupportedMimeType } from '#AIHelpers .default';
import { useModel } from '#ModelManager .default';



export function useSpeechInput({ isDisabled, isProcessing, appendPromptText }) {
    const [speakPromptSTTModel] = useModel('speak-prompt-transcription');
    const [isRecording, setIsRecording] = useState(false);
    const [isTranscribing, setIsTranscribing] = useState(false);
    const mediaRecorderRef = useRef(null);
    const recordingStreamRef = useRef(null);
    const recordedChunksRef = useRef([]);

    const stopRecordingResources = useCallback(() => {
        if (mediaRecorderRef.current) {
            mediaRecorderRef.current.ondataavailable = null;
            mediaRecorderRef.current.onerror = null;
            mediaRecorderRef.current.onstop = null;
            mediaRecorderRef.current = null;
        }

        if (recordingStreamRef.current) {
            recordingStreamRef.current.getTracks().forEach((track) => {
                track.stop();
            });
            recordingStreamRef.current = null;
        }
    }, []);

    const handleSTTClick = useCallback(async () => {
        if (isDisabled || isProcessing || isTranscribing) return;

        if (isRecording) {
            const recorder = mediaRecorderRef.current;
            if (recorder && recorder.state === 'recording') {
                recorder.stop();
            }
            return;
        }

        if (!navigator.mediaDevices?.getUserMedia) {
            alert('Audio recording is not supported in this browser.');
            return;
        }

        if (typeof MediaRecorder === 'undefined') {
            alert('MediaRecorder is not available in this browser.');
            return;
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            recordingStreamRef.current = stream;

            const mimeType = getTranscriptionSupportedMimeType();
            const recorderOptions = mimeType ? { mimeType } : undefined;
            const recorder = new MediaRecorder(stream, recorderOptions);
            mediaRecorderRef.current = recorder;
            recordedChunksRef.current = [];

            recorder.ondataavailable = (event) => {
                if (event.data && event.data.size > 0) {
                    recordedChunksRef.current.push(event.data);
                }
            };

            recorder.onerror = (event) => {
                console.error('Audio recording error:', event);
                setIsRecording(false);
                setIsTranscribing(false);
                stopRecordingResources();
                alert('Audio recording failed.');
            };

            recorder.onstop = async () => {
                setIsRecording(false);

                try {
                    const chunkMimeType = mimeType || recordedChunksRef.current?.[0]?.type || 'audio/webm';
                    const audioBlob = new Blob(recordedChunksRef.current, { type: chunkMimeType });
                    if (audioBlob.size === 0) {
                        return;
                    }

                    setIsTranscribing(true);
                    const transcript = await transcribeAudioBlob(audioBlob, {
                        model: speakPromptSTTModel
                    });
                    const cleanedTranscript = transcript.trim();
                    if (cleanedTranscript && typeof appendPromptText === 'function') {
                        appendPromptText(cleanedTranscript);
                    }
                } catch (error) {
                    console.error('Transcription failed:', error);
                    alert(`Transcription failed: ${error.message || error}`);
                } finally {
                    setIsTranscribing(false);
                    recordedChunksRef.current = [];
                    stopRecordingResources();
                }
            };

            recorder.start();
            setIsRecording(true);
        } catch (error) {
            console.error('Could not start recording:', error);
            stopRecordingResources();
            alert(`Could not access microphone: ${error.message || error}`);
        }
    }, [isDisabled, isProcessing, isTranscribing, isRecording, speakPromptSTTModel, stopRecordingResources, appendPromptText]);

    useEffect(() => {
        return () => {
            const recorder = mediaRecorderRef.current;
            if (recorder && recorder.state === 'recording') {
                recorder.stop();
            }
            stopRecordingResources();
        };
    }, [stopRecordingResources]);

    const stop = useCallback(() => {
        const recorder = mediaRecorderRef.current;
        if (recorder && recorder.state === 'recording') {
            recorder.stop();
            return;
        }
        stopRecordingResources();
    }, [stopRecordingResources]);

    return {
        isRecording,
        isTranscribing,
        toggle: handleSTTClick,
        stop
    };
}
