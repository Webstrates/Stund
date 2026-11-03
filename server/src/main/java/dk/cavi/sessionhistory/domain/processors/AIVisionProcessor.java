/**
 * AI Vision Processor
 * Samples frames from ingested video at a configured interval and prompts a
 * vision-capable AI to create and update output events based on what it sees.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain.processors;

import com.fasterxml.jackson.annotation.JsonClassDescription;
import com.fasterxml.jackson.annotation.JsonPropertyDescription;
import com.openai.models.chat.completions.ChatCompletion;
import com.openai.models.chat.completions.ChatCompletionContentPart;
import com.openai.models.chat.completions.ChatCompletionContentPartImage;
import com.openai.models.chat.completions.ChatCompletionCreateParams;
import com.openai.models.chat.completions.ChatCompletionUserMessageParam;
import dk.cavi.sessionhistory.domain.SessionStorage;
import dk.cavi.sessionhistory.domain.model.TimedEvent;
import dk.cavi.sessionhistory.domain.tracks.AbstractMediaTrack;
import dk.cavi.sessionhistory.domain.tracks.AbstractTrack;

import java.nio.ByteBuffer;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;
import java.util.logging.Logger;

import org.freedesktop.gstreamer.Buffer;
import org.freedesktop.gstreamer.Caps;
import org.freedesktop.gstreamer.Element;
import org.freedesktop.gstreamer.ElementFactory;
import org.freedesktop.gstreamer.FlowReturn;
import org.freedesktop.gstreamer.Pad;
import org.freedesktop.gstreamer.Sample;
import org.freedesktop.gstreamer.State;
import org.freedesktop.gstreamer.elements.AppSink;
import org.freedesktop.gstreamer.elements.AppSrc;

/**
 *
 * @author jbk
 */
@JsonClassDescription("Processes video frames using AI based on a prompt")
public class AIVisionProcessor extends AbstractToolCallingAIProcessor {
    private static final Logger LOGGER = Logger.getLogger(AIVisionProcessor.class.getName());
    private transient List<VisionTask> runningTasks = new LinkedList<>();

    @Override
    public void init(SessionStorage session, String name, ProcessorConfig config) {
        super.init(session, name, config);
    }

    @Override
    public void onTrackAdded(AbstractTrack inputTrack) {
        if (!(inputTrack instanceof AbstractMediaTrack)) return; // We only understand media tracks
        if (!matchesStreamType(inputTrack.event().type)) return;

        VisionTask visionTask = new VisionTask((AbstractMediaTrack)inputTrack);
        synchronized (runningTasks) {
            runningTasks.add(visionTask);
        }
        Thread vision = new Thread(visionTask);
        vision.start();
    }

    @Override
    public void destroy() {
        openAI.shutdownNow();
        synchronized (runningTasks) {
            runningTasks.forEach((t) -> {
                t.destroy();
            });
        }
    }

    @Override
    public VisionConfig getConfig(){
        return (VisionConfig) config;
    }

    private class VisionTask implements Runnable {
        private AbstractMediaTrack input;
        private DefaultProcessingPipeline readPipeline;
        private int snapshotFrames;
        private final List<TimedEvent> previousOutput;
        private final HashMap<String,TimedEvent> openDurationEvents;


        VisionTask(AbstractMediaTrack input){
            this.input = input;
            previousOutput = new LinkedList<>();
            openDurationEvents = new HashMap<>();
        }

        @Override
        public void run() {
            LOGGER.info("Starting video analysis of "+input.getSessionRelativePath());

            readPipeline = new DefaultProcessingPipeline("processor", "vision-read-"+input.getSessionRelativePath());

            AppSink appSink = new AppSink("vision-"+input.getSessionRelativePath()+"-appsink");
            appSink.set("emit-signals", true);
            appSink.set("sync", false);
            appSink.connect((AppSink.NEW_SAMPLE) s -> {
                long logTime = currentProcessingTimestamp;
                try {
                    Sample sample = s.pullSample();
                    if (sample == null) return FlowReturn.OK;

                    // Map the GStreamer buffer and process
                    Buffer buffer = sample.getBuffer();
                    ByteBuffer byteBuffer = buffer.map(false); // false for read-only

                    // Process the JPEG
                    long sessionTime = (buffer.getPresentationTimestamp()/1000000l) + input.event().start;
                    logTime = sessionTime;
                    triggerPrompt(byteBuffer, sessionTime);
                    buffer.unmap();
                    snapshotFrames++;
                } catch (Throwable ex){
                    exception(ex, logTime);
                }
                return FlowReturn.OK;
            });

            // Connect the EOS listener to cleanly close the file
            appSink.connect((AppSink.EOS) s -> {
                // FIXME: Vision got EOS
            });


            Element decodebin = ElementFactory.make("decodebin", "vision-"+input.getSessionRelativePath()+"-decodebin");
            Element convert = ElementFactory.make("capsfilter", "vision-"+input.getSessionRelativePath()+"-systemmem");
            convert.set("caps", Caps.fromString("video/x-raw"));
            Element capsSet = ElementFactory.make("capssetter", "vision-"+input.getSessionRelativePath()+"-capsset");

            Element rate = ElementFactory.make("videorate", "vision-"+input.getSessionRelativePath()+"-rate");
            //rate.set("skip-to-first", true);
            rate.set("drop-only",true);
            capsSet.set("caps", Caps.fromString("video/x-raw,framerate=30/1"));
            Element caps = ElementFactory.make("capsfilter", "vision-"+input.getSessionRelativePath()+"-capsfilter");
            caps.setCaps(Caps.fromString("video/x-raw, framerate=1/"+getConfig().intervalSeconds));
            Element jpeg = ElementFactory.make("jpegenc", "vision-"+input.getSessionRelativePath()+"-jpeg");

            decodebin.connect(new Element.PAD_ADDED(){
                @Override
                public void padAdded(Element element, Pad pad) {
                    LOGGER.fine("Vision pipeline received pad " + pad + " on " + element);
                    readPipeline.addAndLinkMany(convert, capsSet, rate, caps, jpeg, appSink);
                    pad.link(convert.getStaticPad("sink"));
                    readPipeline.syncMany(convert, capsSet, rate, caps, jpeg, appSink);
                    readPipeline.play();
                }
            });

            AppSrc appSrc = new AppSrc("vision-"+input.getSessionRelativePath()+"-appsrc");
            readPipeline.addAndLinkMany(appSrc, decodebin);
            readPipeline.syncMany(appSrc, decodebin);
            input.connectSource(appSrc);
            readPipeline.pause();
            LOGGER.info("Video analysis running");
        }

        public void destroy(){
            readPipeline.setState(State.NULL);
            readPipeline.close();
            LOGGER.info("Stopped video analysis for "+input.getSessionRelativePath());
        }

        private void triggerPrompt(ByteBuffer imageBytes, long sessionTime) {
            // Build a system prompt
            StringBuilder promptBuilder = new StringBuilder();
            promptBuilder.append("You are a plugin in an event-processing system where you receive input video frames and use tool calls to create and maintain new output events based on them. You may call multiple tools at once.\n");
            String entityId = input.event().entity;
            if (entityId!=null){
                promptBuilder.append("Sometimes it is possible to attribute events to specific entities, typically persons. If the input carries entity information and your output can be attributed to a single entity try to carry it over when creating the output event. Do not output entity information if it is unclear what entity generated the input or if multiple entities were involved.\n");
                promptBuilder.append("The entity id for the input is: \""+entityId+"\"\n");
            }
            promptBuilder.append("Current timestamp is: "+sessionTime+"\n");
            if (previousOutput.size()>0) addPreviousOutputToPrompt(promptBuilder, previousOutput);
            if (openDurationEvents.size()>0) addOpenDurationEventsToPrompt(promptBuilder, openDurationEvents);
            addNonInternalEventsToPrompt(promptBuilder);
            addUserPromptPurposeToPrompt(promptBuilder);

            // Create data uri
            byte[] bytes = new byte[imageBytes.remaining()];
            imageBytes.get(bytes);
            String dataURI = "data:image/jpeg;base64," + Base64.getEncoder().encodeToString(bytes);

            // Send request
            if (!getConfig().useResponses){
                ChatCompletionCreateParams.Builder builder = prepareChatCompletionsBuilder(promptBuilder.toString(), openDurationEvents);
                ChatCompletionContentPart imagePart = ChatCompletionContentPart.ofImageUrl(
                    ChatCompletionContentPartImage.builder().imageUrl(ChatCompletionContentPartImage.ImageUrl.builder()
                        .detail(ChatCompletionContentPartImage.ImageUrl.Detail.HIGH) // Optional: LOW, HIGH, or AUTO
                        .url(dataURI)
                        .build()).build()
                );
                builder.addMessage(ChatCompletionUserMessageParam.builder()
                    .contentOfArrayOfContentParts(List.of(imagePart)).build()
                );
                ChatCompletionCreateParams params = builder.build();

                ChatCompletion response = getClient().chat().completions().create(params);

                if (!response.isValid()) throw new IllegalStateException("Invalid prompt response: ");
                response.choices().forEach((t) -> {
                    var message = t.message();

                    // Check for tool calls
                    message.toolCalls().ifPresent(toolCalls -> {
                        toolCalls.forEach(toolCall -> {
                            String functionName = toolCall.function().get().function().name();
                            String arguments = toolCall.function().get().function().arguments();

                            switch (functionName){
                                case "createInstantEvent":
                                    createInstantEvent(arguments, sessionTime);
                                    break;
                                case "createDurationEvent":
                                    createDurationEvent(arguments, openDurationEvents, sessionTime - (getConfig().intervalSeconds*500), sessionTime);
                                    break;
                                case "updateDurationEvent":
                                    updateDurationEvent(arguments, openDurationEvents, sessionTime);
                                    break;
                                case "closeDurationEvent":
                                    closeDurationEvent(arguments, openDurationEvents);
                                    break;
                                case "doNothing":
                                    LOGGER.fine("Vision analysis produced no actions");
                                    break;
                            }
                        });
                    });

                    // Check for standard text response
                    message.content().ifPresent(text -> {
                        if (!text.isEmpty()) log(text,currentProcessingTimestamp);
                    });
                });
            } else {
                throw new IllegalArgumentException("Responses API not supported yet");
            }
        }
    }

    public static class VisionConfig extends AbstractToolCallingAIProcessor.ToolCallingConfig {
        // Triggers
        @JsonPropertyDescription("Snapshots a frame from the video every time this many seconds has passed (skips if frames received in the interval)")
        public Integer intervalSeconds;

        @JsonPropertyDescription("Event stream the AI's built-in visual observations are emitted on (defaults to 'processor.vision')")
        public String outputStreamType = "processor.vision";

        @Override
        protected void registerBuiltInOutputs() {
            builtInOutput(outputStreamType, "stund://aiTextEvent.json", AbstractToolCallingAIProcessor.ToolCallingConfig.AI_TEXT_EVENT_SCHEMA);
        }

        @Override
        public void validateAndInit() {
            super.validateAndInit();
            validateBuiltInStreamName(outputStreamType);
        }
    }

}
