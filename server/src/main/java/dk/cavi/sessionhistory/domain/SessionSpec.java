/**
 * Session Spec
 * The client-supplied blueprint a session is built from at creation: the
 * processors to install (each exactly the addProcessor wire shape) and the
 * models that gather events. Every field omitted from a processor's config
 * falls back to that config class's field-initializer default (an AI
 * processor's omitted model, for instance, resolves through the server's
 * ai.defaultModel / ai.defaultTranscriptionModel). Bookkeeping fields
 * (serverVersion, created, owner, start, end) are painted by the server and
 * can never be supplied here.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain;

import dk.cavi.sessionhistory.domain.model.EventModel;
import dk.cavi.sessionhistory.domain.processors.Processor;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 *
 * @author jbk
 */
public class SessionSpec {
    public List<Processor> processors = new ArrayList<>();
    public List<ModelSpec> models = new ArrayList<>();

    /**
     * A named event model with its input patterns (the ModelConfig shape
     * schema.udta and the schemaChange broadcasts already carry).
     */
    public static class ModelSpec {
        public String name;
        public EventModel.ModelConfig config;
    }

    /**
     * Pre-flights the whole spec: every processor and model is checked
     * before anything is applied, so an invalid spec never half-builds a
     * session. Throws IllegalArgumentException with a field-specific message.
     */
    public void validate() {
        Set<String> processorNames = new HashSet<>();
        for (Processor processor : processors) {
            if (processor == null) throw new IllegalArgumentException("spec.processors must not contain null entries");
            String name = processor.getName();
            if (name == null || name.isBlank()) throw new IllegalArgumentException("every spec.processors entry needs a non-blank name");
            if (!processorNames.add(name)) throw new IllegalArgumentException("duplicate processor name '"+name+"'");
            validateProcessor(processor);
        }

        Set<String> modelNames = new HashSet<>();
        for (ModelSpec model : models) {
            if (model == null || model.name == null || model.name.isBlank()) throw new IllegalArgumentException("every spec.models entry needs a non-blank name");
            if (!modelNames.add(model.name)) throw new IllegalArgumentException("duplicate model name '"+model.name+"'");
            if (model.config == null || model.config.inputs.isEmpty()) throw new IllegalArgumentException("model '"+model.name+"' declares no inputs - an input-less model silently matches nothing");
            for (String regex : model.config.inputs.keySet()) {
                try {
                    Pattern.compile(regex);
                } catch (Exception ex) {
                    throw new IllegalArgumentException("model '"+model.name+"' has invalid input pattern '"+regex+"': "+ex.getMessage());
                }
            }
            for (Map.Entry<String, EventModel.ModelInputSpecification> input : model.config.inputs.entrySet()) {
                if (input.getValue() == null) throw new IllegalArgumentException("model '"+model.name+"' input '"+input.getKey()+"' carries no specification - drop the pattern or give it {} to keep whole events");
                input.getValue().validate(model.name, input.getKey());
            }
        }
    }

    /**
     * Pre-flights one processor - the per-processor core of {@link #validate()}:
     * a present config, compilable input patterns, and repairable output
     * specifications. Shared with {@link SessionStorage#addProcessor} so the
     * ws addProcessor command runs the spec path's config, input-pattern and
     * output checks: neither transport can install a processor the other
     * would reject on those. (The name checks - blank, duplicate - stay
     * spec-side; the ws command's replace-on-re-add semantics are unchanged.)
     * Throws IllegalArgumentException with a field-specific message.
     */
    public static void validateProcessor(Processor processor) {
        String name = processor.getName();
        if (processor.getConfig() == null) throw new IllegalArgumentException("processor '"+name+"' carries no config");
        for (String regex : processor.getConfig().inputs.keySet()) {
            try {
                Pattern.compile(regex);
            } catch (Exception ex) {
                throw new IllegalArgumentException("processor '"+name+"' has invalid input pattern '"+regex+"': "+ex.getMessage());
            }
        }
        // Repairs the deserialized output specifications (they cannot run
        // their constructor through Gson) and checks every output's
        // schemaId exists in the config's schema registry.
        processor.getConfig().validateAndInit();
    }
}
