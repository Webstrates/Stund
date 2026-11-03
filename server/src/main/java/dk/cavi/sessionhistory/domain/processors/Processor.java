/**
 * Processor
 * Abstract base of all event processors: binds a processor to its session,
 * matches input streams, and manages outputs whose payloads are validated
 * against JSON schemas, with optional log and exception event streams.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain.processors;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonPropertyDescription;
import com.fasterxml.jackson.annotation.JsonValue;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.reflect.TypeToken;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SpecVersion;
import com.networknt.schema.ValidationMessage;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;

import dk.cavi.sessionhistory.domain.SessionStorage;
import dk.cavi.sessionhistory.domain.model.TimedEvent;
import dk.cavi.sessionhistory.domain.processors.Processor.ProcessorConfig;
import dk.cavi.sessionhistory.domain.tracks.AbstractTrack;

import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 *
 * @author jbk
 */
public abstract class Processor {
    protected static final Logger LOGGER = Logger.getLogger(Processor.class.getName());
    public String type;
    protected transient SessionStorage session;
    public ProcessorConfig config;
    protected transient String name;
    protected transient long currentProcessingTimestamp;

    private transient String logSpecifier;
    private transient String errorSpecifier;

    public void init(SessionStorage session, String name, ProcessorConfig config){
        type = this.getClass().getSimpleName();
        this.session = session;
        this.name = name;
        this.config = config;

        // Register the config's built-in outputs (server-defined schemas
        // under client-controllable names) after the config JSON is bound but
        // before the log/error outputs and validation, so a spec cannot
        // clobber or forge them with an explicit outputs map
        config.registerBuiltInOutputs();

        logSpecifier = "debug.processor."+name+".log";
        errorSpecifier = "debug.processor."+name+".error";

        // Setup outputs for logging and errors
        if (getConfig().emitLogEvents){
            config.addOutputWithSchema(logSpecifier, "stund://processorLogSchema.json", """
                {
                "type": "object",
                "properties": {
                    "text": {
                    "type": "string",
                    "description": "The log entry text string"
                    }
                },
                "required": [
                    "text"
                ],
                "additionalProperties": false
                }""", true);
        }
        if (getConfig().emitExceptionEvents){
            config.addOutputWithSchema(errorSpecifier, "stund://processorErrorSchema.json", """
            {
              "type": "object",
              "properties": {
                "text": {
                  "type": "string",
                  "description": "The textual representation of the exception as a string"
                }
              },
              "required": [
                "text"
              ],
              "additionalProperties": false
            }""", true);
        }

        config.validateAndInit();
    }

    protected void exception(Throwable ex, long timestamp) {
        TimedEvent event = new TimedEvent(errorSpecifier, session.createEventId());
        event.start = timestamp;
        JsonObject extraData = new JsonObject();
        extraData.addProperty("text", ex.getMessage());
        extraData.addProperty("type", ex.getClass().getName());
        JsonArray stackTrace = new JsonArray();
        for (StackTraceElement element : ex.getStackTrace()) {
            stackTrace.add(element.toString());
        }
        extraData.add("stack", stackTrace);
        event.data = extraData;
        session.onEventAdded(event);
        LOGGER.log(Level.SEVERE, "Processor " + name + " threw an exception", ex);
    }

    protected void log(String log, long timestamp){
        TimedEvent event = new TimedEvent(logSpecifier, session.createEventId());
        event.start = timestamp;
        JsonObject extraData = new JsonObject();
        extraData.addProperty("text", log);
        event.data = extraData;
        session.onEventAdded(event);
        LOGGER.log(Level.FINE, "Processor {0} [{1}]: {2}", new Object[]{name, event.start, log});
    }

    public abstract void destroy();

    public String getName(){
        return name;
    }

    public boolean matchesStreamType(String streamType) {
        for (String regexKey : config.inputs.keySet()) {
            if (streamType.matches(regexKey)) return true;
        }
        return false;
    }

    protected String getDefaultOutputStreamType(){
        // The default is tracked explicitly: findFirst() over the outputs
        // HashMap would return whatever hashes first, which is the debug log
        // stream (not the built-in output) for most realistic processor names
        // once emitLogEvents/emitExceptionEvents register their streams
        String defaultStream = config.defaultOutputStreamType;
        if (defaultStream != null) return defaultStream;
        throw new IllegalStateException("Processor '"+name+"' has no built-in default output stream. Configured outputs: "+String.join(", ", config.outputs.keySet()));
    }

    abstract public ProcessorConfig getConfig();

    public void onTrackAdded(AbstractTrack inputTrack){};
    public void onEventAdded(TimedEvent event){};
    public void onEventUpdated(TimedEvent event){};

    /**
     * Informs the processor about the approximate session timestamp currently being processed
     * @param timestmap
     */
    public void onSessionTimeUpdated(long timestamp){
        currentProcessingTimestamp = timestamp;
    };

    public static abstract class ProcessorConfig {
        @JsonProperty(required = true)
        @JsonValue
        public Map<String,ProcessorInputSpecification> inputs = new HashMap<>();

        @JsonProperty(required = true)
        @JsonValue
        public Map<String,ProcessorOutputSpecification> outputs = new HashMap<>();

        @JsonProperty(required = true)
        @JsonValue(true)
        public Map<String, Object> schemas = new HashMap<>();

        @JsonPropertyDescription("Create an event stream for logging informational messages")
        public boolean emitLogEvents = false;
        @JsonPropertyDescription("Create an event stream for exceptions thrown by this processor")
        public boolean emitExceptionEvents = false;


        private transient Gson gson;
        private transient JsonSchemaFactory schemaFactory;

        /** The tracked default output stream: set when a built-in output is
         * registered and re-derived on every construction (never serialized). */
        protected transient String defaultOutputStreamType;

        public ProcessorConfig() {
            gson = new Gson();
            schemaFactory = JsonSchemaFactory.builder(JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V7))
            .schemaLoaders(schemaLoaders -> schemaLoaders.add(uri -> {
                if (schemas.containsKey(uri.toString())) {
                    return ()->new ByteArrayInputStream(gson.toJson(schemas.get(uri.toString())).getBytes(StandardCharsets.UTF_8));
                }
                return null; // Fallback to default loaders
            })).build();
        }

        public void validateAndInit(){
            outputs.forEach((t, u) -> {
                u.validateAndInit(this);
            });
        }

        /**
         * Registers this config's built-in outputs: the processor's intrinsic
         * product, emitted under a client-controllable stream name with a
         * server-defined schema. Called by Processor.init() AFTER the config
         * JSON is bound, so an outputStreamType supplied by a session spec or
         * addProcessor command is honored - and a spec that ships an explicit
         * outputs map can neither remove nor forge the built-ins (they are
         * re-registered here). Configs without an intrinsic product (script,
         * event stream, ...) keep the base no-op: their outputs are the
         * client's declared application streams.
         */
        protected void registerBuiltInOutputs() {}

        /**
         * Registers one built-in output and remembers it as this config's
         * default output stream (the first built-in wins).
         */
        protected void builtInOutput(String streamName, String schemaId, String schema){
            addOutputWithSchema(streamName, schemaId, schema, false);
            if (defaultOutputStreamType==null) defaultOutputStreamType = streamName;
        }

        /**
         * Validates a client-supplied built-in stream name: it becomes part
         * of derived resource filenames (no '/', no '..') and must never
         * match this processor's own input patterns - a self-matching output
         * would make the processor re-ingest its own derived tracks forever.
         */
        protected void validateBuiltInStreamName(String streamName){
            if (streamName==null || streamName.isBlank()) throw new IllegalArgumentException("The built-in output stream name (outputStreamType) must be a non-empty string");
            if (streamName.contains("/") || streamName.contains("..")) throw new IllegalArgumentException("The built-in output stream name '"+streamName+"' must not contain '/' or '..'");
            for (String inputPattern : inputs.keySet()){
                if (streamName.matches(inputPattern)) throw new IllegalArgumentException("The built-in output stream name '"+streamName+"' matches this processor's own input '"+inputPattern+"' - the processor would re-ingest its own output");
            }
        }

        public void addInput(String inputMatch){
            addInput(inputMatch, new ProcessorInputSpecification());
        }

        public void addInput(String inputMatch, ProcessorInputSpecification spec){
            inputs.put(inputMatch, spec);
        }

        public void addOutputWithSchema(String outputSpecifier, String schemaId, String schema, boolean internal){
            addOutputSchema(schemaId, schema);
            addOutput(outputSpecifier, new ProcessorOutputSpecification(this, schemaId, internal));
        }

        public void addOutput(String outputSpecifier, ProcessorOutputSpecification spec){
            outputs.put(outputSpecifier, spec);
        }

        public void addOutputSchema(String schemaId, String outputSchema){
            schemas.put(schemaId, (Map<String, Object>) (new Gson().fromJson(outputSchema, new TypeToken<Map<String, Object>>() {}.getType())));
        }
    }


    public static class ProcessorOutputSpecification {
        private transient JsonSchema schemaValidator;
        private transient ObjectMapper mapper;
        public final String schemaId;
        public final boolean internal;

        public ProcessorOutputSpecification(ProcessorConfig parentConfig, String schemaId, boolean internal){
            this.schemaId = schemaId;
            this.internal = internal;
            validateAndInit(parentConfig);
        }

        public void validateAndInit(ProcessorConfig parentConfig){
            if (!parentConfig.schemas.containsKey(schemaId)) throw new IllegalArgumentException("No such schema id in registry " + schemaId + ". Available schema ids: " + String.join(", ", parentConfig.schemas.keySet()));
            this.mapper = new ObjectMapper();
            schemaValidator = parentConfig.schemaFactory.getSchema(parentConfig.gson.toJson(parentConfig.schemas.get(schemaId)));
        }

        public synchronized void validate(String jsonInput){
            JsonNode node;
            try {
                node = mapper.readTree(jsonInput);
            } catch (JsonProcessingException e) {
                throw new IllegalArgumentException(e);
            }
            Set<ValidationMessage> errors = schemaValidator.validate(node);

            if (errors.isEmpty()) {
                return;
            } else {
                StringBuilder errorMessage = new StringBuilder("Validation failed with the following errors:\n");
                for (ValidationMessage error : errors) {
                    errorMessage.append("- ").append(error.getMessage()).append("\n");
                }
                throw new IllegalArgumentException(errorMessage.toString());
            }
        }
    }

    public static class ProcessorInputSpecification {
    }
}
