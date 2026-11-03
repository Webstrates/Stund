/**
 * Model Update Tracker
 * Per-subscriber tracker that coalesces model changes (added, updated, removed
 * events) into bulk updates and delivers them to its listener, throttled by a
 * short delay.
 *
 * Copyright (c) 2025 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain.model;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.logging.Logger;

/**
 * Tracks modifications to the event model for subscribers to figure out what changes to send over the network
 * 
 * @author jbk
 */
public class ModelUpdateTracker implements Runnable {
    private static final Logger LOGGER = Logger.getLogger(ModelUpdateTracker.class.getName());
    public Map<String, JsonObject> added = new HashMap<>();
    public Map<String, JsonObject> updated = new HashMap<>();
    public Set<String> removed = new HashSet<>();
    private Thread ourThread;
    private static final int COALESCE_DELAY = 100;
    private final EventModel model;
    private final FilteredEventUpdateListener listener;
    
    public ModelUpdateTracker(EventModel model, FilteredEventUpdateListener listener){
        this.model = model;
        this.listener = listener;
    }

    public EventModel getModel() {
        return model;
    }
    
    public synchronized void onEventAdded(String id, JsonObject event){
        // Check preconditions
        if (removed.contains(id) || updated.containsKey(id)) throw new IllegalStateException("Cannot add an event that has already been updated or removed");
        
        added.put(id, event);
    }
    
    public synchronized void onEventUpdated(String id, JsonObject event){
        // Check preconditions
        if (removed.contains(id)) throw new IllegalStateException("Cannot update an event that has already been removed");
        if (added.containsKey(id)) {
            // We move this update to the added list to be broadcast with the add instead
            added.put(id, event);
            return;
        } 
        updated.put(id, event);
    }
    
    public synchronized void onEventRemoved(String id){
        if (removed.contains(id)) throw new IllegalStateException("Cannot remove an event that has already been removed");
        
        // Adds and updates for this are no longer relevant if it is removed
        added.remove(id);
        updated.remove(id);
        removed.add(id);
    }
    
    public void init(){
        if (ourThread!=null) throw new IllegalStateException("Cannot init a ModelUpdateTracker tracker twice");
        ourThread = new Thread(this);
        ourThread.setDaemon(true);
        ourThread.start();
    }
    
    public void destroy(){
        if (ourThread==null) throw new IllegalStateException("Cannot destroy ModelUpdateTracker that hasn't been inited");
        ourThread.interrupt();
    }

    @Override
    public void run() {
        try {
            // Run a bulk update and subscribe to future changes - this fills the "added" set
            model.subscribe(this);

            while (!Thread.interrupted()){
                JsonObject jsonUpdate = new JsonObject();                    
                boolean hadUpdates = false;
                
                synchronized (this) {
                    if (added.size()>0 || updated.size() > 0 || removed.size() > 0){
                        hadUpdates = true;
                        
                        // Construct a bulk update event for our client
                        JsonArray jsonAdded = new JsonArray();
                        JsonArray jsonUpdated = new JsonArray();
                        JsonArray jsonRemoved = new JsonArray();

                        added.forEach((id,event) -> {
                            jsonAdded.add(event);
                        });
                        updated.forEach((id,event) -> {
                            jsonUpdated.add(event);
                        });
                        removed.forEach(id -> {
                            jsonRemoved.add(id);
                        });

                        jsonUpdate.add("add", jsonAdded);
                        jsonUpdate.add("update", jsonUpdated);
                        jsonUpdate.add("remove", jsonRemoved);

                        added.clear();
                        updated.clear();
                        removed.clear();
                    }
                }
                
                if (hadUpdates) listener.onFilteredEventBulkUpdate(this, jsonUpdate);                
                Thread.sleep(COALESCE_DELAY);
            }
        } catch (InterruptedException ex){
            LOGGER.fine("ModelUpdateTracker thread interrupted");
        } finally {
            LOGGER.fine("ModelUpdateTracker thread exited");
        }
    }
}
