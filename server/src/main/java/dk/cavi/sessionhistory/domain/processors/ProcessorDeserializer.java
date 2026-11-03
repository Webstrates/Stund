/**
 * Processor Deserializer
 * Gson adapter that deserializes processors polymorphically from JSON,
 * instantiating the right processor class and its exact configuration type when
 * loading session schemas or adding processors.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain.processors;

import com.google.gson.*;

import dk.cavi.sessionhistory.domain.processors.Processor.ProcessorConfig;

import java.lang.reflect.Method;
import java.lang.reflect.Type;

/**
 *
 * @author jbk
 */
public class ProcessorDeserializer implements JsonDeserializer<Object> {
    private static final String PREFIX = "dk.cavi.sessionhistory.domain.processors.";

    @Override
    public Object deserialize(JsonElement json, Type typeOfT, JsonDeserializationContext context)
            throws JsonParseException {

        JsonObject jsonObject = json.getAsJsonObject();

        // Get the class name from the "type" field
        String name = jsonObject.get("name").getAsString();
        String typeName = jsonObject.get("type").getAsString();
        String fullClassName = PREFIX + typeName;

        try {
            Class<?> clazz = Class.forName(fullClassName);
            Type configType = getConfigType(clazz);

            // Create the instance
            Processor processor = (Processor) context.deserialize(json, clazz);

            // This ensures the config is of the exact type matching the processor subclass
            ProcessorConfig configObject = (ProcessorConfig) context.deserialize(jsonObject.get("config"), configType);
            processor.config = configObject;
            processor.name = name;
            return processor;
        } catch (Exception e) {
            throw new JsonParseException("Failed to deserialize processor of type: " + typeName, e);
        }
    }

    public static Type getConfigType(Class processorClass) throws NoSuchMethodException {
        // Determine the config type from getConfig() return type
        Method getConfigMethod = processorClass.getMethod("getConfig");
        return getConfigMethod.getGenericReturnType();
    }

    public static Gson getReader(){
        return new GsonBuilder()
            .registerTypeAdapter(Processor.class, new ProcessorDeserializer())
            .setExclusionStrategies(new ExclusionStrategy() {
                @Override
                public boolean shouldSkipField(FieldAttributes f) {
                    return Processor.class.isAssignableFrom(f.getDeclaringClass()) && f.getName().equals("config");
                }

                @Override
                public boolean shouldSkipClass(Class<?> clazz) {
                    return false;
                }
            })
            .create();
    }
}