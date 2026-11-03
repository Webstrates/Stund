/**
 * ICE Candidate Message
 * Websocket message type exchanging a single ICE candidate between the peers of
 * an ingest connection.
 *
 * Copyright (c) 2025 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.api_websocket;

/**
 *
 * @author jbk
 */
public class ICECandidate extends StreamReference {
    public String candidate;
    public int sdpMLineIndex;
}
