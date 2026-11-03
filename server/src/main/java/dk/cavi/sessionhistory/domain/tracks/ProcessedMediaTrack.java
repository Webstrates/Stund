/**
 * Processed Media Track
 * Media track derived from another track by a processor, for example an
 * extracted speech segment, remembering its source track and the timestamp
 * offset into it.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain.tracks;

import dk.cavi.sessionhistory.domain.tracks.data.ProcessedMediaTrackData;
import java.util.ArrayList;
import java.util.HashMap;

import com.google.gson.JsonObject;

import dk.cavi.sessionhistory.domain.SessionStorage;

/**
 *
 * @author jbk
 */
public class ProcessedMediaTrack extends AbstractMediaTrack {
    public ProcessedMediaTrack(SessionStorage session, AbstractTrack source, String eventId, String streamType, String encodingType, String extension, JsonObject data, long offsetNS){
        super(session, new TrackEvent(streamType, eventId, new ProcessedMediaTrackData(session.createUniqueMediaContainerResource(source.event().entity, streamType, encodingType, extension), encodingType)));        
        event().data = data;
        event().entity = source.event().entity;
        addSourceToMeta(source, offsetNS);
    }        

    private synchronized void addSourceToMeta(AbstractTrack source, long sourceOffsetNS){
        if (event().sourceEvents==null) event().sourceEvents = new ArrayList<>();        
        event().sourceEvents.add(source.event.id);
        if (metadata().sourceOffsetsNS==null) metadata().sourceOffsetsNS = new HashMap<>();
        metadata().sourceOffsetsNS.put(source.event().id, sourceOffsetNS);
    }

    @Override
    public ProcessedMediaTrackData metadata() {
        return (ProcessedMediaTrackData) super.metadata();
    }
}
