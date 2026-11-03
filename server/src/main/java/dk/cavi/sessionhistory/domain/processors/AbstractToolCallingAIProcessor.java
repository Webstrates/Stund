/**
 * Abstract Tool-Calling AI Processor
 * Base for AI processors that create events through tool calls: defines the
 * event manipulation tools, assembles the prompts, and applies validated tool
 * output to the session.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain.processors;

import com.fasterxml.jackson.annotation.JsonPropertyDescription;
import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.openai.core.JsonValue;
import com.openai.models.FunctionDefinition;
import com.openai.models.FunctionParameters;
import com.openai.models.chat.completions.ChatCompletionCreateParams;
import com.openai.models.chat.completions.ChatCompletionFunctionTool;
import dk.cavi.sessionhistory.domain.SessionStorage;
import dk.cavi.sessionhistory.domain.model.TimedEvent;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 *
 * @author jbk
 */
public abstract class AbstractToolCallingAIProcessor extends AbstractAIProcessor {
    private transient Map<String,Object> possibleOutputSchemas;
    private transient Gson promptGson;

    @Override
    public void init(SessionStorage session, String name, ProcessorConfig conf) {
        super.init(session, name, conf);

        possibleOutputSchemas = getConfig().outputs.values().stream().filter(arg0 -> !arg0.internal)
            .collect(Collectors.toMap(
                output -> output.schemaId,                          // Key: The ID string
                output -> getConfig().schemas.get(output.schemaId)  // Value: The Schema object
        ));
        promptGson = new Gson();
    }

    public ToolCallingConfig getConfig(){
        return (ToolCallingConfig) config;
    }

    public FunctionDefinition createInstantEventFunctionDefinition() {
        return FunctionDefinition.builder()
            .name("createInstantEvent")
            .description("Emits an instantaneous timeline event that cannot be extended later")
            .parameters(FunctionParameters.builder()
                    .putAdditionalProperty("type", JsonValue.from("object"))
                    .putAdditionalProperty(
                            "properties", JsonValue.from(Map.of(
                                "type", Map.of(
                                    "type", "string",
                                    "description", "One of the stream output specifiers",
                                    "enum", getConfig().outputs.entrySet().stream().filter(e->!e.getValue().internal).map((t) -> t.getKey()).toList()
                                ),
                                "start", Map.of(
                                    "type", "number",
                                    "description", "The start timestamp of the event (unix timestamp in milliseconds)"
                                ),
                                "data", Map.of(
                                    "type", "object",
                                    "description", "Event data specific to the type of event",
                                    "anyOf", JsonValue.from(possibleOutputSchemas.values())
                                ),
                                "entity", Map.of(
                                    "type", List.of("string","null"),
                                    "description", "Optional reference to the entity that caused the event"
                                )
                                ))
                    )
                    .putAdditionalProperty("required", JsonValue.from(List.of("type", "start", "data", "entity")))
                    .putAdditionalProperty("additionalProperties", JsonValue.from(false))
                    .build())
            .strict(true)
            .build();
    }

    FunctionDefinition createDurationEventFunctionDefinition(){
        return FunctionDefinition.builder()
            .name("createDurationEvent")
            .description("Emits a duration timeline event that can be extended/updated or closed later")
            .parameters(FunctionParameters.builder()
                    .putAdditionalProperty("type", JsonValue.from("object"))
                    .putAdditionalProperty(
                            "properties", JsonValue.from(Map.of(
                                "type", Map.of(
                                    "type", "string",
                                    "description", "One of the stream output specifiers",
                                    "enum", getConfig().outputs.entrySet().stream().filter(e->!e.getValue().internal).map((t) -> t.getKey()).toList()
                                ),
                                "start", Map.of(
                                    "type", "number",
                                    "description", "The start timestamp of the event (unix timestamp in milliseconds)"
                                ),
                                "end", Map.of(
                                    "type", "number",
                                    "description", "The end timestamp of the event, so far - may be extended later (unix timestamp in milliseconds)"
                                ),
                                "data", Map.of(
                                    "type", "object",
                                    "description", "Event data specific to the type of event",
                                    "anyOf", JsonValue.from(possibleOutputSchemas.values())
                                ),
                                "entity", Map.of(
                                    "type", List.of("string","null"),
                                    "description", "Optional reference to the entity that caused the event"
                                )
                                ))
                    )
                    .putAdditionalProperty("required", JsonValue.from(List.of("type", "start", "end", "data", "entity")))
                    .putAdditionalProperty("additionalProperties", JsonValue.from(false))
                    .build())
            .strict(true)
            .build();
    }

    FunctionDefinition createUpdateDurationEventFunctionDefinition(Map<String,TimedEvent> openDurationEvents){
        return FunctionDefinition.builder()
            .name("updateDurationEvent")
            .description("Modifies or extends an existing duration timeline event that was output earlier")
            .parameters(FunctionParameters.builder()
                    .putAdditionalProperty("type", JsonValue.from("object"))
                    .putAdditionalProperty(
                            "properties", JsonValue.from(Map.of(
                                "id", Map.of(
                                    "type", "string",
                                    "description", "The id of the event to update, must be one of the open duration events",
                                    "enum", openDurationEvents.keySet()
                                ),
                                "end", Map.of(
                                    "type", "number",
                                    "description", "A new end timestamp for the event, so far - may be extended later (unix timestamp in milliseconds)"
                                ),
                                "data", Map.of(
                                    "type", "object",
                                    "description", "Event data specific to the type of event. The data is merged over the current data of the event: top-level fields you include replace their existing values (nested objects are replaced as a whole - include all their fields), fields you omit keep their current values",
                                    "anyOf", JsonValue.from(possibleOutputSchemas.values())
                                ),
                                "entity", Map.of(
                                    "type", List.of("string","null"),
                                    "description", "Optional reference to the entity that caused the event, can also be used to clear the entity by setting to null"
                                )
                                ))
                    )
                    .putAdditionalProperty("required", JsonValue.from(List.of("id", "end", "data", "entity")))
                    .putAdditionalProperty("additionalProperties", JsonValue.from(false))
                    .build())
            .strict(true)
            .build();
    }

    FunctionDefinition createCloseDurationEventFunctionDefinition(Map<String,TimedEvent> openDurationEvents){
        return FunctionDefinition.builder()
            .name("closeDurationEvent")
            .description("Finalizes an existing duration timeline event - after this call it can no longer be extended or updated, be sure that the relevant data has already been written to it before this")
            .parameters(FunctionParameters.builder()
                    .putAdditionalProperty("type", JsonValue.from("object"))
                    .putAdditionalProperty(
                            "properties", JsonValue.from(Map.of(
                                "id", Map.of(
                                    "type", "string",
                                    "description", "The id of the event to close, must be one of the open duration events",
                                    "enum", openDurationEvents.keySet()
                                )
                                ))
                    )
                    .putAdditionalProperty("required", JsonValue.from(List.of("id")))
                    .putAdditionalProperty("additionalProperties", JsonValue.from(false))
                    .build())
            .strict(true)
            .build();
    }

    public FunctionDefinition createNopFunctionDefinition() {
        return FunctionDefinition.builder()
            .name("doNothing")
            .description("Does nothing - useful when the criteria for creating/managing events are not fulfilled and we just need to wait for the next prompt")
            .parameters(FunctionParameters.builder()
                    .putAdditionalProperty("type", JsonValue.from("object"))
                    .putAdditionalProperty(
                            "properties", JsonValue.from(Map.of())
                    )
                    .putAdditionalProperty("required", JsonValue.from(List.of()))
                    .putAdditionalProperty("additionalProperties", JsonValue.from(false))
                    .build())
            .strict(true)
            .build();
    }


    public void addNonInternalEventsToPrompt(StringBuilder promptBuilder){
        promptBuilder.append("You may only create these types of events, each event type has its own data schema:\n");
        getConfig().outputs.entrySet().forEach(outputEntry -> {
            String streamSpecifierId = outputEntry.getKey();
            if (outputEntry.getValue().internal) return;
            String jsonSchemaId = outputEntry.getValue().schemaId;
            promptBuilder.append("\t\"").append(streamSpecifierId).append("\" using data schema with ID \"").append(jsonSchemaId).append("\"\n");
        });

        promptBuilder.append("Data schemas:\n");
        getConfig().schemas.entrySet().forEach(entry -> {
            String schemaId = entry.getKey();
            String schemaJson = promptGson.toJson(entry.getValue());
            promptBuilder.append("\t\"").append(schemaId).append("\" : ").append(schemaJson).append("\n");
        });
    }

    public void addOpenDurationEventsToPrompt(StringBuilder promptBuilder, Map<String,TimedEvent> openDurationEvents){
        promptBuilder.append("Your currently open duration events that may be updated/extended (remember to close these when they are no longer needed): ").append(promptGson.toJson(openDurationEvents.values())).append("\n");
    }

    public void addCurrentEventsToPrompt(StringBuilder promptBuilder, Collection<TimedEvent> current){
        promptBuilder.append("Current unprocessed input events. These are the focus of this call. You must 'process them'. These are the events that you must base your output on:\n").append(promptGson.toJson(current)).append("\n");
    }

    public void addPreviousOutputToPrompt(StringBuilder promptBuilder, Collection<TimedEvent> previousOutput){
        promptBuilder.append("Tail of your previous outputs for context (Do *not* create events based on these, just for context, you already emitted these events): ").append(promptGson.toJson(previousOutput)).append("\n");
    }

    public void addUserPromptPurposeToPrompt(StringBuilder promptBuilder){
        promptBuilder.append("The user prompt contains the purpose of the plugin - you must make use of the available tools to create and maintain your output events based on the unprocessed input and the user prompt. You are allowed to output nothing if no events should be created or updated.");
    }

    public ChatCompletionCreateParams.Builder prepareChatCompletionsBuilder(String systemPrompt, Map<String,TimedEvent> openDurationEvents){
        ChatCompletionCreateParams.Builder builder = ChatCompletionCreateParams.builder()
            .model(getConfig().model)
            .addDeveloperMessage(systemPrompt)
            .addUserMessage(getConfig().prompt)
            .parallelToolCalls(true);
        builder.addTool(ChatCompletionFunctionTool.builder().function(createNopFunctionDefinition()).build());
        if (getConfig().allowDurationEvents){
            builder.addTool(ChatCompletionFunctionTool.builder().function(createDurationEventFunctionDefinition()).build());
            if (!openDurationEvents.isEmpty()) {
                builder.addTool(ChatCompletionFunctionTool.builder().function(createUpdateDurationEventFunctionDefinition(openDurationEvents)).build());
                builder.addTool(ChatCompletionFunctionTool.builder().function(createCloseDurationEventFunctionDefinition(openDurationEvents)).build());
            }
        }
        if (getConfig().allowInstantEvents){
            builder.addTool(ChatCompletionFunctionTool.builder().function(createInstantEventFunctionDefinition()).build());
        }
        return builder;
    }


    protected TimedEvent prepareEvent(String arguments) {
        Gson gson = new Gson();
        TimedEvent event = gson.fromJson(arguments, TimedEvent.class);

        // FIXME: guard against output events that start before the earliest
        // unprocessed input event (the old commented-out guard applied the
        // callers' eventStartLimit here and dropped early events)

        ProcessorOutputSpecification outputSpec = getConfig().outputs.get(event.type);
        if (outputSpec==null) throw new IllegalArgumentException("Type "+event.type+" does not exist in output specification");
        if (outputSpec.internal) throw new IllegalArgumentException("The internal event type specifier "+event.type+" cannot be used as output from AI directly");
        outputSpec.validate(gson.toJson(event.data));
        return event;
    }

    protected TimedEvent createInstantEvent(String arguments) {
        return createInstantEvent(arguments, null);
    }
    protected TimedEvent createInstantEvent(String arguments, Long timestamp) {
        TimedEvent event = prepareEvent(arguments);
        if (timestamp!=null) event.start = timestamp;
        event.id = session.createEventId();
        return addEvent(event);
    }

    private TimedEvent addEvent(TimedEvent event){
        session.onEventAdded(event);
        return event;
    }

    protected TimedEvent createDurationEvent(String arguments, Map<String, TimedEvent> existingEvents){
        return createDurationEvent(arguments, existingEvents, null, null);
    }
    protected TimedEvent createDurationEvent(String arguments, Map<String, TimedEvent> existingEvents, Long startTimestamp, Long endTimestamp){
        TimedEvent event = prepareEvent(arguments);
        if (startTimestamp!=null) event.start = startTimestamp;
        if (endTimestamp!=null) event.end = endTimestamp;
        event.id = session.createEventId();
        event.tentative = true;
        synchronized (existingEvents) {
            existingEvents.put(event.id, event);
        }
        return addEvent(event);
    }

    protected TimedEvent updateDurationEvent(String arguments, Map<String, TimedEvent> existingEvents){
        return updateDurationEvent(arguments, existingEvents, null);
    }
    protected TimedEvent updateDurationEvent(String arguments, Map<String, TimedEvent> existingEvents, Long endTimestamp){
        Gson gson = new Gson();
        // Parse the arguments once as a JSON tree, so that fields absent from
        // the arguments can be told apart from fields explicitly sent as null:
        // an absent field keeps the current value of the event, an explicit
        // null clears it.
        JsonObject argumentsTree = gson.fromJson(arguments, JsonObject.class);
        TimedEvent eventData = gson.fromJson(argumentsTree, TimedEvent.class);

        TimedEvent originalEvent = null;
        synchronized (existingEvents) {
            // Lookup event
            originalEvent = existingEvents.get(eventData.id);
            if (originalEvent==null) throw new IllegalArgumentException("Invalid event ID for duration event update: "+eventData.id);

            // The update tool carries no event type of its own: validate against
            // the output schema of the event being updated, so an update can never
            // switch an event to a different (or internal) output type.
            ProcessorOutputSpecification outputSpec = getConfig().outputs.get(originalEvent.type);
            if (outputSpec==null) throw new IllegalArgumentException("Type "+originalEvent.type+" does not exist in output specification");

            // Merge the update over the existing event data (same semantics as
            // the client-side duration event API in session.js) and validate the
            // merged result, so that an updated event can never hold data that
            // createDurationEvent would have rejected. A rejected update leaves
            // the original event untouched.
            JsonElement mergedData = mergeEventData(originalEvent.data, eventData.data);
            try {
                outputSpec.validate(gson.toJson(mergedData));
            } catch (IllegalArgumentException ex) {
                throw new IllegalArgumentException("Update of duration event "+eventData.id+" (type "+originalEvent.type+") failed validation: "+ex.getMessage(), ex);
            }

            // Update it (an absent end/entity in the arguments keeps the current value)
            originalEvent.end = endTimestamp!=null?endTimestamp:(argumentsTree.has("end")?eventData.end:originalEvent.end);
            originalEvent.entity = argumentsTree.has("entity")?eventData.entity:originalEvent.entity;
            originalEvent.data = mergedData;
        }

        session.onEventUpdated(originalEvent);
        return originalEvent;
    }

    /**
     * Merges update data over the existing data of a duration event with the
     * same semantics as the client-side duration event API (session.js merges
     * updates as {@code {...event.data, ...data}}): top-level fields of the
     * update replace the corresponding fields of the existing data, every other
     * existing field is kept. The outcome is therefore identical no matter
     * whether the model re-sent the full merged data or only the changed
     * fields. The existing data is never mutated - the merged result is a new
     * element, so a failed validation cannot leave a half-updated event
     * behind. An update that is not an object (or no data at all) keeps or
     * replaces the data as-is; validation of the merged result guards the
     * event in every case.
     */
    private static JsonElement mergeEventData(JsonElement existingData, JsonElement updateData){
        if (updateData==null || updateData.isJsonNull()) return existingData;
        if (!updateData.isJsonObject() || existingData==null || !existingData.isJsonObject()) return updateData;
        JsonObject merged = existingData.getAsJsonObject().deepCopy();
        for (Map.Entry<String, JsonElement> entry : updateData.getAsJsonObject().entrySet()) {
            merged.add(entry.getKey(), entry.getValue());
        }
        return merged;
    }

    protected TimedEvent closeDurationEvent(String arguments, Map<String, TimedEvent> existingEvents){
        TimedEvent closingEvent = new Gson().fromJson(arguments, TimedEvent.class);
        TimedEvent eventToClose = null;
        synchronized (existingEvents) {
            eventToClose = existingEvents.remove(closingEvent.id);
        }
        if (eventToClose==null) throw new IllegalArgumentException("Invalid event ID for duration event closing: "+closingEvent.id);
        eventToClose.tentative = false;
        session.onEventUpdated(eventToClose);
        return eventToClose;
    }

    public static class ToolCallingConfig extends AbstractAIProcessor.OpenAIBaseConfig {
        @JsonPropertyDescription("Whether to use the new responses API instead of completions")
        public boolean useResponses = false;

        // Types of output
        @JsonPropertyDescription("Allow the AI to create events with a duration and update them")
        public boolean allowDurationEvents = true;
        @JsonPropertyDescription("Allow creation of instantaneous events")
        public boolean allowInstantEvents = true;

        /**
         * The generic text payload schema shared by the AI processors'
         * built-in outputs (stund://aiTextEvent.json): every tool-calling AI
         * can always emit plain textual notes, so an inputs-only config works
         * instead of silently no-oping with an empty output enum.
         */
        public static final String AI_TEXT_EVENT_SCHEMA = """
            {
              "$schema": "http://json-schema.org/draft-07/schema#",
              "description": "A textual observation or note produced by an AI processor",
              "type": "object",
              "properties": {
                "text": {
                  "type": "string",
                  "description": "The text of the observation or note"
                }
              },
              "required": [
                "text"
              ],
              "additionalProperties": false
            }
        """;
    }
}
