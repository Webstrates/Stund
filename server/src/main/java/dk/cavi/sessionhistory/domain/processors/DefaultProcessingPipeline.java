/**
 * Default Processing Pipeline
 * Reusable GStreamer pipeline with bus logging and error handling, plus helpers
 * for adding, linking and syncing element chains.
 *
 * Copyright (c) 2025 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain.processors;

import java.util.logging.Level;
import java.util.logging.Logger;

import org.freedesktop.gstreamer.Bus;
import org.freedesktop.gstreamer.Element;
import org.freedesktop.gstreamer.GstObject;
import org.freedesktop.gstreamer.Pipeline;
import org.freedesktop.gstreamer.State;

/**
 *
 * @author jbk
 */
public class DefaultProcessingPipeline extends Pipeline {
    private static final Logger LOGGER = Logger.getLogger(DefaultProcessingPipeline.class.getName());

    public DefaultProcessingPipeline(String type, String name){
        super(name+"-pipeline");

        this.setAutoFlushBus(true);
        Bus bus = this.getBus();
        bus.setName(name+"-bus");
        Bus.STATE_CHANGED busStateChangeHandler = new Bus.STATE_CHANGED() {
            @Override
            public void stateChanged(GstObject source, State old, State current, State pending) {
                if (DefaultProcessingPipeline.this == source) {
                    LOGGER.log(Level.FINE, "{0}: pipeline state changed from {1} to {2} (pending {3})", new Object[]{type, old, current, pending});
                }
            }
        };
        Bus.ERROR busErrorHandler = new Bus.ERROR() {
            @Override
            public void errorMessage(GstObject source, int code, String message) {
                String state = type+": GSTBus error in " + source.getName() + ": (" + code + ") - " + message + " for " + name;
                LOGGER.severe(state);
            }
        };
        Bus.INFO busInfoHandler = new Bus.INFO() {
            @Override
            public void infoMessage(GstObject go, int i, String string) {
                LOGGER.log(Level.FINE, "{0}: {1}", new Object[]{type, string});
            }
        };
        Bus.EOS busEOSHandler = new Bus.EOS() {
            @Override
            public void endOfStream(GstObject go) {
                LOGGER.info(type + ": End of stream on the processing pipeline");
            }
        };

        bus.connect(busErrorHandler);
        bus.connect(busInfoHandler);
        bus.connect(busStateChangeHandler);
        bus.connect(busEOSHandler);
    }

    public void addAndLinkMany(Element ...elements){
        this.addMany(elements);
        if (!Element.linkMany(elements)){
            throw new IllegalStateException("Couldn't link-many");
        };
    }
    public void syncMany(Element ...elements){
        for (int i = elements.length-1; i >=0; i--){
            if (elements[i]==null) continue;
            elements[i].syncStateWithParent();
        };
    }
}
