/**
 * Abstract Track
 * Base of all recorded tracks: persists track metadata in a .udta sidecar next
 * to the data file, tracks live and completed state with listener callbacks,
 * and deserializes tracks back from disk.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain.tracks;

import com.google.gson.ExclusionStrategy;
import com.google.gson.FieldAttributes;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.List;
import java.util.logging.Logger;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonDeserializationContext;
import com.google.gson.JsonDeserializer;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;

import dk.cavi.sessionhistory.domain.SessionStorage;
import dk.cavi.sessionhistory.domain.model.Meta;
import dk.cavi.sessionhistory.domain.model.TimedEvent;
import dk.cavi.sessionhistory.domain.tracks.data.TrackData;
import java.io.FileReader;
import java.io.Reader;
import java.lang.reflect.Type;

/**
 *
 * @author jbk
 */
public abstract class AbstractTrack {
    private static final Logger LOGGER = Logger.getLogger(AbstractTrack.class.getName());
    private String type = this.getClass().getSimpleName();
    protected transient File outputFile;
    protected TrackEvent event;
    protected transient long liveBytesWritten = 0;
    protected transient boolean isLive = false;
    private transient boolean started;
    private transient boolean completed;
    private transient List<TrackStarted> startedListeners = new ArrayList<>();
    private transient List<TrackCompleted> completedListeners = new ArrayList<>();

    protected AbstractTrack(SessionStorage storageSession, TrackEvent event) {
        this.event = event;
        this.outputFile = storageSession.resolveRelativePathToFile(event.track.resource);
        registerTrackStartedListener(storageSession);
    }

    public void saveConfig() throws IOException {
        Path udtaPath = outputFile.toPath().resolveSibling(outputFile.toPath().getFileName() + ".udta");
        String content = new Gson().toJson(this);
        Files.writeString(udtaPath, content, StandardOpenOption.CREATE);
    }

    public String getSessionRelativePath() {
        return event.track.resource;
    }
    
    public TrackEvent event(){
        return event;
    }

    public TrackData metadata(){
        return (TrackData) this.event.track;
    }
    
    public void registerTrackCompletedListener(TrackCompleted callback){
        if (completed) callback.onTrackCompleted(this);
        synchronized (completedListeners) {
            completedListeners.add(callback);
        }
    }
    public void registerTrackStartedListener(TrackStarted callback){
        if (started) callback.onTrackStarted(this);
        synchronized (completedListeners) {
            startedListeners.add(callback);
        }
    }    
    
    public void onCompleted(){
        if (completed) {
            LOGGER.warning("Ignoring duplicate onCompleted callback for track "+this);
            return;
        }
        completed = true;
        synchronized (completedListeners){
            completedListeners.forEach(listener -> listener.onTrackCompleted(this));
        }
    }
    public void onStarted(){
        if (started) {
            LOGGER.warning("Ignoring duplicate onStarted callback for track "+this);
            return;
        }
        started = true;
        synchronized (completedListeners){
            startedListeners.forEach(listener -> listener.onTrackStarted(this));
        }
    }    

    public TailingInputStream getTailingInputStream() throws FileNotFoundException{
        return new TailingInputStream(this);
    }

    public interface TrackCompleted {
        public void onTrackCompleted(AbstractTrack track);
    }
    public interface TrackStarted {
        public void onTrackStarted(AbstractTrack track);
    }    
    
    public static AbstractTrack fromRelativeResource(SessionStorage session, String path){
        File file = session.resolveRelativePathToFile(path);
        if (file==null) throw new IllegalArgumentException("Invalid resource specifier "+path);
        if (!file.exists()) throw new IllegalArgumentException("No such resource "+path+" in "+session.getId());

        // Locate the .udta file next to the given resource
        File udtaFile = new File(file.getParent(), file.getName() + ".udta");
        if (!udtaFile.exists()) throw new IllegalArgumentException("Metadata file not found: " + udtaFile.getAbsolutePath());

        // Deserialize UDTA into a track
        try (Reader reader = new FileReader(udtaFile)) {
            AbstractTrack track = TrackDeserializer.getReader(session).fromJson(reader, AbstractTrack.class);
            if (track == null) {
                throw new RuntimeException("Failed to deserialize track from " + udtaFile.getName());
            }
            return track;
        } catch (IOException e) {
            throw new RuntimeException("Error reading .udta file: " + udtaFile.getPath(), e);
        }        
    }
    
    private static class TrackDeserializer implements JsonDeserializer<AbstractTrack> {
        private static final String PREFIX = "dk.cavi.sessionhistory.domain.tracks.";
        private final SessionStorage session;

        public TrackDeserializer(SessionStorage session) {
            this.session = session;
        }
        
        @Override
        public AbstractTrack deserialize(JsonElement json, Type typeOfT, JsonDeserializationContext context)
                throws JsonParseException {

            JsonObject jsonObject = json.getAsJsonObject();

            // Get the class name from the "type" field
            String typeName = jsonObject.get("type").getAsString();
            String fullClassName = PREFIX + typeName;

            try {
                Class<?> clazz = Class.forName(fullClassName);

                // Create the instance
                AbstractTrack readTrack = context.deserialize(json, clazz);
                readTrack.outputFile = session.resolveRelativePathToFile(readTrack.event.track.resource);

                // FIXME: Properly deserialize tracks loaded from disk
                return readTrack;
            } catch (Exception e) {
                throw new JsonParseException("Failed to deserialize track of type: " + typeName, e);
            }
        }
        
        public static Gson getReader(SessionStorage session){
            return new GsonBuilder()
                .registerTypeAdapter(AbstractTrack.class, new TrackDeserializer(session))
                .registerTypeAdapter(TrackEvent.class, new TrackEventDeserializer())
                .setExclusionStrategies(new ExclusionStrategy() {
                    @Override
                    public boolean shouldSkipField(FieldAttributes f) {
                        return TrackData.class.isAssignableFrom(f.getDeclaringClass()) && f.getName().equals("track");
                    }

                    @Override
                    public boolean shouldSkipClass(Class<?> clazz) {
                        return false;
                    }
                })                      
                .create();
        }        
    }    

    private static class TrackEventDeserializer implements JsonDeserializer<TrackEvent> {
        private static final String META_DATA_PREFIX = "dk.cavi.sessionhistory.domain.tracks.data.";
    
        @Override
        public TrackEvent deserialize(JsonElement json, Type typeOfT, JsonDeserializationContext context)
                throws JsonParseException {
            JsonObject jsonObject = json.getAsJsonObject();

            String trackType = jsonObject.get("trackMetaType").getAsString();
            String fullClassName = META_DATA_PREFIX + trackType;

            try {
                Class<?> metaDataClass = Class.forName(fullClassName);

                // Deserialize the track field with the specific concrete type
                TrackData track = context.deserialize(jsonObject.get("track"), metaDataClass);

                // Read compatibility with pre-rename recordings: the resource
                // field used to be persisted under its old spelling,
                // "ressource" — accept it when the new name is absent so
                // sessions recorded before the rename keep replaying.
                JsonElement trackJson = jsonObject.get("track");
                if (track.resource == null && trackJson != null && trackJson.isJsonObject()) {
                    JsonElement legacyResource = trackJson.getAsJsonObject().get("ressource");
                    if (legacyResource != null && legacyResource.isJsonPrimitive()) {
                        track.resource = legacyResource.getAsString();
                    }
                }

                // Deserialize the rest of the event fields
                TrackEvent event = new GsonBuilder()
                .setExclusionStrategies(new ExclusionStrategy() {
                    @Override
                    public boolean shouldSkipField(FieldAttributes f) {
                        return TrackData.class.isAssignableFrom(f.getDeclaringClass()) && f.getName().equals("track");
                    }

                    @Override
                    public boolean shouldSkipClass(Class<?> clazz) {
                        return false;
                    }
                })                      
                .create().fromJson(json, TrackEvent.class);

                // Set the properly deserialized track
                event.track = track;
                return event;
            } catch (ClassNotFoundException e) {
                throw new JsonParseException("Unknown track metadata type: " + trackType, e);
            }
        }
    }
    
    public static class TrackEvent extends TimedEvent {
        @Meta
        public TrackData track;

        @Meta
        public String trackMetaType;

        public TrackEvent(String streamType, String id, TrackData trackData){
            super(streamType,id);
            this.start = created; // STUB
            this.track = trackData;
            this.trackMetaType = trackData.getClass().getSimpleName();
        }
    }
}
