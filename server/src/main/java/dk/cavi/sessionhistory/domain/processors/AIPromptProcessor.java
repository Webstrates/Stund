/**
 * AI Prompt Processor
 * Processes events with an AI driven by a configurable prompt: events are
 * chunked by count, interval or inactivity, and the AI creates and maintains
 * its output events through tool calls, for example meeting topic segmentation.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain.processors;

import com.fasterxml.jackson.annotation.JsonClassDescription;
import com.fasterxml.jackson.annotation.JsonPropertyDescription;
import com.google.gson.Gson;
import com.openai.models.chat.completions.ChatCompletion;
import com.openai.models.chat.completions.ChatCompletionCreateParams;
import com.openai.models.responses.FunctionTool;
import com.openai.models.responses.Response;
import com.openai.models.responses.ResponseCreateParams;
import com.openai.models.responses.ResponseFunctionToolCall;
import dk.cavi.sessionhistory.domain.SessionStorage;
import dk.cavi.sessionhistory.domain.model.TimedEvent;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;
import java.util.logging.Logger;

/**
 *
 * @author jbk
 */
@JsonClassDescription("Processes events using AI based on a prompt")
public class AIPromptProcessor extends AbstractToolCallingAIProcessor {
    private static final Logger LOGGER = Logger.getLogger(AIPromptProcessor.class.getName());
    private transient Map<String, EventChunker> chunkers = new HashMap<>();

    @Override
    public void init(SessionStorage session, String name, ProcessorConfig config) {
        super.init(session, name, config);
    }

    private EventChunker getChunker(String streamSpecifier){
        String chunkerId = streamSpecifier;
        if (getConfig().combineStreams){
            chunkerId = "combined";
        }

        EventChunker chunker = null;
        synchronized (chunkers) {
            chunker = chunkers.get(chunkerId);
            if (chunker==null) {
                chunker = new EventChunker();
                chunkers.put(chunkerId, chunker);
            }
        }
        return chunker;
    }

    @Override
    public void onEventAdded(TimedEvent event){
        getChunker(event.type).enqueueEvent(event);
    };

    @Override
    public void onEventUpdated(TimedEvent event){
        getChunker(event.type).enqueueEvent(event);
    };

    @Override
    public void onSessionTimeUpdated(long timestamp) {
        super.onSessionTimeUpdated(timestamp);

        synchronized (chunkers) {
            chunkers.forEach((t, u) -> {
                u.checkTimeTriggers();
            });
        }
    }

    @Override
    public void destroy() {
        openAI.shutdownNow();
    }

    public PromptConfig getConfig(){
        return (PromptConfig) config;
    }

    private class EventChunker {
        LinkedList<TimedEvent> previousEvents = new LinkedList<>();
        LinkedList<TimedEvent> unprocessedEvents = new LinkedList<>();
        LinkedList<TimedEvent> previousOutput = new LinkedList<>();
        HashMap<String,TimedEvent> openDurationEvents = new HashMap<>();

        private Long lastTriggerTimestamp;
        private Long lastEnqueuedEventTimestamp;

        public void enqueueEvent(TimedEvent event){
            synchronized (this) {
                lastEnqueuedEventTimestamp = currentProcessingTimestamp;
                if (lastTriggerTimestamp==null) lastTriggerTimestamp = currentProcessingTimestamp; // For initial start of interval triggers
                if (!unprocessedEvents.contains(event)){
                    unprocessedEvents.add(event);

                    if (getConfig().eventChunkSize==null && getConfig().inactivitySeconds==null && getConfig().intervalSeconds==null){ // Trigger every event if all trigger defs as null
                        // FIXME: Validate direct event trigger just triggered
                        trigger();
                    } else if (getConfig().eventChunkSize!=null && unprocessedEvents.size()>=getConfig().eventChunkSize){ // or if event events are received
                        // FIXME: Validate chunksize trigger just triggered
                        trigger();
                    }
                }

            }
        }

        public void checkTimeTriggers(){
            if (getConfig().intervalSeconds!=null && lastTriggerTimestamp!=null && currentProcessingTimestamp-lastTriggerTimestamp > getConfig().intervalSeconds*1000){
                trigger();
            } else if (getConfig().inactivitySeconds!=null && lastEnqueuedEventTimestamp!=null && currentProcessingTimestamp-lastEnqueuedEventTimestamp > getConfig().inactivitySeconds*1000){
                // FIXME: Validate inactivity trigger just triggered
                trigger();
            }
        }

        public void trigger(){
            synchronized (this){
                if (!unprocessedEvents.isEmpty()){
                    lastTriggerTimestamp = currentProcessingTimestamp; // Just start a new interval

                    // Submit and clear for next trigger
                    List<TimedEvent> current = new ArrayList<>(unprocessedEvents);
                    synchronized (previousEvents){
                        while (previousEvents.size()>getConfig().additionalInputContext){
                            previousEvents.removeFirst();
                        }
                    }
                    List<TimedEvent> previous = new ArrayList<>(previousEvents);
                    synchronized (previousOutput){
                        while (previousOutput.size()>getConfig().additionalOutputContext){
                            previousOutput.removeFirst();
                        }
                    }
                    openAI.submit(new PromptTask(current, previous, previousOutput, openDurationEvents));
                    previousEvents.addAll(unprocessedEvents);
                    unprocessedEvents.clear();
                }

                // Reset timers
                lastEnqueuedEventTimestamp = null;
                lastTriggerTimestamp = currentProcessingTimestamp;
            }
        }
    }

    private class PromptTask implements Runnable {
        private final List<TimedEvent> current;
        private final List<TimedEvent> previous;
        private final List<TimedEvent> previousOutput;
        private final HashMap<String,TimedEvent> openDurationEvents;

        public PromptTask(List<TimedEvent> current, List<TimedEvent> previous, List<TimedEvent> previousOutput, HashMap<String,TimedEvent> openDurationEvents) {
            this.current = current;
            this.previous = previous;
            this.previousOutput = previousOutput;
            this.openDurationEvents = openDurationEvents;
        }

        @Override
        public void run() {
            try {
                // The LLMs have a tendency to generate events backwards in time
                long eventStartLimitCalc = Long.MAX_VALUE;
                for (TimedEvent t : current){
                    if (t.start<eventStartLimitCalc) eventStartLimitCalc = t.start;
                }
                final long eventStartLimit = eventStartLimitCalc;

                // System prompt contains: generic instructions, previous, current, previousOutput, openDurationEvents, outputSpecs, tools
                StringBuilder promptBuilder = new StringBuilder();
                Gson gson = new Gson();
                promptBuilder.append("You are a plugin in an event-processing system where you receive input events from a timeline and use tool calls to create and maintain new output events based on them. You may call multiple tools at once.\n");
                promptBuilder.append("Events come in two flavours: Instantaneous and Duration. Instant events carry a start timestamp and cannot be updated. Duration events usually carry both start and end and can be extended when new information arrives - until tentative is no longer true and the event is considered closed.\n");
                promptBuilder.append("Sometimes it is possible to attribute events to specific entities, typically persons. If the input carries entity information and your output can be attributed to a single entity try to carry it over when creating the output event. Do not output entity information if it is unclear what entity generated the input or if multiple entities were involved.\n");
                if (previous.size()>0) promptBuilder.append("Tail of previous input events for context (Do *not* create new events based on these, solely for context - you already processed them previously): ").append(gson.toJson(previous)).append("\n");
                if (previousOutput.size()>0) addPreviousOutputToPrompt(promptBuilder, previousOutput);
                if (openDurationEvents.size()>0) addOpenDurationEventsToPrompt(promptBuilder, openDurationEvents);
                addNonInternalEventsToPrompt(promptBuilder);
                addCurrentEventsToPrompt(promptBuilder, current);
                addUserPromptPurposeToPrompt(promptBuilder);

                if (!getConfig().useResponses){
                    ChatCompletionCreateParams params = prepareChatCompletionsBuilder(promptBuilder.toString(), openDurationEvents).build();
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
                                        previousOutput.add(createInstantEvent(arguments));
                                        break;
                                    case "createDurationEvent":
                                        previousOutput.add(createDurationEvent(arguments, openDurationEvents));
                                        break;
                                    case "updateDurationEvent":
                                        updateDurationEvent(arguments, openDurationEvents);
                                        break;
                                    case "closeDurationEvent":
                                        closeDurationEvent(arguments, openDurationEvents);
                                        break;
                                }
                            });
                        });

                        // Check for standard text response
                        message.content().ifPresent(text -> {
                            log(text,currentProcessingTimestamp);
                        });
                    });
                } else {
                    throw new IllegalArgumentException("Responses API not supported yet");
                }
                /* else {
                    ResponseCreateParams.Builder builder = ResponseCreateParams.builder()
                        .instructions(promptBuilder.toString())
                        .input(getConfig().prompt)
                        .parallelToolCalls(true)
                        .model(getConfig().model);
                    if (getConfig().allowDurationEvents){
                        builder.addTool(createDurationEventTool);
                        if (!openDurationEvents.isEmpty()) {
                            builder.addTool(updateDurationEventTool);
                            builder.addTool(closeDurationEventTool);
                        }
                    }
                    if (getConfig().allowInstantEvents){
                        FunctionTool.builder().de
                        builder.addTool(createInstantEventTool);
                    }

                    ResponseCreateParams params = builder.build();
                    Response response = client.responses().create(params);

                    if (!response.isValid()) throw new IllegalStateException("Invalid prompt response: "+response.toString());
                }

                response.output().forEach(item -> {
                    if (item.isFunctionCall()) {
                        ResponseFunctionToolCall functionCall = item.asFunctionCall();

                        switch (functionCall.name()){
                            case "updateDurationEvent":
                                // Lookup event
                                TimedEvent eventData = gson.fromJson(functionCall.arguments(), TimedEvent.class);
                                TimedEvent originalEvent = openDurationEvents.get(eventData.id);
                                if (originalEvent==null) throw new IllegalArgumentException("Invalid event ID for duration event update: "+eventData.id);
                                originalEvent.end = eventData.end;
                                originalEvent.entity = eventData.entity;
                                originalEvent.data = eventData.data;

                                // TODO: Validate output from updateDurationEvent

                                session.onEventUpdated(originalEvent);
                                break;

                            default:
                                throw new IllegalArgumentException("Unknown function "+functionCall.name());
                        }
                    }
                });       */

                LOGGER.fine("Prompt successful.");
            } catch (Throwable ex){
                exception(ex, currentProcessingTimestamp);
            }
        }

    }

    public static class PromptConfig extends AbstractToolCallingAIProcessor.ToolCallingConfig {
        @JsonPropertyDescription("Event stream the AI's built-in text notes are emitted on (defaults to 'processor.prompt')")
        public String outputStreamType = "processor.prompt";

        // Context
        @JsonPropertyDescription("Whether to process streams individually or combine events")
        public boolean combineStreams = true;

        @JsonPropertyDescription("Whether or not to include tentative duration events in input or wait until they complete")
        public boolean includeTentative = false;

        @JsonPropertyDescription("Include up to this many events from previous input in context")
        public int additionalInputContext = 0;

        @JsonPropertyDescription("Include this much of own output in context")
        public int additionalOutputContext = 0;

        // Triggers
        @JsonPropertyDescription("Triggers every time this many seconds has passed (skips if no events received in the interval)")
        public Integer intervalSeconds;

        @JsonPropertyDescription("Triggers this many seconds after the last received event")
        public Integer inactivitySeconds;

        @JsonPropertyDescription("Bundles up this many events before triggering")
        public Integer eventChunkSize;


        // TODO: A tentative trigger that runs faster but retriggers with the same context when the real triggers match (i.e. evenChunkSize:100, tentativeSeconds: 30 keeps triggering tentatively until 100 events are there)

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
