/**
 * Processed Media Track Data
 * Metadata for processor-derived media tracks: the encoding used and the
 * nanosecond offsets of the contributing source tracks.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain.tracks.data;

import java.util.Map;

/**
 *
 * @author jbk
 */
public class ProcessedMediaTrackData extends TrackData {
    public String encodingType;
    public Map<String, Long> sourceOffsetsNS;

    public ProcessedMediaTrackData(String resource, String encodingType){
        this.resource = resource;
        this.encodingType = encodingType;
    }
}    