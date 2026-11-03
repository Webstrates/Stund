/**
 * Tailing Input Stream
 * InputStream over a track file that blocks at end-of-file while the track is
 * still being written and only reports EOF once it is completed, enabling live
 * tailing of growing files.
 *
 * Copyright (c) 2025 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain.tracks;

import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.io.FileNotFoundException;

/**
 *
 * @author jbk
 */
public class TailingInputStream extends InputStream {
    
    private final AbstractTrack track;
    private final RandomAccessFile raf; 
    
    // Polling interval when EOF is hit
    private static final long POLL_INTERVAL_MS = 50; 

    /**
     * Creates a TailingRandomAccessStream.
     * @param track The associated track providing live status and written byte count.
     * @throws FileNotFoundException if the file does not exist.
     */
    public TailingInputStream(AbstractTrack track) throws FileNotFoundException {
        this.track = track;
        // Open in "r" (read) mode
        this.raf = new RandomAccessFile(track.outputFile, "r"); 
    }

    // --- Core Blocking Read Methods ---

    /**
     * Reads the next byte of data from this input stream.
     * Implements the custom blocking/tailing logic.
     * @return the next byte of data, or -1 if the end of the stream is reached.
     * @throws IOException if an I/O error occurs.
     */
    @Override
    public int read() throws IOException {
        byte[] buffer = new byte[1];
        int count = read(buffer, 0, 1);
        
        return (count == -1) ? -1 : (buffer[0] & 0xFF);
    }
    
    /**
     * Reads up to len bytes of data into an array of bytes.
     * Implements the custom blocking/tailing logic.
     * @return the total number of bytes read into the buffer, or -1 if there is no more data.
     * @throws IOException if an I/O error occurs.
     */
    @Override
    public int read(byte[] b, int off, int len) throws IOException {
        if (len < 0 || off < 0 || (long)off + len > b.length) {
            throw new IndexOutOfBoundsException();
        }
        if (len == 0) {
            return 0;
        }

        while (true) {
            long currentPos = raf.getFilePointer();
            long fileLength = raf.length();
            
            // 1. Check if we have hit the end of the file
            if (currentPos >= fileLength) {
                // We're at the end. Check live status.
                
                if (track.isLive) {
                    // 1a. Track is LIVE: Block and retry.
                    try {
                        Thread.sleep(POLL_INTERVAL_MS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        throw new IOException("Tailing interrupted.", e);
                    }
                    continue; // Loop and retry read
                } else {
                    // 1b. Track is NOT LIVE: Report final EOF.
                    return -1;
                }
            }
            
            // 2. Data is available (currentPos < fileLength)
            // Determine how many bytes we can actually read (max 'len' or to the end of file)
            int bytesToRead = (int) Math.min(len, fileLength - currentPos);
            
            // Perform the read operation
            int bytesRead = raf.read(b, off, bytesToRead);
            
            // Check for successful read (shouldn't be -1 if currentPos < fileLength)
            if (bytesRead > 0) {
                return bytesRead;
            } 
            
            // If bytesRead is 0 or less despite currentPos < fileLength, it's an anomaly.
            // Reset position and retry or break, but standard RAF should return > 0 here.
            if (bytesRead == -1) {
                 // Should technically not happen when length check passes, but defensive programming
                 return -1;
            }
        }
    }

    // --- Cleanup and Utility Methods ---

    /**
     * Closes this random access file stream and releases any system resources
     * associated with the stream.
     * @throws IOException if an I/O error occurs.
     */
    @Override
    public void close() throws IOException {
        raf.close();
    }
    
    /**
     * Returns an estimate of the number of bytes that can be read 
     * from this input stream without blocking.
     * @return the number of bytes available.
     * @throws IOException if an I/O error occurs.
     */
    @Override
    public int available() throws IOException {
        long available = raf.length() - raf.getFilePointer();
        return available > Integer.MAX_VALUE ? Integer.MAX_VALUE : (int)available;
    }
}