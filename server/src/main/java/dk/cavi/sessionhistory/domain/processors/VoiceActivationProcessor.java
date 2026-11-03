/**
 * Voice Activation Processor
 * Detects speech in ingested audio using the TEN VAD detector and emits
 * speech-segment events, extracting the detected audio into derived WAV media
 * tracks.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain.processors;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.logging.Level;
import java.util.logging.Logger;

import org.freedesktop.gstreamer.Buffer;
import org.freedesktop.gstreamer.Caps;
import org.freedesktop.gstreamer.Element;
import org.freedesktop.gstreamer.ElementFactory;
import org.freedesktop.gstreamer.FlowReturn;
import org.freedesktop.gstreamer.Format;
import org.freedesktop.gstreamer.Pad;
import org.freedesktop.gstreamer.Sample;
import org.freedesktop.gstreamer.elements.AppSink;
import org.freedesktop.gstreamer.elements.AppSrc;
import org.freedesktop.gstreamer.event.EOSEvent;

import com.fasterxml.jackson.annotation.JsonClassDescription;
import com.fasterxml.jackson.annotation.JsonPropertyDescription;
import com.google.gson.JsonObject;

import dk.cavi.sessionhistory.domain.SessionStorage;
import dk.cavi.sessionhistory.domain.model.TimedEvent;
import dk.cavi.sessionhistory.domain.tracks.AbstractMediaTrack;
import dk.cavi.sessionhistory.domain.tracks.AbstractTrack;
import dk.cavi.sessionhistory.domain.tracks.ProcessedMediaTrack;
import dk.cavi.sessionhistory.interoperability.TenVAD;
import dk.cavi.sessionhistory.interoperability.TenVAD.VADResult;

/**
 *
 * @author jbk
 */
@JsonClassDescription("Detect voice in audio streams using TEN VAD detector")

public class VoiceActivationProcessor extends Processor {
    private static final Logger LOGGER = Logger.getLogger(VoiceActivationProcessor.class.getName());
    private transient int frameSize = 256;
    private transient int SAMPLE_RATE = 16000;

    @Override
    public void init(SessionStorage session, String name, ProcessorConfig config){
        super.init(session, name, config);
            
        // Create/load event track for caching our events
        /*eventTrack = new ProcessedEventTrack(session, input, streamType, "pcm", new JsonObject());
        eventTrack.saveConfig();*/
    }

    @Override
    public void onTrackAdded(AbstractTrack inputTrack){        
        if (!(inputTrack instanceof AbstractMediaTrack)) return; // We only understand media tracks
        if (!matchesStreamType(inputTrack.event().type)) return; // that match our filter

        // Set up a new processing thread
        // FIXME: Check media track for audio before enqueuing it for VAD in case user gave us something weird
        Thread vad = new Thread(new VADProcessingThread((AbstractMediaTrack)inputTrack));
        vad.start();
    }
    
    public TENVadConfig getConfig(){
        return (TENVadConfig)config;
    }

    @Override
    public void destroy() {
        // FIXME: Cancel any ongoing VAD threads
    }
    
    private class VADProcessingThread implements Runnable {
        // read
        private final AbstractMediaTrack input;
        private DefaultProcessingPipeline readPipeline;
        private long activatedFrames = 0;
        private long totalFrames = 0;
        private double logProbs = 0;
        private long sequentialInactiveFrames = 0;
        private boolean activeVoice = false;
        private long lastTentativeUpdate = 0;
        private int TENTATIVE_UPDATE_MS = 1000;

        // write
        private DefaultProcessingPipeline writePipeline;
        AppSrc writer;
        private ProcessedMediaTrack derivedTrack;
        private String streamType;

        private TimedEvent currentEvent;
        private long sourcePTS;
        
        public VADProcessingThread(AbstractMediaTrack input) {
            this.input = input;         
        }      
        
        @Override
        public void run() {
            // Setup pipeline
            LOGGER.info("Starting TEN_VAD on "+input.getSessionRelativePath());
            readPipeline = new DefaultProcessingPipeline("processor", "tenvad-read-"+input.getSessionRelativePath());           
            int deactivateFrames = (SAMPLE_RATE*getConfig().deactivateDelayMS) / frameSize / 1000;            
            
            // Connect to input while converting audio format
            AppSrc appSrc = new AppSrc("tenvad-"+input.getSessionRelativePath()+"-appsrc");
            Element decodebin = ElementFactory.make("decodebin", "tenvad-"+input.getSessionRelativePath()+"-decodebin");
            Element audioconvert = ElementFactory.make("audioconvert", "tenvad-"+input.getSessionRelativePath()+"-audioconvert");
            Element audioresample = ElementFactory.make("audioresample", "tenvad-"+input.getSessionRelativePath()+"-audioresample");
            Element caps = ElementFactory.make("capsfilter", "tenvad-"+input.getSessionRelativePath()+"-caps");
            caps.setCaps(Caps.fromString("audio/x-raw, format=S16LE, rate=16000, channels=1"));
            Element audiosplit = ElementFactory.make("audiobuffersplit", "tenvad-"+input.getSessionRelativePath()+"-audiosplit");
            audiosplit.set("output-buffer-size", frameSize*2);
            audiosplit.set("strict-buffer-size", true);

            // Receive raw audio frames and process them using TEN-VAD
            TenVAD tenVAD = new TenVAD(frameSize, getConfig().threshold);            
            
            AppSink appSink = new AppSink("tenvad-"+input.getSessionRelativePath()+"-appsink");
            appSink.set("emit-signals", true);
            appSink.set("sync", false);
            appSink.connect((AppSink.NEW_SAMPLE) s -> {
                Sample sample = s.pullSample();
                if (sample == null) {
                    return FlowReturn.OK;
                }

                // Map the GStreamer buffer and process
                Buffer buffer = sample.getBuffer();
                ByteBuffer byteBuffer = buffer.map(false); // false for read-only
                VADResult vadResult = tenVAD.process(byteBuffer, frameSize);                
                buffer.unmap();
                totalFrames++;

                // Make an activate/deactivate decision based on past and current state
                if (vadResult.isSpeech){
                    sequentialInactiveFrames = 0;
                    if (!activeVoice){
                        onBeforeVoice(buffer);
                        activeVoice = true;
                        totalFrames = 1;
                    }
                    activatedFrames++;
                    logProbs += vadResult.probability;
                } else {
                    if (activeVoice && sequentialInactiveFrames > deactivateFrames){
                        onAfterVoice(logProbs/(double)activatedFrames, activatedFrames/(double)totalFrames);
                        activatedFrames = 0;
                        logProbs = 0;
                        activeVoice = false;
                    }
                    sequentialInactiveFrames++;
                }
                

                if (activeVoice) {
                    onVoiceContent(buffer);
                }
                return FlowReturn.OK;
            });

            // Connect the EOS listener to cleanly close the file
            appSink.connect((AppSink.EOS) s -> {
                if (activeVoice) {
                    activeVoice=false;
                    onAfterVoice(0.0, 0.0);
                }
                // FIXME: TEN-VAD got EOS
            });    
            
            decodebin.connect(new Element.PAD_ADDED(){
                @Override
                public void padAdded(Element element, Pad pad) {
                    LOGGER.fine("Got pad " +element+" "+pad);
                    readPipeline.addAndLinkMany(audioconvert, audioresample, caps, audiosplit, appSink);
                    pad.link(audioconvert.getStaticPad("sink"));                    
                    readPipeline.syncMany(audioconvert, audioresample, caps, audiosplit, appSink);
                    readPipeline.play();
                }
            });
            readPipeline.addAndLinkMany(appSrc, decodebin);
            readPipeline.syncMany(appSrc, decodebin);            
            input.connectSource(appSrc);
            readPipeline.pause();
            LOGGER.info("Voice activation analysis running");
        }   
        
        private void onBeforeVoice(Buffer audioBuffer) {            
            if (writePipeline!=null) throw new IllegalStateException("onBeforeVoice called when a write pipeline was already active");

            try {
                // Create new audio stream segment + UDTA with offset for PTS calculations
                sourcePTS = audioBuffer.getPresentationTimestamp();
                derivedTrack = new ProcessedMediaTrack(session, input, session.createEventId(), getDefaultOutputStreamType(), "pcm", "wav", new JsonObject(), sourcePTS);
                derivedTrack.event().start = sourcePTS/1000000 + input.event().start;
                derivedTrack.saveConfig();

                // Create a write pipeline
                String prefix = "tenvad-write-"+derivedTrack.getSessionRelativePath();
                writePipeline = new DefaultProcessingPipeline("processor", prefix);
                writer = new AppSrc(prefix+"-appsrc");
                writer.setCaps(Caps.fromString("audio/x-raw, format=S16LE, rate="+SAMPLE_RATE+", channels=1, layout=interleaved"));
                writer.set("emit-signals", false);
                writer.set("block", true);
                writer.set("format", Format.TIME);
                writer.setStreamType(AppSrc.StreamType.STREAM);
                Element mux = ElementFactory.make("wavenc", prefix+"-mux");
                //mux.set("streamable", true);
                AppSink appSink = new AppSink(prefix+"-appsink");
                
                writePipeline.addMany(writer, mux, appSink);
                mux.link(appSink);
                //writer.getSrcPads().getFirst().link(mux.getRequestPad("audio_%u"));                
                writer.getSrcPads().get(0).link(mux.getStaticPad("sink"));                
                
                writePipeline.syncMany(writer, mux, appSink);
                derivedTrack.connectSink(appSink);
                writePipeline.play();

                // TODO: Create ongoing event
                currentEvent = derivedTrack.event();
                currentEvent.processor = name;
                currentEvent.start = calculateGlobalTimestamp(sourcePTS);
                currentEvent.tentative = true;
                session.onEventAdded(currentEvent);
                lastTentativeUpdate = System.currentTimeMillis();
            } catch (Throwable ex){
                throw new IllegalStateException("Unexpected write pipeline state in ten-vad", ex);
            }
        }
        
        private void onVoiceContent(Buffer buffer){
            if (writePipeline==null) throw new IllegalStateException("onVoiceContent called when a write pipeline was not active");
            
            // Ref the buffer, offset it and push it into storage pipeline
            long originalPTS = buffer.getPresentationTimestamp();
            long newPTS = originalPTS - sourcePTS;
            buffer.setPresentationTimestamp(newPTS);
            buffer.setDecodeTimestamp(newPTS);  // DTS can be set to the same as PTS for uncompressed PCM audio
            FlowReturn r = writer.pushBuffer(buffer.copy());   
            if (r!=FlowReturn.OK) throw new IllegalStateException("onVoiceContent pushBuffer was "+r);

            // Update ongoing event
            currentEvent.end = calculateGlobalTimestamp(originalPTS);
            if (System.currentTimeMillis() > lastTentativeUpdate + TENTATIVE_UPDATE_MS){
                session.onEventUpdated(currentEvent);
                lastTentativeUpdate = System.currentTimeMillis();
            }
        }

        private long calculateGlobalTimestamp(long pts){
            return pts/1000000 + input.event().start; // STUB
        }

        private void onAfterVoice(double avgLogProbs, double speechFraction){            
            JsonObject extraData = new JsonObject();
            extraData.addProperty("avgLogProb", avgLogProbs);
            extraData.addProperty("speechFraction", speechFraction);
            extraData.addProperty("maxSegment", currentEvent.end-currentEvent.start);

            // Save and close audio stream segment with EOS
            currentEvent.data = extraData;
            currentEvent.tentative = false;
            session.onEventUpdated(currentEvent);
            try {
                derivedTrack.saveConfig();
            } catch (IOException ex) {
                LOGGER.log(Level.WARNING, "Failed to save the derived voice track metadata for " + derivedTrack.getSessionRelativePath(), ex);
            }

            // Tear down pipeline
            writer.sendEvent(new EOSEvent());
            writePipeline = null;           
        }
    }
    
    public static class TENVadConfig extends ProcessorConfig {
        @JsonPropertyDescription("Voice activation threshold, lower detects more noise as voice [0;1]")
        public float threshold = 0.6f;
        @JsonPropertyDescription("How long to wait for additional voice activity after silence before marking the end of a segment (in milliseconds)")
        public int deactivateDelayMS = 200;
        @JsonPropertyDescription("Event stream the detected speech segments are emitted on (defaults to 'processor.voicedetect')")
        public String outputStreamType = "processor.voicedetect";

        /**
         * The Gson-default construction: running the no-arg constructor means
         * the field initializers above hold (threshold, deactivateDelayMS,
         * outputStreamType). The built-in output is registered from
         * outputStreamType by Processor.init() via registerBuiltInOutputs(),
         * after the config JSON is bound - so a spec can rename the stream,
         * and an explicit outputs map can neither remove nor forge the
         * built-in.
         */
        public TENVadConfig() {
        }

        public TENVadConfig(String outputStreamType) {
            this.outputStreamType = outputStreamType;
        }

        @Override
        protected void registerBuiltInOutputs() {
            builtInOutput(outputStreamType, "stund://tenvadEvent.json","""
                {
                  "$schema": "http://json-schema.org/draft-07/schema#",
                  "description": "Speech audio was detected",
                  "type": "object",
                  "properties": {
                    "avgLogProb": {
                      "type": "number",
                      "description": "The average log probability"
                    },
                    "speechFraction": {
                      "type": "number",
                      "description": "The fraction of speech detected",
                      "minimum": 0.0,
                      "maximum": 1.0
                    },
                    "maxSegment": {
                      "type": "number",
                      "description": "The duration of the longest segment seen in this utterance, in milliseconds"
                    }
                  },
                  "required": [
                    "avgLogProb",
                    "speechFraction",
                    "maxSegment"
                  ],
                  "additionalProperties": false
                }
            """);
        }

        @Override
        public void validateAndInit() {
            super.validateAndInit();
            validateBuiltInStreamName(outputStreamType);
        }
    }
}
