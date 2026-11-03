/**
 * TEN VAD Native Interface
 * JNA interface mapping the ten-vad C API (create, process, destroy, version).
 *
 * Copyright (c) 2025 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.interoperability;

import com.sun.jna.Library;
import com.sun.jna.Native;
import com.sun.jna.Pointer;
import com.sun.jna.ptr.FloatByReference;
import com.sun.jna.ptr.IntByReference;
import com.sun.jna.ptr.PointerByReference;

/**
 * JNA interface mapping directly to the ten-vad C API.
 * The native library must be accessible (e.g., in the system path or specified
 * via the 'jna.library.path' system property).
 * @author jbk
 */
public interface TenVADNative extends Library {
    // Load libten_vad from the system library path (see README: Native installation)
    TenVADNative INSTANCE = Native.load("ten_vad", TenVADNative.class);

    /**
     * int ten_vad_create(ten_vad_handle_t* handle, size_t hop_size, float threshold)
     */
    int ten_vad_create(PointerByReference handle, int hop_size, float threshold);

    /**
     * int ten_vad_process(ten_vad_handle_t handle,
     * const int16_t* audio_data,
     * size_t audio_data_length,
     * float* out_probability,
     * int* out_flag)
     *
     * In JNA, we use Pointer for the 'handle' once it's created,
     * Pointer for the 'audio_data' buffer, and references for the outputs.
     */
    int ten_vad_process(Pointer handle,
                        Pointer audio_data, // Use Pointer to map to const int16_t*
                        int audio_data_length,
                        FloatByReference out_probability,
                        IntByReference out_flag);

    /**
     * int ten_vad_destroy(ten_vad_handle_t* handle)
     */
    int ten_vad_destroy(PointerByReference handle);

    /**
     * const char* ten_vad_get_version(void)
     */
    String ten_vad_get_version();
}