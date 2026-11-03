/**
 * Ingest Event Track
 * Event track recorded from a client-started event stream arriving over a
 * WebRTC data channel.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain.tracks;

import dk.cavi.sessionhistory.api_datachannel.StartEventStream;
import dk.cavi.sessionhistory.domain.SessionStorage;
import dk.cavi.sessionhistory.domain.tracks.data.IngestTrackData;

/**
 *
 * @author jbk
 */
public class IngestEventTrack extends AbstractEventTrack {
    public IngestEventTrack(SessionStorage session, String eventId, String entityId, String connectionId, StartEventStream info){        
        super(session, new TrackEvent(info.streamType, eventId, IngestTrackData.fromStartEventStream(info, session.createUniqueEventStreamResource(entityId, info.streamType, "json"), connectionId)));        
        event().data = info.data;
        event().entity = entityId;        
    }
    
    @Override
    public IngestTrackData metadata() {
        return (IngestTrackData) super.metadata();
    }
}
