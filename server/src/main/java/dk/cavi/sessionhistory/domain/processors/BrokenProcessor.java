/**
 * Broken Processor
 * Placeholder kept in a session's schema when a persisted processor entry
 * fails to load (its class or config no longer parses). The original entry
 * JSON is preserved verbatim so nothing is lost: it round-trips through
 * saveConfig() and the schemaChange broadcasts until the original class
 * returns, and clients can inspect it (or remove the placeholder and re-add
 * the original via the addProcessor command). Deliberately inert - it
 * matches no input and emits nothing.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain.processors;

import com.google.gson.JsonObject;
import dk.cavi.sessionhistory.domain.model.TimedEvent;
import dk.cavi.sessionhistory.domain.tracks.AbstractTrack;

/**
 *
 * @author jbk
 */
public class BrokenProcessor extends Processor {

    /** Why the original entry could not be loaded (serialized, inspectable by clients). */
    public String loadError;

    /**
     * The preserved original: the type that failed to load and the entry's
     * raw JSON, kept verbatim for the day the class returns.
     */
    public static class BrokenConfig extends ProcessorConfig {
        public String originalType;
        public JsonObject raw;
    }

    public BrokenProcessor(String originalType, JsonObject rawEntry, String loadError) {
        BrokenConfig config = new BrokenConfig();
        config.originalType = originalType;
        config.raw = rawEntry;
        this.loadError = loadError;
        this.config = config;
    }

    @Override
    public ProcessorConfig getConfig(){
        return config;
    }

    @Override
    public void destroy() {
        // Nothing to tear down - it never ran
    }

    @Override
    public void onTrackAdded(AbstractTrack inputTrack) {
        // Deliberately inert
    }

    @Override
    public void onEventAdded(TimedEvent event) {
        // Deliberately inert
    }

    @Override
    public void onEventUpdated(TimedEvent event) {
        // Deliberately inert
    }
}
