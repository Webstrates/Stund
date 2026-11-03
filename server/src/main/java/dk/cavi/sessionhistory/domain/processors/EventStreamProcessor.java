/**
 * Event Stream Processor
 * Replays ingested event tracks into the session, reading events through their
 * tailing JSON readers as they are written and re-emitting them for other
 * processors and models.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain.processors;

import com.fasterxml.jackson.annotation.JsonClassDescription;
import dk.cavi.sessionhistory.domain.SessionStorage;
import dk.cavi.sessionhistory.domain.model.TimedEvent;
import dk.cavi.sessionhistory.domain.tracks.AbstractEventTrack;
import dk.cavi.sessionhistory.domain.tracks.AbstractTrack;
import dk.cavi.sessionhistory.domain.tracks.IngestEventTrack;
import java.io.EOFException;
import java.io.IOException;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 *
 * @author jbk
 */
@JsonClassDescription("Reads events directly from an event stream into the system")
public class EventStreamProcessor extends Processor {
    private static final Logger LOGGER = Logger.getLogger(EventStreamProcessor.class.getName());
    private transient Set<String> activeEventIds = new HashSet<>();
    
    @Override
    public void init(SessionStorage session, String name, ProcessorConfig config){
        super.init(session, name, config);
    }

    @Override
    public void onTrackAdded(AbstractTrack inputTrack){        
        if (!(inputTrack instanceof IngestEventTrack)) return; // We only understand media tracks
        LOGGER.fine("Got track "+inputTrack);
        if (!matchesStreamType(inputTrack.event().type)) return; // that match our filter

        // Set up a new processing thread
        Thread streamThread = new Thread(new IngestEventStreamProcessingThread((IngestEventTrack)inputTrack));
        streamThread.start();
    }
    
    public EventStreamProcessorConfig getConfig(){
        return (EventStreamProcessorConfig)config;
    }

    @Override
    public void destroy() {
        // FIXME: Cancel any event stream threads for EventStreamProcessor
    }
    
    private class IngestEventStreamProcessingThread implements Runnable {
        // read
        private final IngestEventTrack input;
        
        public IngestEventStreamProcessingThread(IngestEventTrack input) {
            this.input = input;         
        }      
        
        @Override
        public void run() {
            try (AbstractEventTrack.JSONReader<TimedEvent> reader = input.connectJSONReader(TimedEvent.class)) {    
                TimedEvent element;

                // This loop blocks in the read() call until a full object is available.
                while ((element = reader.read()) != null) {
                    // Update imported properties
                    element.start += input.event().start;
                    if (element.end!=null) element.end += input.event().start;

                    // Add additional properties from stream udta
                    element.type = input.event().type;
                    element.entity = input.event().entity;
                    element.sourceEvents = List.of(input.event().id);
                    
                    if (!activeEventIds.contains(element.id)){
                        session.onEventAdded(element);
                        activeEventIds.add(element.id);
                    } else {
                        session.onEventUpdated(element);
                    }
                }

                // This block is reached when the JSONReader's underlying stream hits 
                // a final EOF and no more data is expected (e.g., if the file was closed).
                LOGGER.fine("JSON stream finished for track: " + input.getSessionRelativePath());
            } catch (EOFException e){
                LOGGER.fine("EOF on "+input.getSessionRelativePath());
            } catch (IOException e) {
                LOGGER.log(Level.SEVERE, "Failed to read the JSON event stream for " + input.getSessionRelativePath(), e);
            }
        }
    }
    
    public static class EventStreamProcessorConfig extends ProcessorConfig {
    }
}
