/**
 * Session Reference Message
 * Websocket message type referencing both a stream and a session; currently
 * unused, reserved for future commands.
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
public class SessionReference extends StreamReference {    
    public String session;    

    public SessionReference(String stream, String session) {
        this.stream = stream;
        this.session = session;
    }
}
