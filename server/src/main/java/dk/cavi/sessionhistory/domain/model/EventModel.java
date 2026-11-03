/**
 * Event Model
 * Gathers the events matching its input specification into a subscribable model
 * of JSON events; the session's history model gives clients the full timeline.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain.model;

import com.google.gson.ExclusionStrategy;
import com.google.gson.FieldAttributes;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.logging.Logger;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

/**
 * Gathers events into a JSON model based on a specification
 * 
 * @author jbk
 */
public class EventModel {
    private static final Logger LOGGER = Logger.getLogger(EventModel.class.getName());

    private transient List<ModelUpdateTracker> subscribers = new ArrayList<>();
    private transient String name;
    private ModelConfig config;
    /** Each input pattern's fields filter, parsed once at construction:
     * data paths as segment arrays. Absent key = the pattern is
     * unrestricted (whole events); present with an empty list = the
     * pattern drops matching events' data entirely (a start/stop-only
     * feed). Populated in the constructor and never touched again, so it
     * is safe to read from the event dispatch threads. */
    private transient final Map<String, List<String[]>> parsedInputFilters = new HashMap<>();
    private transient Map<String, JsonObject> filteredEvents = new HashMap<>();
    private transient final Gson gson;

    private static class MetaExclusionStrategy implements ExclusionStrategy {
        @Override
        public boolean shouldSkipField(FieldAttributes f) {
            // If the field has the @Meta annotation, skip it
            return f.getAnnotation(Meta.class) != null;
        }

        @Override
        public boolean shouldSkipClass(Class<?> clazz) {
            return false;
        }
    }    

    public EventModel(String name) {
        this(name, new ModelConfig());
    }

    /**
     * Builds a model from an already-populated configuration (a session
     * spec's ModelSpec, or the ModelConfig read back from schema.udta when
     * a persisted session is restored). EventModel must never be
     * Gson-allocated instead: its transient final Gson field would stay
     * null and its initializers would never run.
     */
    public EventModel(String name, ModelConfig config) {
        this.name = name;
        this.config = (config == null || config.inputs == null) ? new ModelConfig() : config;
        gson = new GsonBuilder()
                .setExclusionStrategies(new MetaExclusionStrategy())
                .create();
        // The session-spec gate validates input filters up front (applySpec
        // runs spec.validate() before building models); a schema.udta restored
        // from disk is trusted instead, so flag what would not survive the
        // gate - broken patterns and unusable data paths are both ignored at
        // match time rather than thrown into the event dispatch.
        for (Map.Entry<String, ModelInputSpecification> input : this.config.inputs.entrySet()) {
            try {
                Pattern.compile(input.getKey());
            } catch (PatternSyntaxException invalid) {
                LOGGER.warning("Event model '"+name+"' ignores restored input pattern '"+input.getKey()+"': "+invalid.getMessage());
                continue;
            }
            ModelInputSpecification spec = input.getValue();
            if (spec == null || spec.fields == null) continue; // unrestricted
            List<String[]> parsed = new ArrayList<>();
            List<String> broken = new ArrayList<>();
            for (String path : spec.fields) {
                if (path == null) { broken.add("null"); continue; }
                try {
                    parsed.add(parsePath(path));
                } catch (IllegalArgumentException invalid) {
                    broken.add(path);
                }
            }
            if (!broken.isEmpty()) LOGGER.warning("Event model '"+name+"' input '"+input.getKey()+"' ignores invalid fields paths ["
                    +String.join(", ", broken)+"] - matching events keep their envelope and whatever the valid paths harvest");
            parsedInputFilters.put(input.getKey(), parsed);
        }
    }

    public String getName() {
        return name;
    }

    void subscribe(ModelUpdateTracker updateSubscriber) {
        if (subscribers.contains(updateSubscriber)) throw new IllegalStateException("Cannot double-subscribe to an EventModel");
        
        // Add listener to list for future updates
        synchronized (subscribers) {
            synchronized (filteredEvents) {
                // Lock the model and process all events so far in bulk
                filteredEvents.values().forEach(e -> {
                    updateSubscriber.onEventAdded(e.get("id").getAsString(), e);
                });
                subscribers.add(updateSubscriber);
            }
        }        
    }
    
    public ModelConfig getConfig(){
        return config;
    }
    
    public boolean matchesStreamType(String streamType) {
        for (String regexKey : config.inputs.keySet()) {
            if (streamType.matches(regexKey)) return true;
        }
        return false;
    }       

    public void onEventAdded(TimedEvent event){
        // Check preconditions
        if (!matchesStreamType(event.type)) return; // Ignore streamTypes not in our spec

        // Convert to the JSON this model exposes of the event - the input
        // specifications' field filters decide which event fields enter it
        JsonObject json = toModelJson(event);
        
        // Store + notify
        synchronized (filteredEvents) {
            filteredEvents.put(event.id, json);
        }
        notifyAdded(event.id, json);
    }
    
    public void onEventUpdated(TimedEvent event){
        // Check preconditions
        if (!matchesStreamType(event.type)) return; // Ignore streamTypes not in our spec

        // Convert to the JSON this model exposes of the event - the input
        // specifications' field filters decide which event fields enter it
        JsonObject json = toModelJson(event);

        // Store + notify
        synchronized (filteredEvents) {
            // Only update if the event ID is already present
            if (filteredEvents.containsKey(event.id)) {
                filteredEvents.put(event.id, json);
            } else {
                LOGGER.warning("Ignoring an update for unknown event "+event.id);
                return;
            }
        }
        notifyUpdated(event.id, json);
    }    
    
    public void onEventRemoved(TimedEvent event){
        JsonObject removedJson;
        synchronized (filteredEvents) {
            removedJson = filteredEvents.remove(event.id);
        }

        // Notify only if the event was actually being tracked/stored
        if (removedJson != null) {
            notifyRemoved(event.id);
        }
    }    
    
    
    /**
     * The JSON this model exposes of an event: the whole event, unless
     * every input pattern matching its stream type restricts the data - the
     * TimedEvent envelope itself (type, id, start, end, tentative, entity)
     * is never filtered, only the data object is, keeping the listed data
     * paths. An empty harvest (an empty fields list, or paths that address
     * nothing in this event) leaves the event with no data member at all.
     */
    private JsonObject toModelJson(TimedEvent event) {
        JsonObject json = (JsonObject) gson.toJsonTree(event);
        List<String[]> paths = allowedPaths(event.type);
        if (paths == null) return json;

        JsonObject filtered = new JsonObject();
        for (Map.Entry<String, JsonElement> field : json.entrySet()) {
            if (!field.getKey().equals("data")) filtered.add(field.getKey(), field.getValue());
        }
        JsonElement data = json.get("data");
        if (data != null && data.isJsonObject()) {
            JsonObject harvested = new JsonObject();
            for (String[] path : paths) harvest(data.getAsJsonObject(), path, 0, harvested);
            if (!harvested.isEmpty()) filtered.add("data", harvested);
        }
        return filtered;
    }

    /**
     * The union of the parsed data paths of every input pattern matching
     * this stream type, or null when no matching pattern restricts data
     * (any matching unrestricted pattern - or none at all - keeps the
     * whole event). Also runs on unvalidated restored configs, so it must
     * never throw: a null specification is unrestricted, and a broken
     * restored pattern matches nothing (the spec gate rejects patterns like
     * these up front; a hand-edited schema.udta can still carry one).
     */
    private List<String[]> allowedPaths(String streamType) {
        List<String[]> allowed = null;
        for (Map.Entry<String, ModelInputSpecification> input : config.inputs.entrySet()) {
            if (!matchesSafely(streamType, input.getKey())) continue;
            ModelInputSpecification spec = input.getValue();
            if (spec == null || spec.fields == null) return null; // unrestricted
            if (allowed == null) allowed = new ArrayList<>();
            // The constructor parsed this filter (the pattern compiled, so it
            // reached the put): an empty list is the envelope-only feed - an
            // empty fields list, or a restored filter whose every path was
            // malformed and is being ignored.
            allowed.addAll(parsedInputFilters.get(input.getKey()));
        }
        return allowed;
    }

    /**
     * Copies everything the path addresses from {@code node} into
     * {@code into}: walks object keys (a "*" segment matches every key of
     * the object), and the last segment's whole value - arrays included -
     * is kept as-is. An intermediate level is attached only when something
     * below it matched, so a path whose leaf is missing leaves no empty
     * scaffold container behind.
     */
    private static void harvest(JsonObject node, String[] path, int idx, JsonObject into) {
        String segment = path[idx];
        boolean last = idx == path.length - 1;
        if (last) {
            if (segment.equals("*")) {
                for (Map.Entry<String, JsonElement> child : node.entrySet()) into.add(child.getKey(), child.getValue().deepCopy());
            } else if (node.has(segment)) {
                into.add(segment, node.get(segment).deepCopy());
            }
            return;
        }
        JsonObject sub = new JsonObject();
        if (segment.equals("*")) {
            for (Map.Entry<String, JsonElement> child : node.entrySet()) {
                if (!child.getValue().isJsonObject()) continue;
                harvest(child.getValue().getAsJsonObject(), path, idx + 1, sub);
                if (!sub.isEmpty()) mergeInto(into, child.getKey(), sub);
                sub = new JsonObject();
            }
        } else if (node.has(segment) && node.get(segment).isJsonObject()) {
            harvest(node.getAsJsonObject(segment), path, idx + 1, sub);
            if (!sub.isEmpty()) mergeInto(into, segment, sub);
        }
    }

    /** Attaches {@code sub} at {@code key}, merging into the container a
     * previously listed path already built there (or replacing whatever
     * non-object a previous last-segment match left at the key). */
    private static void mergeInto(JsonObject into, String key, JsonObject sub) {
        JsonElement existing = into.get(key);
        if (existing != null && existing.isJsonObject()) {
            for (Map.Entry<String, JsonElement> entry : sub.entrySet()) existing.getAsJsonObject().add(entry.getKey(), entry.getValue());
        } else {
            into.add(key, sub);
        }
    }

    /**
     * Parses a data path for a fields filter: "$."-rooted, dot-separated
     * object keys, each a literal or a whole-segment "*" wildcard
     * ("$.transcript.text", "$.segments.*.text"). Throws a plain
     * IllegalArgumentException with a self-explanatory message otherwise.
     */
    static String[] parsePath(String path) {
        if (path.equals("$")) throw new IllegalArgumentException(
            "the '$' path addresses the whole data object - drop the fields filter to keep whole events");
        if (!path.startsWith("$.") || path.length() == 2) throw new IllegalArgumentException(
            "a fields path is '$.' followed by dot-separated data keys, like '$.text' or '$.segments.*.text'");
        String[] segments = path.substring(2).split("\\.", -1);
        for (String segment : segments) {
            if (segment.isEmpty()) throw new IllegalArgumentException(
                "a fields path segment is empty - '"+path+"' is '$.' followed by dot-separated data keys");
            if (segment.contains("*") && !segment.equals("*")) throw new IllegalArgumentException(
                "in a fields path the '*' wildcard is a whole segment, not part of a key - '"+path+"'");
        }
        return segments;
    }

    /** String.matches for a pattern that may be a broken hand edit: a
     * pattern the spec gate never saw matches nothing instead of throwing
     * (the union loop evaluates every pattern, not just up to the first
     * match, so one bad key must not take the event dispatch down). */
    private static boolean matchesSafely(String streamType, String pattern) {
        try {
            return streamType.matches(pattern);
        } catch (PatternSyntaxException invalid) {
            return false;
        }
    }

    private void notifyAdded(String id, JsonObject event){
        synchronized (subscribers) {
            subscribers.forEach(subscriber -> {
                subscriber.onEventAdded(id, event);
            });
        }
    }
    
    private void notifyUpdated(String id, JsonObject event){
        synchronized (subscribers) {
            subscribers.forEach(subscriber -> {
                subscriber.onEventUpdated(id, event);
            });
        }
    }

    private void notifyRemoved(String id){
        synchronized (subscribers) {
            subscribers.forEach(subscriber -> {
                subscriber.onEventRemoved(id);
            });
        }
    }    
    
    public static class ModelConfig {
        public Map<String,ModelInputSpecification> inputs = new HashMap<>();
        
        public void addInput(String inputMatch){
            inputs.put(inputMatch, new ModelInputSpecification());
        }
    }

    /**
     * Per input pattern: the data paths the model keeps for events of that
     * stream type - "$."-rooted paths into the event's data object. fields
     * is null exactly when the pattern is unrestricted (the whole event,
     * the {} every existing spec carries); an explicit empty list drops
     * matching events' data entirely - the client wants the TimedEvent
     * envelope (say a VAD's start/stop) and none of the payload. The
     * envelope itself is never filtered, only data is. An event matching
     * several patterns sees the union of their paths; any matching
     * unrestricted pattern wins. Paths that address nothing in a given
     * event simply keep nothing (the data member is left out when the
     * harvest is empty).
     */
    public static class ModelInputSpecification {
        public List<String> fields;

        /**
         * Spec-time validation (all-or-nothing with the rest of the
         * session spec): every entry must be a well-formed data path.
         * Which paths exist is a per-event-schema question the gate
         * cannot answer - only their shape is checked here.
         */
        public void validate(String model, String pattern) {
            if (fields == null) return; // unrestricted: the whole event
            for (String path : fields) {
                if (path == null) throw new IllegalArgumentException(
                    "model '"+model+"' input '"+pattern+"' has a null entry in its fields filter");
                try {
                    parsePath(path);
                } catch (IllegalArgumentException invalid) {
                    throw new IllegalArgumentException(
                        "model '"+model+"' input '"+pattern+"' fields path '"+path+"': "+invalid.getMessage());
                }
            }
        }
    }
}
