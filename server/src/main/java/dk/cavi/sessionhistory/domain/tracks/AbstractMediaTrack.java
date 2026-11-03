/**
 * Abstract Media Track
 * Base for binary media tracks: records GStreamer AppSink buffers into the
 * track file and streams a live or completed track back out through an AppSrc
 * that tails the growing file.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain.tracks;

import dk.cavi.sessionhistory.domain.SessionStorage;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.util.logging.Level;
import java.util.logging.Logger;
import org.freedesktop.gstreamer.Buffer;
import org.freedesktop.gstreamer.Caps;
import org.freedesktop.gstreamer.FlowReturn;
import org.freedesktop.gstreamer.Format;
import org.freedesktop.gstreamer.Sample;
import org.freedesktop.gstreamer.elements.AppSink;
import org.freedesktop.gstreamer.elements.AppSrc;

/**
 *
 * @author jbk
 */
public class AbstractMediaTrack extends AbstractTrack {    
    private static final Logger LOGGER = Logger.getLogger(AbstractMediaTrack.class.getName());

    public AbstractMediaTrack(SessionStorage session, TrackEvent config){
        super(session, config);
    }
    
    public void connectSink(AppSink appSink) throws FileNotFoundException {
        isLive = true;
        FileOutputStream outputFileStream = new FileOutputStream(outputFile);
        FileChannel outputFileChannel = outputFileStream.getChannel();
        onStarted();

        // Configure AppSink for Push Mode
        appSink.set("emit-signals", true);
        appSink.connect((AppSink.NEW_SAMPLE) s -> {
            Sample sample = s.pullSample();
            if (sample == null) {
                return FlowReturn.OK;
            }

            // Map the GStreamer buffer to a Java ByteBuffer for access
            Buffer buffer = sample.getBuffer();
            ByteBuffer byteBuffer = buffer.map(false); // false for read-only

            try {
                // Write the data to the file
                outputFileChannel.write(byteBuffer);
                liveBytesWritten += byteBuffer.capacity();
            } catch (IOException e) {
                LOGGER.log(Level.SEVERE, "Failed to write media data to the track file " + outputFile, e);
            } finally {
                // CRITICAL: Unmap and dispose of the buffer/sample after use
                buffer.unmap();
                sample.dispose();
            }
            return FlowReturn.OK;
        });

        // Connect the EOS listener to cleanly close the file
        appSink.connect((AppSink.EOS) s -> {
            try {
                outputFileStream.close();
                isLive = false;
                LOGGER.fine("TrackResource " + outputFile.toString() + " closed successfully.");
                onCompleted();
            } catch (IOException e) {
                LOGGER.log(Level.SEVERE, "Failed to close the track file " + outputFile, e);
            }
        });
    }

    public void connectSource(AppSrc source) {
        // STUB: connectSource() currently only provides a filesystem view of Track, which lags 
        // behind with ~250ms due to muxing frame size and fs ops
        int CHUNK_SIZE = 4096;
        int WAIT_TIME_MS = 25;
        source.set("emit-signals", false);
        source.set("block", true);
        source.set("format", Format.TIME);
        source.setStreamType(AppSrc.StreamType.STREAM);
        source.setCaps(Caps.fromString("video/x-matroska"));
        
        Thread sourceReader = new Thread() {
            @Override
            public void run() {
                try (RandomAccessFile raf = new RandomAccessFile(outputFile, "r");
                    FileChannel channel = raf.getChannel()) {
                    Thread.sleep(100);

                    // Buffer to hold data read from the file
                    ByteBuffer byteBuffer = ByteBuffer.allocate(CHUNK_SIZE);

                    // Loop while the thread is running
                    while (!Thread.interrupted()) {
                        // 1. Position the channel and attempt to read
                        byteBuffer.position(0);
                        byteBuffer.limit(CHUNK_SIZE);
                        int bytesRead = channel.read(byteBuffer);

                        if (bytesRead > 0) {
                            
                            // 2. Data available: Wrap data in a GStreamer Buffer and push
                            byteBuffer.flip();

                            Buffer gstBuffer = new Buffer(bytesRead);
                            gstBuffer.map(true).put(0, byteBuffer, 0, bytesRead);
                            FlowReturn ret = source.pushBuffer(gstBuffer);

                            if (ret != FlowReturn.OK) {
                                LOGGER.severe("AppSrc push failed: " + ret);
                                throw new IOException("Cannot push to AppSrc");
                            }
                        } else { // bytesRead == -1 (EOF) or 0 (no data read)
                            // Check for the termination condition
                            if (!isLive) {
                                LOGGER.fine("TrackResource "+event.track+" ended. Closing an AppSrc that was listening to it");
                                return;
                            } else {
                                // Live mode: Wait and loop forever
                                Thread.sleep(WAIT_TIME_MS);
                            }
                        }
                    }
                } catch (Exception e) {
                    LOGGER.log(Level.SEVERE, "The source reading thread for track " + event.track + " failed", e);
                } finally {
                    source.endOfStream(); // Send EOS when thread exits
                    LOGGER.fine("Source reading thread ended");
                }
            }            
        };
        sourceReader.start();
    }
}
