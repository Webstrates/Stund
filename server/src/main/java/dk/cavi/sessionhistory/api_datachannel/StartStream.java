/**
 * Start Stream Message
 * Base type of the messages a client sends over the WebRTC base data channel to
 * announce a new stream, carrying the stream type, client timestamps and
 * payload.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.api_datachannel;

import com.google.gson.JsonElement;

/**
 *
 * @author jbk
 */
public class StartStream {
    public String streamType;
    
    public long clientTimestampPerformance;
    public long clientTimestamp;
    
    public JsonElement data;
}
