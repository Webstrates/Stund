/**
 * Operation Message
 * Base type of websocket command messages, carrying the op counter used to
 * match replies to the request that caused them.
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
public abstract class Op {
    public int op; // op counter
}
