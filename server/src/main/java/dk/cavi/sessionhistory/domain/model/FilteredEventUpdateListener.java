/**
 * Filtered Event Update Listener
 * Callback interface receiving the coalesced bulk updates of an event model.
 *
 * Copyright (c) 2025 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain.model;

import com.google.gson.JsonObject;

/**
 *
 * @author jbk
 */
public interface FilteredEventUpdateListener {
    void onFilteredEventBulkUpdate(ModelUpdateTracker source, JsonObject update);
}
