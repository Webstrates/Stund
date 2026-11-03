/**
 * Ingest Media Track
 * Media track recorded from a client-started media stream arriving over WebRTC,
 * stored in a Matroska container.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain.tracks;

import dk.cavi.sessionhistory.api_datachannel.StartMediaStream;
import dk.cavi.sessionhistory.domain.SessionStorage;
import dk.cavi.sessionhistory.domain.tracks.data.IngestTrackData;

/**
 *
 * @author jbk
 */
public class IngestMediaTrack extends AbstractMediaTrack {   
    public IngestMediaTrack(SessionStorage session, String eventId, String entityId, String connectionId, String encodingType, StartMediaStream info){
        super(session, new TrackEvent(info.streamType, eventId, IngestTrackData.fromStartMediaStream(info, session.createUniqueMediaContainerResource(entityId, info.streamType, encodingType, "mkv"), connectionId, encodingType)));
        event().data = info.data;
        event().entity = entityId;
    }        
    
    @Override
    public IngestTrackData metadata() {
        return (IngestTrackData) super.metadata();
    }    
}
