/**
 * Start Media Stream Message
 * Data channel message announcing a new media stream, mapping the WebRTC
 * transceiver (mid, label, media and track ids) to its stream type for
 * recording.
 *
 * Copyright (c) 2025 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.api_datachannel;

/**
 *
 * @author jbk
 */
public class StartMediaStream extends StartStream {
    public String mid;
    public String label;
    public String media;
    public String track;
}
