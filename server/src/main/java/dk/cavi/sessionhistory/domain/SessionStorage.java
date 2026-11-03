/**
 * Session Storage
 * Central manager of recorded sessions: creates sessions from client-supplied
 * specs, resolves session directories on disk, restores persisted schemas,
 * allocates resource names and event ids, and fans events out to the
 * session's models and processors.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.jcabi.manifests.Manifests;
import dk.cavi.sessionhistory.core.Health;
import dk.cavi.sessionhistory.domain.model.EventModel;
import dk.cavi.sessionhistory.domain.model.TimedEvent;
import dk.cavi.sessionhistory.domain.processors.BrokenProcessor;
import dk.cavi.sessionhistory.domain.processors.Processor;
import dk.cavi.sessionhistory.domain.processors.Processor.ProcessorConfig;
import dk.cavi.sessionhistory.domain.processors.ProcessorDeserializer;
import dk.cavi.sessionhistory.domain.tracks.AbstractTrack;
import dk.cavi.sessionhistory.domain.tracks.AbstractTrack.TrackStarted;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 *
 * @author jbk
 */
public class SessionStorage implements TrackStarted {
    private static final Logger LOGGER = Logger.getLogger(SessionStorage.class.getName());
    private static final Map<String, SessionStorage> currentSessions = new HashMap<>();
    private static final String sessionBasePath = System.getProperty("session.basePath","sessions");
    private final String id;
    private SessionSchema schema;
    private long eventIdCounter = 0;
    private final List<SchemaChangeListener> schemaChangeListeners = new ArrayList<>();
    private final Thread stubTimerPointerUpdateThread;
    private final Map<String,TimedEvent> currentEvents = new HashMap<>();
    
    private SessionStorage(String sessionId){
        // Check session exists
        this.id = sessionId;
        if (sessionId.contains("/")||sessionId.contains("..")) throw new IllegalArgumentException("Invalid session identifier "+sessionId);
        File sessionDir = getBaseDir();
        LOGGER.info("Session dir is "+sessionDir.getAbsolutePath());
        if (!sessionDir.isDirectory()) throw new IllegalArgumentException("No such session "+sessionId);
        
        schema = new SessionSchema();
        // Restore the persisted setup when this session has one: rejoining
        // a session - or serving one recorded before a restart, or imported
        // from an MP4 archive - gets its real processors and models back
        // instead of server-side defaults. Fresh session dirs start empty;
        // SessionStorage.create(spec) applies the client's spec.
        if (!loadSchema()) {
            LOGGER.info("Session "+sessionId+" has no schema.udta - starting with an empty schema");
        }

        // STUB: Move the session timestamp pointer forwards from time to time
        stubTimerPointerUpdateThread = new Thread(() -> {
            LOGGER.fine("Starting the STUB timer pointer update thread...");
            try {
                while (!Thread.interrupted()){
                    try {
                        Thread.sleep(1000);
                        synchronized (schema) {
                            if (schema.end!=null) break; // Session has ended, stop emulating updates
                            schema.processors.forEach((t, u) -> {
                                u.onSessionTimeUpdated(System.currentTimeMillis());
                            });
                        }
                    } catch (InterruptedException ex) {
                        LOGGER.log(Level.WARNING, "The timer pointer update thread was interrupted - stopping the session time updates", ex);
                        Thread.currentThread().interrupt();
                    }
                }
            } catch (Throwable ex){
                LOGGER.log(Level.SEVERE, "The timer pointer update thread died unexpectedly - session time updates stop for this session", ex);
            } finally {
                LOGGER.fine("The timer pointer update thread exited (expected once its session has ended)");
            }
        });
        stubTimerPointerUpdateThread.start();
    }
   
    /**
     * Adds a processor to the session schema. The processor is pre-flighted
     * with {@link SessionSpec#validateProcessor} first - the same check the
     * spec path runs - so the ws addProcessor command rejects (with a clean
     * error reply) an input pattern POST /session would refuse with a 400,
     * instead of installing a processor that throws PatternSyntaxException
     * inside event dispatch on every later event. A restored schema.udta
     * entry that fails pre-flight lands in loadSchema's BrokenProcessor
     * fallback, never in a poisoned session.
     * @param name The name of the processor
     * @param processor The processor instance to add
     * @param config The configuration for the processor
     */
    public void addProcessor(String name, Processor processor, ProcessorConfig config) {
        synchronized (schema){
            SessionSpec.validateProcessor(processor);
            processor.init(this, name, config);
            schema.processors.put(processor.getName(), processor);
        }
    }

    /**
     * Removes a processor from the session schema.
     * @param name The name of the processor to remove
     * @return true if the processor was found and removed, false otherwise
     * @throws IllegalStateException if the processor is not found
     */
    public boolean removeProcessor(String name) {
        synchronized (schema) {
            if (schema.processors.containsKey(name)) {
                Processor processor = schema.processors.remove(name);
                processor.destroy();
                return true;
            }
            return false;
        }
    }


    /**
     * Adds a schema change listener.
     * @param listener The listener to add
     */
    public void addSchemaChangeListener(SchemaChangeListener listener) {
        synchronized (schemaChangeListeners) {
            schemaChangeListeners.add(listener);
        }
        listener.onSchemaChanged();
    }

    /**
     * Removes a schema change listener.
     * @param listener The listener to remove
     * @return true if the listener was found and removed, false otherwise
     */
    public boolean removeSchemaChangeListener(SchemaChangeListener listener) {
        synchronized (schemaChangeListeners) {
            return schemaChangeListeners.remove(listener);
        }
    }

    /**
     * Notifies all registered schema change listeners.
     */
    private void notifySchemaChangeListeners() {
        List<SchemaChangeListener> listenersCopy;
        synchronized (schemaChangeListeners) {
            listenersCopy = new ArrayList<>(schemaChangeListeners);
        }
        for (SchemaChangeListener listener : listenersCopy) {
            listener.onSchemaChanged();
        }
    }
    
    public void saveConfig() throws IOException {
        Path udtaPath = getSchemaFile().toPath();
        String content = new Gson().toJson(schema);
        // TRUNCATE_EXISTING matters: CREATE alone never shortens the file, so
        // a schema that shrank (e.g. a removeProcessor) would leave the old
        // JSON's tail behind and corrupt schema.udta for the next load.
        try {
            Files.writeString(udtaPath, content, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
        } catch (IOException e) {
            Health.noteSessionDirWriteFailed();
            throw e;
        }
        Health.noteSessionDirWrite();
        notifySchemaChangeListeners();
    }

    /**
     * The base directory under which all session directories are created
     * (the session.basePath property, "sessions" by default).
     * @return The configured sessions base directory
     */
    public static File getSessionBaseDir(){
        return new File(sessionBasePath);
    }

    public File getBaseDir(){
        return new File(sessionBasePath+File.separator+this.id);
    }
    private File getSchemaFile(){
        return new File(getBaseDir().getPath()+File.separator+"schema.udta");
    }
    public SessionSchema getSchema(){
        return schema;
    }
    public synchronized String createUniqueMediaContainerResource(String entity, String type, String format, String container){
        if (type.contains("/")||type.contains("..")) throw new IllegalArgumentException("Invalid type"+type);
        if (entity.contains("/")||entity.contains("..")) throw new IllegalArgumentException("Invalid entity"+type);
        if (format.contains("/")||format.contains(".")) throw new IllegalArgumentException("Invalid format"+type);
        if (container.contains("/")||container.contains(".")) throw new IllegalArgumentException("Invalid format"+type);
        int unique = 0;
        File file;
        String resourcePath;
        do {
            resourcePath = type+"_"+entity+"-"+unique+"."+format+"."+container;
            file = new File(getBaseDir().getPath()+File.separator+resourcePath);
            unique++;
        } while (!claimResourceFile(file));

        return resourcePath;
    }

    public synchronized String createUniqueEventStreamResource(String entity, String type, String container){
        if (type.contains("/")||type.contains("..")) throw new IllegalArgumentException("Invalid type"+type);
        if (entity.contains("/")||entity.contains("..")) throw new IllegalArgumentException("Invalid entity"+type);
        if (container.contains("/")||container.contains(".")) throw new IllegalArgumentException("Invalid format"+type);
        int unique = 0;
        File file;
        String resourcePath;
        do {
            resourcePath = type+"_"+entity+"-"+unique+"."+container;
            file = new File(getBaseDir().getPath()+File.separator+resourcePath);
            unique++;
        } while (!claimResourceFile(file));

        return resourcePath;
    }    

    /**
     * Claims a resource name by atomically creating its (still empty) file.
     * File.createNewFile() maps to a single create-if-absent operation
     * (open O_CREAT|O_EXCL) in which checking the name and claiming it is
     * one step, so neither a racing ingest thread nor a second server
     * instance sharing this sessions directory can be handed the same name.
     * A name that is already taken - by a racing writer, another JVM, or a
     * zero-length leftover from a crash - returns false and the caller
     * advances to the next integer. The claimed file is zero-length until
     * the track's writer opens it with its usual truncating
     * FileOutputStream, and every reader already tolerates a zero-length
     * resource (import materializes them).
     * @param file The candidate resource file
     * @return true if the name was free and is now claimed as an empty file;
     *         false if it is already taken, and the caller must try the next
     *         integer
     * @throws IllegalStateException if the file cannot be created for any
     *         other reason (missing session directory, permissions, disk full)
     */
    private boolean claimResourceFile(File file){
        try {
            boolean claimed = file.createNewFile();
            if (claimed) Health.noteSessionDirWrite();
            return claimed;
        } catch (IOException ex) {
            Health.noteSessionDirWriteFailed();
            throw new IllegalStateException("Unable to create the resource file "+file, ex);
        }
    }

    public File resolveRelativePathToFile(String resourcePath){
        if (resourcePath.contains("..")) throw new IllegalArgumentException("Invalid resource path "+resourcePath);
        return new File(getBaseDir().getPath()+File.separator+resourcePath);
    } 
    
    private static final String ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";    
    
    public synchronized String createEventId(){
        eventIdCounter++;

        if (eventIdCounter < 0) {
            throw new IllegalArgumentException("Input value must be non-negative.");
        }
        if (eventIdCounter == 0) {
            return String.valueOf(ALPHABET.charAt(0));
        }

        StringBuilder sb = new StringBuilder();
        long tempValue = eventIdCounter;
        
        while (tempValue > 0) {
            // Append the character corresponding to the remainder (tempValue % BASE)
            sb.append(ALPHABET.charAt((int) (tempValue % 62)));
            // Divide the value by the base for the next iteration
            tempValue /= 62;
        }
        
        // Reverse the string to get the correct order (least significant digit first)
        return sb.reverse().toString();        
    }

    /**
     * Returns the session with the given ID, or null if not found on serverVersion
     * @param sessionId
     * @return A session or null
     */
    public static SessionStorage get(String sessionId){
        synchronized (currentSessions) {
            SessionStorage session = currentSessions.get(sessionId);
            if (session==null){ 
                session = new SessionStorage(sessionId);
                currentSessions.put(sessionId, session);
            } 
            return session;
        }
    }
    
    /**
     * Creates a new session from a client-supplied spec: the processors to
     * install and the models that gather events (see {@link SessionSpec}).
     * The spec is validated as a whole before anything is applied, so an
     * invalid spec never leaves a half-built session behind.
     * @param spec The session spec to build the session from
     * @return The freshly created session
     */
    public static SessionStorage create(SessionSpec spec) {
        String newSessionId = UUID.randomUUID().toString();
        File newDir = new File(sessionBasePath+File.separator+newSessionId);
        if (!newDir.mkdir()) {
            Health.noteSessionDirWriteFailed();
            throw new IllegalStateException("Unable to create a session directory "+newDir);
        }
        Health.noteSessionDirWrite();
        SessionStorage session = SessionStorage.get(newSessionId);
        session.applySpec(spec);
        return session;
    }

    /**
     * Builds this session's setup from a client spec: installs each
     * processor and registers each model.
     * @param spec The session spec to apply
     */
    public void applySpec(SessionSpec spec) {
        if (spec == null) throw new IllegalArgumentException(
            "A session spec is required: {processors:[{name,type,config},...], models:[{name,config:{inputs:{...}}},...]} - see /default-spec.json");
        spec.validate();
        synchronized (schema) {
            for (Processor processor : spec.processors) {
                addProcessor(processor.getName(), processor, processor.getConfig());
            }
            for (SessionSpec.ModelSpec model : spec.models) {
                schema.models.put(model.name, new EventModel(model.name, model.config));
            }
        }
    }

    /**
     * Loads the persisted schema (schema.udta) into this session, if one
     * exists. The processors' saved form is {type, config} keyed by name, so
     * the map key is injected as the name the ProcessorDeserializer adapter
     * expects; models are rebuilt by hand (an EventModel must never be
     * Gson-allocated - its transient final Gson field would stay null). An
     * entry that no longer parses (its processor class vanished, its config
     * is malformed) is kept as a {@link BrokenProcessor} preserving the
     * original JSON verbatim instead of being dropped. Never throws and
     * never saves: a session must always be openable, and nothing has
     * changed worth broadcasting.
     * @return true if a persisted schema was read and applied
     */
    private boolean loadSchema() {
        File schemaFile = getSchemaFile();
        if (!schemaFile.isFile()) return false;
        try {
            JsonObject root = JsonParser.parseString(java.nio.file.Files.readString(schemaFile.toPath())).getAsJsonObject();
            if (root.has("owner")) schema.owner = root.get("owner").getAsString();
            if (root.has("created")) schema.created = root.get("created").getAsLong();
            if (root.has("start") && !root.get("start").isJsonNull()) schema.start = root.get("start").getAsLong();
            if (root.has("end") && !root.get("end").isJsonNull()) schema.end = root.get("end").getAsLong();
            // serverVersion keeps the fresh stamp from the SessionSchema ctor

            // Processors: name-keyed map on disk, but the name is transient -
            // inject the key into the entry so the ProcessorDeserializer
            // adapter (which reads name and type from inside) accepts it.
            Gson reader = ProcessorDeserializer.getReader();
            JsonObject processors = root.getAsJsonObject("processors");
            if (processors != null) for (String name : processors.keySet()) {
                JsonObject entry = processors.getAsJsonObject(name);
                try {
                    JsonObject injectable = entry.deepCopy();
                    injectable.addProperty("name", name);
                    Processor processor = reader.fromJson(injectable, Processor.class);
                    addProcessor(name, processor, processor.getConfig());
                } catch (Throwable ex) {
                    LOGGER.log(Level.SEVERE, "Session "+id+" could not load processor '"+name+"' - keeping it as a BrokenProcessor", ex);
                    String originalType = (entry.has("type") && entry.get("type").isJsonPrimitive()) ? entry.get("type").getAsString() : "(no type)";
                    try {
                        BrokenProcessor broken = new BrokenProcessor(originalType, entry.deepCopy(), String.valueOf(ex));
                        addProcessor(name, broken, broken.getConfig());
                    } catch (Throwable fatal) {
                        LOGGER.log(Level.SEVERE, "Session "+id+" could not even keep processor '"+name+"' as a BrokenProcessor - dropping it", fatal);
                    }
                }
            }

            // Models: never Gson-allocate an EventModel - build each from
            // its key and its ModelConfig.
            JsonObject models = root.getAsJsonObject("models");
            if (models != null) for (String name : models.keySet()) {
                try {
                    EventModel.ModelConfig config = new Gson().fromJson(models.getAsJsonObject(name).get("config"), EventModel.ModelConfig.class);
                    schema.models.put(name, new EventModel(name, config));
                } catch (Throwable ex) {
                    LOGGER.log(Level.SEVERE, "Session "+id+" could not load model '"+name+"' - skipping it", ex);
                }
            }
            return true;
        } catch (Throwable ex) {
            LOGGER.log(Level.WARNING, "Session "+id+" has an unreadable schema.udta - starting with an empty schema", ex);
            return false;
        }
    }


    /**
     * @return the id
     */
    public String getId() {
        return id;
    }
    
    public EventModel getModel(String modelName){
        return schema.models.get(modelName);
    }
       
    public static class SessionSchema {
        public String serverVersion;
        public long created = System.currentTimeMillis();
        public String owner;
        public Long start;
        public Long end;
        public Map<String, Processor> processors = new HashMap<>();
        public Map<String, EventModel> models = new HashMap<>();

        public SessionSchema() {
            try {
                serverVersion = Manifests.read("Implementation-Version");
            } catch (Throwable ex){
                // FIXME: Not writing version info to session schema
            }
        }
    }

    @Override
    public void onTrackStarted(AbstractTrack track) {
      // Notify our processors about new tracks as they load in
      schema.processors.forEach((arg0, processor) -> processor.onTrackAdded(track));
    }
    
    public void onEventAdded(TimedEvent event){
        // Notify processors and models
        schema.models.forEach((arg0, model) -> model.onEventAdded(event));
        schema.processors.forEach((arg0, processor) -> {
            if (processor.matchesStreamType(event.type)) processor.onEventAdded(event);
        });
        synchronized(currentEvents){
            currentEvents.put(event.id, event);
        }
    }
    
    public void onEventUpdated(TimedEvent event){
        // Notify processors and models
        schema.models.forEach((arg0, model) -> model.onEventUpdated(event));
        schema.processors.forEach((arg0, processor) -> {
            if (processor.matchesStreamType(event.type)) processor.onEventUpdated(event);
        });
    }

    public TimedEvent lookupEvent(String id){
        synchronized(currentEvents){
            return currentEvents.get(id);
        }
    }

    public void onStarted() {
        getSchema().start = System.currentTimeMillis();
        try {
            saveConfig();
        } catch (IOException e) {
            LOGGER.log(Level.WARNING, "Session "+id+" could not save its schema.udta on session start", e);
        }
        // TODO: Do something more on session start
    }

    public void onEnded() {
        getSchema().end = System.currentTimeMillis();
        try {
            saveConfig();
        } catch (IOException e) {
            LOGGER.log(Level.WARNING, "Session "+id+" could not save its schema.udta on session end", e);
        }

        // TODO: Do something more on session end
    }    
}
