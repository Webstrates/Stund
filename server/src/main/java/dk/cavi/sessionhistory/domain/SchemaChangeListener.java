/**
 * Schema Change Listener
 * Callback interface for parties that need to be notified whenever the schema
 * of a session, such as its processors and models, changes.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain;

/**
 *
 * @author jbk
 */
public interface SchemaChangeListener {
    void onSchemaChanged();
}
