/**
 * Timed Event
 * The universal event structure flowing through the system: a typed, timed and
 * possibly tentative payload that can be attributed to an entity, plus
 * server-internal metadata fields.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain.model;
import com.google.gson.JsonElement;
import java.util.List;

import com.google.gson.JsonObject;

/**
 *
 * @author jbk
 */
public class TimedEvent implements Cloneable {
    public String type;
    public String id;
    public long start;
    public Long end;
    public Boolean tentative;
    public String entity;
    public JsonElement data;

    @Meta
    public List<String> sourceEvents; // Events used to create this one
    @Meta
    public long created; // When the event was created on the server
    @Meta
    public String processor; // What processor created this event



    public TimedEvent(String streamType, String id){
        this.type = streamType;
        this.id = id;
        created = System.currentTimeMillis();
    }

    @Override
    public String toString() {
        return "TimedSegmentEvent{" +
               "type='" + type + '\'' +
               ", id='" + id + '\'' +
               ", start=" + start +
               ", end=" + end +
               ", entity=" + entity +
               ", tentative=" + tentative +
               // JsonElement's toString() method provides a full JSON representation
               ", data=" + (data != null ? data.toString() : "null") +
               '}';
    }

    @Override
    public TimedEvent clone() {
        try {
            // A shallow copy for primitives and immutable-like wrappers
            TimedEvent cloned = (TimedEvent) super.clone();

            // Perform a deep copy of the mutable JsonObject
            // This ensures the clone has its own independent data payload
            if (this.data != null) {
                // deepCopy() is the standard Gson method for JsonObject
                cloned.data = this.data.deepCopy();
            }

            return cloned;
        } catch (CloneNotSupportedException e) {
            // This shouldn't happen since we are implementing Cloneable
            throw new AssertionError();
        }
    }
}
