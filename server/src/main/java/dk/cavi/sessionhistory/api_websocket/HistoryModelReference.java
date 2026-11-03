/**
 * History Model Reference Message
 * Websocket message type referencing a history model, used to subscribe to and
 * unsubscribe from its updates.
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
public class HistoryModelReference extends Op {
    public String model;
}
