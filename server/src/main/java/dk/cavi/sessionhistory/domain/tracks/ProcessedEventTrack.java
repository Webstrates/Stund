/**
 * Processed Event Track
 * Placeholder for event tracks derived by processors - not implemented yet.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain.tracks;

import dk.cavi.sessionhistory.domain.SessionStorage;

/**
 *
 * @author jbk
 */
public class ProcessedEventTrack extends AbstractEventTrack {
    public ProcessedEventTrack(SessionStorage session, String streamType, AbstractTrack source) {
        super(null, null);
        //super(session, new ProcessedEventTrackConfig(session.createUniqueEventStreamResource(source.event.entityId, streamType, "json")));
        throw new IllegalArgumentException("Not implemented yet");
        /*
        
        getConfig().streamType = streamType;
        getConfig().data = info.data;
        getConfig().clientTimestampPerformance = info.clientTimestampPerformance;
        getConfig().clientTimestamp = info.clientTimestamp;        

        getConfig().connectionId = connectionId;
        getConfig().entityId = entityId;        */
    }
}
