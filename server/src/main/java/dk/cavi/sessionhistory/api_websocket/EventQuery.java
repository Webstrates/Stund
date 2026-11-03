/**
 * Event Query Message
 * Websocket message type requesting a single event by id, with options
 * controlling how much detail is serialized.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.api_websocket;

/**
 *
 * @author jbk
 */
public class EventQuery extends Op {
    public String id;
    public EventQueryOptions options;

    public static class EventQueryOptions {
        public boolean includeMeta = false;
    }
}
