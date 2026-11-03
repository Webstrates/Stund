/**
 * AI Transcription Processor
 * Transcribes finished speech segments through an OpenAI-compatible
 * transcription API, filtering out hallucinations, and emits timed text events.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain.processors;

import com.fasterxml.jackson.annotation.JsonClassDescription;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonPropertyDescription;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.openai.client.OpenAIClient;
import com.openai.core.MultipartField;
import com.openai.core.RequestOptions;
import com.openai.models.audio.AudioResponseFormat;
import com.openai.models.audio.transcriptions.TranscriptionCreateParams;
import com.openai.models.audio.transcriptions.TranscriptionCreateParams.Builder;
import com.openai.models.audio.transcriptions.TranscriptionCreateParams.TimestampGranularity;
import com.openai.models.audio.transcriptions.TranscriptionCreateResponse;
import dk.cavi.sessionhistory.core.Core;
import dk.cavi.sessionhistory.domain.SessionStorage;
import dk.cavi.sessionhistory.domain.model.TimedEvent;
import dk.cavi.sessionhistory.domain.tracks.AbstractMediaTrack;
import dk.cavi.sessionhistory.domain.tracks.AbstractTrack;
import java.io.File;
import java.io.FileInputStream;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 *
 * @author jbk
 */
@JsonClassDescription("Uses AI to transcribe voice streams into text")
public class AITranscriptionProcessor extends AbstractAIProcessor {
    private static final Logger LOGGER = Logger.getLogger(AITranscriptionProcessor.class.getName());
    private transient boolean warnedMissingOutput = false;

    @Override
    public void init(SessionStorage session, String name, ProcessorConfig config) {
        super.init(session, name, config);
    }

    @Override
    public void destroy() {
        openAI.shutdownNow();
    }

    public void onTrackAdded(AbstractTrack inputTrack) {
        if (!(inputTrack instanceof AbstractMediaTrack)) return; // We only understand media tracks
        if (!matchesStreamType(inputTrack.event().type)) return; // matching filter

        // Figure out if we already transcribe this
        // FIXME: Check if we already transcribed this segment (track session-relative path)

        // Wait for the end of the segment - then set up a new processing thread
        inputTrack.registerTrackCompletedListener((track)->{
            // Fail fast: never pay for a transcription whose result could not
            // be emitted (defense-in-depth - the built-in output registered at
            // init makes this unreachable for a correctly constructed config)
            if (getConfig().outputs.isEmpty()){
                if (!warnedMissingOutput){
                    LOGGER.log(Level.SEVERE, "Transcription processor '"+name+"' has no output stream configured - skipping transcription of "+track.getSessionRelativePath());
                    warnedMissingOutput = true;
                }
                return;
            }
            openAI.submit(new TranscriptionTask(track));
        });
    }

    public TranscriptionConfig getConfig(){
        return (TranscriptionConfig) config;
    }

    private class TranscriptionTask implements Runnable {
        private final AbstractTrack input;

        public TranscriptionTask(AbstractTrack input) {
            this.input = input;
        }

        @Override
        public void run() {
            long maxAudibleSegment = 0;
            try {
                JsonElement jsonData = input.event().data;
                if (jsonData!=null){
                    JsonObject vadData = jsonData.getAsJsonObject();
                    if (vadData.get("speechFraction")!=null && vadData.get("speechFraction").getAsFloat()<getConfig().speechFractionThreshold) return;
                    if (vadData.get("maxSegment")!=null){
                        maxAudibleSegment = vadData.get("maxSegment").getAsLong();
                    }
                }
            } catch (Throwable ex){
                LOGGER.log(Level.WARNING, "Failed to parse the VAD data of the input event for "+input.getSessionRelativePath(), ex);
            }

            try {
                OpenAIClient client = getClient();

                // STUB: OpenAITranscription assumes track resource is directly compatible with OpenAI service
                File inputFile = session.resolveRelativePathToFile(input.getSessionRelativePath());
                if (!inputFile.exists()) throw new IllegalStateException("Track resource file not resolved "+input.getSessionRelativePath());
                LOGGER.fine("Transcribing "+inputFile.toPath().toAbsolutePath());

                FileInputStream inStream = new FileInputStream(inputFile);

                MultipartField in = MultipartField.builder().filename("test.wav").value(inStream).contentType("audio/wav").build();

                Builder params = TranscriptionCreateParams.builder()
                    .file(in)
                    .model(getConfig().model)
                    .responseFormat(AudioResponseFormat.VERBOSE_JSON)
                    .timestampGranularities(List.of(TimestampGranularity.SEGMENT));
                if (getConfig().speakers !=null && !getConfig().speakers.isEmpty()){
                    params = params.knownSpeakerNames(getConfig().speakers);
                }
                if (getConfig().language !=null && !getConfig().language.isEmpty()){
                    params = params.language(getConfig().language);
                }
                if (getConfig().prompt!=null && !getConfig().prompt.isEmpty()) params = params.prompt(getConfig().prompt);

                TranscriptionCreateResponse response = client.audio().transcriptions().create(params.build(), RequestOptions.builder().timeout(Duration.ofSeconds(getConfig().timeout)).build());
                if (!response.isValid()) throw new IllegalStateException("Invalid transcription");

                if (!response.isVerbose()) {
                    return;
                }
                final long sizeLimit = maxAudibleSegment + getConfig().maxSegmentOverflow;
                response.asVerbose().segments().get().forEach(segment -> {
                    if (segment.text().length()>0 && segment.noSpeechProb()<getConfig().noSpeechThreshold && segment.avgLogprob() > getConfig().logProbsThreshold && segment.noSpeechProb()-segment.avgLogprob() < getConfig().combinedThreshold){

                        TimedEvent event = new TimedEvent(getDefaultOutputStreamType(), session.createEventId());
                        event.entity = input.event().entity;
                        event.sourceEvents = List.of(input.event().id);

                        JsonObject extraData = new JsonObject();
                        extraData.addProperty("text", segment.text().trim());
                        extraData.addProperty("noSpeechProb", segment.noSpeechProb());
                        extraData.addProperty("avgLogprob", segment.avgLogprob());
                        event.data = extraData;
                        event.start = (long)(segment.start()*1000) + input.event().start; // STUB
                        event.end = (long)(segment.end()*1000) + input.event().start; // STUB
                        event.processor = name;

                        if (event.end-event.start > sizeLimit){
                            LOGGER.fine("Rejected a "+(event.end-event.start)+" ms transcription segment (over the limit)");
                            // This transcription is impossibly long, probably hallucination
                            return;
                        }
                        if (segment.noSpeechProb() > getConfig().noSpeechThresholdHallucination && getConfig().bagOfHallucinations.contains(segment.text().trim())){
                            LOGGER.fine("Rejected a likely-hallucinated transcription segment");
                            // This is probably a hallucination
                            return;
                        }

                        session.onEventAdded(event);
                    }
                });

                LOGGER.fine("Transcription successful");
            } catch (Throwable ex){
                LOGGER.log(Level.SEVERE, "Transcription failed", ex);
            }
        }
    }

    public static class TranscriptionConfig extends AbstractAIProcessor.OpenAIBaseConfig {
        TranscriptionConfig(){
            // Override the generic default with the speech-to-text one
            // (ai.defaultTranscriptionModel in config.json)
            model = Core.getServerConfig().ai.defaultTranscriptionModel;
        }

        @JsonPropertyDescription("Event stream the transcribed text segments are emitted on (defaults to 'processor.transcription')")
        public String outputStreamType = "processor.transcription";

        @JsonPropertyDescription("A list of speaker names")
        public List<String> speakers = new ArrayList<>();

        @JsonPropertyDescription("Language to transcribe into, if left as null autodetection will run on every utterance")
        @JsonProperty(required = false)
        public String language = "en";

        @JsonPropertyDescription("A list of hallucinations that often happen and should be treated more critically")
        public List<String> bagOfHallucinations = List.of("Thank you.", "Thank you very much.");

        @JsonPropertyDescription("At least this fraction of the input must be speech in order to consider segment for transcription")
        public float speechFractionThreshold = 0.2f; // At least this much in input VAD

        @JsonPropertyDescription("How harshly to filter hallucinations from bagOfHallucinations, lower is harsher [0;1]")
        public float noSpeechThresholdHallucination = 0.1f; // typical hallucinations are more strictly thresholded

        @JsonPropertyDescription("How harshly to filter normal speech, lower is harsher [0;1]")
        public float noSpeechThreshold = 0.95f;

        @JsonPropertyDescription("Threshold used to filter the logProbs, -0.95 works well")
        public float logProbsThreshold = -0.95f;

        @JsonPropertyDescription("Threshold used to filter the combined noSpeech/logProbs, 1.5 works well")
        public float combinedThreshold = 1.5f;

        @JsonPropertyDescription("Drop transcription hallucinations beyond this many milliseconds past the ends of the source segment")
        public long maxSegmentOverflow = 1000; // Don't allow hallucinations longer than 1s beyond end of segment

        public TranscriptionConfig(String outputStreamType) {
            this();
            this.outputStreamType = outputStreamType;
        }

        @Override
        protected void registerBuiltInOutputs() {
            builtInOutput(outputStreamType, "stund://openAITranscription.json","""
                {
                  "$schema": "http://json-schema.org/draft-07/schema#",
                  "description": "Transcription text segment",
                  "type": "object",
                  "properties": {
                    "text": {
                      "type": "string",
                      "description": "The transcribed text for the segment."
                    },
                    "noSpeechProb": {
                      "type": "number",
                      "description": "The probability that no speech was present in the segment"
                    },
                    "avgLogprob": {
                      "type": "number",
                      "description": "The average log probability of the segment's content"
                    }
                  },
                  "required": [
                    "text",
                    "noSpeechProb",
                    "avgLogprob"
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

    public class TranscriptionEvent {

    }
}
