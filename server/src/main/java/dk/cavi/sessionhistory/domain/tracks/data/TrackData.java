/**
 * Track Data
 * Base metadata persisted alongside every track, holding the session-relative
 * resource identifier of the track's data file.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain.tracks.data;

/**
 *
 * @author jbk
 */
public class TrackData {
    public String resource; // An optional session-relative resource identifier created with this event
}  