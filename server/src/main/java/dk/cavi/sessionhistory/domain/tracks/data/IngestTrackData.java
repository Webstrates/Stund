/**
 * Ingest Track Data
 * Metadata for tracks ingested from a client: the contributing connection,
 * client timestamps, and the WebRTC stream and transceiver identifiers.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain.tracks.data;

import dk.cavi.sessionhistory.api_datachannel.StartEventStream;
import dk.cavi.sessionhistory.api_datachannel.StartMediaStream;

/**
 *
 * @author jbk
 */
public class IngestTrackData extends TrackData {
    public String connectionId;
    public String encodingType;    
    public String mid;
    public String media;
    public String track;
    public String label;

    public long clientTimestampPerformance;
    public long clientTimestamp;

    public static IngestTrackData fromStartEventStream(StartEventStream info, String resource, String connectionId){
        IngestTrackData out = new IngestTrackData();
        out.resource = resource;
        out.clientTimestampPerformance = info.clientTimestampPerformance;
        out.clientTimestamp = info.clientTimestamp;        
        out.connectionId = connectionId;      
        return out;      
    }

    public static IngestTrackData fromStartMediaStream(StartMediaStream info, String resource, String connectionId, String encodingType){
        IngestTrackData out = new IngestTrackData();

        // Copy String properties
        out.resource = resource;
        out.mid = info.mid;
        out.label = info.label;
        out.media = info.media;
        out.track = info.track;
        out.encodingType = encodingType;

        // Copy double properties
        out.clientTimestampPerformance = info.clientTimestampPerformance;
        out.clientTimestamp = info.clientTimestamp;        

        out.connectionId = connectionId;
        return out;
    }
}    
