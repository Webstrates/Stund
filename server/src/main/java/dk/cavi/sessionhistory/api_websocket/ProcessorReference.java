/**
 * Processor Reference Message
 * Websocket message type referencing a processor by name, for example when
 * removing it from a session.
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
public class ProcessorReference extends Op {
    public String processor;
}
