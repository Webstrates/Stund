/**
 * Server Configuration
 * Server configuration model holding the WebRTC settings (ICE servers and RTP
 * port range), the named OpenAI-compatible connections used by the AI
 * processors, and the server-wide AI defaults (models) those processors fall
 * back to.
 *
 * Copyright (c) 2025 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.core;

import java.util.HashMap;
import java.util.Map;

/**
 *
 * @author jbk
 */
public class ServerConfig {
    public WebRTCConfig webrtc = new WebRTCConfig();
    public Map<String, OpenAIConnection> openAIConnections = new HashMap<>();
    public AIConfig ai = new AIConfig();

    // All nested classes below are STATIC on purpose: Core deserializes
    // ServerConfig from config.json with Gson, and for non-static inner
    // classes Gson cannot call the no-arg constructor (it only exists with
    // a synthetic enclosing-instance parameter), so it falls back to
    // Unsafe allocation - which skips the field initializers and turns
    // every key config.json leaves out into null. The no-arg constructor
    // of a static class runs the initializers, so absent keys keep the
    // built-in defaults below.
    public static class WebRTCConfig {
        public String[] iceServers = {
            "stun://stun.l.google.com:19302"
        };
        public int minRTPPort = 60000;
        public int maxRTPPort = 61000;
    }

    /**
     * Server-wide AI defaults, used by AI processors whose own configuration
     * names no model: AbstractAIProcessor.OpenAIBaseConfig resolves its
     * "model" from defaultModel, and the transcription processor from
     * defaultTranscriptionModel. The processors' default connection is the
     * openAIConnections entry named "default".
     */
    public static class AIConfig {
        public String defaultModel = "gpt-4o-mini";
        public String defaultTranscriptionModel = "whisper-1";
    }

    public static class OpenAIConnection {
        public String url;
        public String key;
    }

    /**
     * The auth layer: every /session request must present an entityKey
     * minted at /login proving ownership of the entity id it acts as. With
     * no masterPassword configured no key can ever be minted, so the
     * service rejects everything — see the README's authentication section.
     */
    public static class AuthConfig {
        /** The master password; POSTing it to /login mints an entityKey for any entity id. */
        public String masterPassword = null;
        /** How long minted entity tokens live, in days (fractional days allowed). */
        public double tokenLifetimeDays = 7.0;
        /** Directory holding the token files, resolved against the working directory. */
        public String tokenPath = "tokens";
    }

    /** The auth settings (see {@link AuthConfig}) — the master password mints entityKeys at /login. */
    public AuthConfig auth = new AuthConfig();
}
