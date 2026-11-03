/**
 * SDP Offer Message
 * Websocket message type carrying an SDP offer during WebRTC ingest
 * negotiation.
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
public class SDPOffer extends Op {
    public String sdp;

    @Override
    public String toString() {
        return sdp;
    }
}
