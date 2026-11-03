/**
 * TEN VAD Wrapper
 * High-level Java wrapper for the native ten-vad voice activity detector:
 * manages detector lifetime and processes PCM audio frames into speech
 * probabilities and flags.
 *
 * Copyright (c) 2025 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.interoperability;

import java.nio.ByteBuffer;

import com.sun.jna.Memory;
import com.sun.jna.Native;
import com.sun.jna.Pointer;
import com.sun.jna.ptr.FloatByReference;
import com.sun.jna.ptr.IntByReference;
import com.sun.jna.ptr.PointerByReference;

/**
 * High-level Java wrapper for the ten-vad library.
 * Handles native memory allocation and automatic cleanup via a finalizer.
 * @author jbk
 */
public class TenVAD {
    private final TenVADNative nativeLib;
    private Pointer vadHandle = null;

    // Output holders for the process call
    private final FloatByReference probabilityRef = new FloatByReference();
    private final IntByReference flagRef = new IntByReference();
    private final PointerByReference handleRef = new PointerByReference();

    /**
     * Creates a new TenVAD instance.
     * @param hopSize The frame size (e.g., 256 for 16ms at 16kHz).
     * @param threshold The VAD probability threshold (0.0 to 1.0).
     * @throws IllegalStateException if the native VAD object creation fails.
     */
    public TenVAD(int hopSize, float threshold) {
        this.nativeLib = TenVADNative.INSTANCE;

        int result = nativeLib.ten_vad_create(handleRef, hopSize, threshold);

        if (result != 0) {
            throw new IllegalStateException("Failed to create ten_vad instance. Error code: " + result);
        }

        this.vadHandle = handleRef.getValue();
    }

    /**
     * Processes a single audio frame and detects voice activity.
     * The input audio buffer MUST contain 16-bit PCM (short) data at 16kHz.
     *
     * @param audioData The audio buffer (e.g., a short[] array of size 'hopSize').
     * @return A VADResult containing the probability and a binary flag.
     * @throws IllegalStateException if the handle is invalid or processing fails.
     */
    public VADResult process(short[] audioData) {
        if (vadHandle == null) {
            throw new IllegalStateException("TenVAD instance has been destroyed or was never created.");
        }

        // 1. Allocate native memory and copy the short[] array data
        // size: number of shorts * size of a short (2 bytes)
        Memory audioBuffer = new Memory((long) audioData.length * 2);
        audioBuffer.write(0, audioData, 0, audioData.length);
        return process(audioBuffer, audioData.length);
    }

    /**
     * Processes a single audio frame and detects voice activity.
     * The input audio buffer MUST contain 16-bit PCM (short) data at 16kHz.
     *
     * @param audioBuffer The audio buffer (e.g., a short[] array of size 'hopSize').
     * @return A VADResult containing the probability and a binary flag.
     * @throws IllegalStateException if the handle is invalid or processing fails.
     */
    public VADResult process(ByteBuffer audioBuffer, int samples) {
        if (vadHandle == null) {
            throw new IllegalStateException("TenVAD instance has been destroyed or was never created.");
        }  
        return process(Native.getDirectBufferPointer(audioBuffer), samples);
    }    

    /**
     * Processes a single audio frame and detects voice activity.
     * The input audio buffer MUST contain 16-bit PCM (short) data at 16kHz.
     *
     * @param audio The audio pointer to a (e.g., a short[] array of size 'hopSize').
     * @return A VADResult containing the probability and a binary flag.
     * @throws IllegalStateException if the handle is invalid or processing fails.
     */
    public VADResult process(Pointer audio, int samples) {
        if (vadHandle == null) {
            throw new IllegalStateException("TenVAD instance has been destroyed or was never created.");
        }  

        // Call the native process function
        int result = nativeLib.ten_vad_process(
            vadHandle,
            audio,
            samples,
            probabilityRef,
            flagRef
        );

        if (result != 0) {
            throw new IllegalStateException("ten_vad_process failed with error code: " + result);
        }
        return new VADResult(
            probabilityRef.getValue(),
            flagRef.getValue() == 1 // Convert int flag to boolean
        );
    }

    /**
     * Destroys the native VAD object and frees resources.
     * This should be called explicitly when you are finished with the object.
     */
    public synchronized void destroy() {
        if (vadHandle != null) {
            // The C function expects a pointer to the handle (PointerByReference)
            handleRef.setValue(vadHandle);
            nativeLib.ten_vad_destroy(handleRef);
            vadHandle = null; // Mark as destroyed
        }
    }

    /**
     * Gets the version string of the underlying ten-vad library.
     */
    public static String getVersion() {
        return TenVADNative.INSTANCE.ten_vad_get_version();
    }

    /**
     * Ensures native resources are freed if the object is garbage collected
     * without an explicit call to destroy().
     */
    @Override
    protected void finalize() throws Throwable {
        destroy();
    }

    // --- Inner Class for VAD Results ---

    public static class VADResult {
        public final float probability;
        public final boolean isSpeech;

        public VADResult(float probability, boolean isSpeech) {
            this.probability = probability;
            this.isSpeech = isSpeech;
        }
        
        @Override
        public String toString() {
            return "Probability: " + String.format("%.4f", probability) + ", IsSpeech: " + isSpeech;
        }
    }
}