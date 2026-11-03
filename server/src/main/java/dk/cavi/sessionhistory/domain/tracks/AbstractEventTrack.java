/**
 * Abstract Event Track
 * Base for tracks of timed events: appends incoming events to the track file as
 * JSON and reads them back sequentially, blocking while the track is still
 * live.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain.tracks;

import com.google.gson.Gson;
import com.google.gson.JsonIOException;
import com.google.gson.JsonObject;
import com.google.gson.stream.JsonReader;
import dk.cavi.sessionhistory.domain.SessionStorage;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.UnsupportedEncodingException;
import java.nio.charset.StandardCharsets;

/**
 *
 * @author jbk
 */
public class AbstractEventTrack extends AbstractTrack {    
    public AbstractEventTrack(SessionStorage session, TrackEvent config){
        super(session, config);
    }    

    public class JSONAppender {
        private AbstractTrack track;
        private Gson gson;
        private FileOutputStream outputFileStream;

        JSONAppender(AbstractTrack track) throws FileNotFoundException {
            this.track = track;
            this.gson = new Gson();
            outputFileStream = new FileOutputStream(track.outputFile);
            track.isLive = true;
            AbstractEventTrack.this.onStarted();
        }

        public void append(JsonObject el) throws IOException {
            String content = gson.toJson(el);
            try {
                outputFileStream.write(content.getBytes("utf8"));
            } catch (UnsupportedEncodingException ex) {
                throw new IOException(ex);
            }
        }

        public void close() throws IOException {
            outputFileStream.close();
            AbstractEventTrack.this.onCompleted();
            track.isLive = false;
        }
    }        

    public JSONAppender connectJSONAppender() throws FileNotFoundException {
        return new JSONAppender(this);
    }    
    
    /**
     * Reads and parses JSON elements sequentially from the track's file.
     * The read() method blocks until a complete JsonElement is available.
     * Note: This implementation assumes the input file contains a stream of 
     * *concatenated* JSON objects, not a single JSON array or a large single object.
     */
    public class JSONReader<T> implements AutoCloseable {
        private final JsonReader jsonReader;
        private final TailingInputStream fileInputStream;
        private final Class<T> typeOfT; // <-- Stores the target class        
        private Gson gson;

        JSONReader(AbstractTrack track, Class<T> typeOfT) throws FileNotFoundException, UnsupportedEncodingException {
            // Use the track's inputFile (assuming it exists and is readable)
            File inputFile = track.outputFile;
            if (inputFile == null || !inputFile.exists()) {
                 throw new FileNotFoundException("Input file not found for track: " + track.getSessionRelativePath());
            }

            this.fileInputStream = new TailingInputStream(track);
            
            // InputStreamReader to read bytes as characters (using UTF-8)
            InputStreamReader inputStreamReader = new InputStreamReader(
                    this.fileInputStream, StandardCharsets.UTF_8);
            
            // JsonReader handles the low-level parsing logic
            this.jsonReader = new JsonReader(inputStreamReader);
            
            // Since the JSONAppender writes concatenated objects (not an array),
            // we enable lenient mode to allow objects to be written consecutively
            // without being separated by commas and enclosed in an array.
            this.jsonReader.setLenient(true); 
            this.typeOfT = typeOfT;
            this.gson = new Gson();
        }
        
        /**
         * Reads the next complete JsonElement from the stream.
         * This method will block if the file has not yet been fully written 
         * up to the next complete object boundary.
         * * @return The next complete JsonElement, or null if the stream is exhausted.
         * @throws IOException If a reading error occurs.
         */
        public T read() throws IOException {
            try {
                // Check if the stream has reached its end
                if (jsonReader.peek() == com.google.gson.stream.JsonToken.END_DOCUMENT) {
                    return null; 
                }
                
                // parse the next value; this call blocks until a complete 
                // JsonElement (object, array, primitive) is available.
                return gson.fromJson(jsonReader, typeOfT);
            } catch (JsonIOException e) {
                // Wrap Gson exceptions in a standard IOException
                throw new IOException("Error reading JSON element from stream.", e);
            } catch (com.google.gson.JsonParseException e) {
                 // Handles syntax errors or stream exhaustion mid-object
                 throw new IOException("Error parsing JSON element. Stream corruption or incomplete object.", e);
            }
        }

        public void close() throws IOException {
            // Close the JsonReader, which also closes the underlying InputStreamReader and FileInputStream
            jsonReader.close();
        }
    }

    public <T> JSONReader<T> connectJSONReader(Class<T> typeOfT) throws FileNotFoundException, UnsupportedEncodingException {
        return new JSONReader(this, typeOfT);
    }    
}
