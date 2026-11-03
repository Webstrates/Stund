/**
 * Health
 * The server's self-observations for the /health endpoint: a set of
 * booleans and counters that the rest of the server maintains as a side
 * effect of doing its usual work (the startup self-tests and probes, the
 * session-directory writes, a slow background refresh), and that the
 * health servlet reads back request-time without touching the file
 * system or anything else that could be burdened by polling.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.core;

import dk.cavi.sessionhistory.domain.SessionStorage;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.FileStore;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 *
 * @author jbk
 */
public final class Health {
    private static final Logger LOGGER = Logger.getLogger(Health.class.getName());

    /** The sessions directory is expected to keep at least this much usable space (1 GiB). */
    public static final long MIN_USABLE_SESSION_DIR_BYTES = 1024L * 1024 * 1024;

    /** How often the background refresh re-reads the sessions-directory state (60s). */
    private static final long REFRESH_INTERVAL_MS = 60_000;

    // ── startup observations (written once, by Main while booting) ──────────
    private static volatile long startedAtMillis = 0;
    private static volatile boolean selfTestPassed = false;
    private static volatile boolean gstreamerInitialized = false;
    private static volatile boolean tenVadLoaded = false;
    private static volatile boolean warmupCompleted = false;
    private static volatile boolean sessionDirWritable = false;
    private static volatile boolean tokensDirWritable = false;
    private static volatile boolean authConfigured = false;

    // ── runtime observations (written by session-directory work) ────────────
    private static volatile boolean lastSessionWriteOk = true; // no failure observed yet
    private static volatile long lastSessionWriteAtMillis = 0;
    private static volatile long sessionDirUsableBytes = -1;

    private static final AtomicBoolean backgroundRefreshStarted = new AtomicBoolean(false);

    private Health() { /* static only */ }

    // ── setters, called by the parts of the server that observe the facts ───

    /** The startup probes: the sessions base directory accepted a write. */
    public static void noteSessionDirWritable(boolean ok) { sessionDirWritable = ok; }

    /** The startup probes: the tokens directory was created and is writable. */
    public static void noteTokensDirWritable(boolean ok) { tokensDirWritable = ok; }

    /** Whether a master password is configured (without one, nobody can log in). */
    public static void noteAuthConfigured(boolean ok) { authConfigured = ok; }

    /** GStreamer initialized successfully at startup. */
    public static void noteGStreamerInitialized(boolean ok) { gstreamerInitialized = ok; }

    /** The TEN VAD library loaded and passed its startup test. */
    public static void noteTenVadLoaded(boolean ok) { tenVadLoaded = ok; }

    /** The full startup self-test (GStreamer elements + TEN VAD) passed. */
    public static void noteSelfTestPassed(boolean ok) { selfTestPassed = ok; }

    /** The one-time warm-up (processor discovery, script engine, ingest path) completed. */
    public static void noteWarmupCompleted(boolean ok) { warmupCompleted = ok; }

    /** The server finished starting; stamps the uptime origin. */
    public static void noteStarted() { startedAtMillis = System.currentTimeMillis(); }

    /**
     * A successful write into the sessions directory during normal operation
     * (a session directory created, a schema saved, a resource file claimed).
     * Also refreshes the usable-space observation — the statfs is done on the
     * write path, never on the request path.
     */
    public static void noteSessionDirWrite() {
        lastSessionWriteOk = true;
        lastSessionWriteAtMillis = System.currentTimeMillis();
        refreshUsableSpace();
    }

    /**
     * A successful session-directory write on a hot path (an event appended
     * to a track, a media buffer written, a track sidecar saved). Deliberately
     * skips the usable-space refresh: a statfs per appended event would be a
     * real cost, so the space observation is left to the slow paths and the
     * background refresh.
     */
    public static void noteSessionDirWriteSeen() {
        lastSessionWriteOk = true;
        lastSessionWriteAtMillis = System.currentTimeMillis();
    }

    /** A session-directory write failed — the failure itself is handled (or
     * rethrown) by the caller; this only records it for the health report. */
    public static void noteSessionDirWriteFailed() {
        lastSessionWriteOk = false;
        refreshUsableSpace();
    }

    // ── the report ───────────────────────────────────────────────────────────

    /** "ok" when every observation is green, "degraded" otherwise. */
    public static String overallStatus() {
        boolean ok = selfTestPassed && gstreamerInitialized && tenVadLoaded && warmupCompleted
            && sessionDirWritable && has1GBFree() && lastSessionWriteOk
            && tokensDirWritable && authConfigured && startedAtMillis > 0;
        return ok ? "ok" : "degraded";
    }

    /** Whether the sessions directory keeps at least {@link #MIN_USABLE_SESSION_DIR_BYTES} usable. */
    public static boolean has1GBFree() {
        return sessionDirUsableBytes >= MIN_USABLE_SESSION_DIR_BYTES;
    }

    /**
     * The current report as a small JSON document. Pure in-memory reads of the
     * fields above — no file system, no locks, no allocation beyond the string
     * itself — so polling it cannot burden the server. All values are
     * booleans, longs or the two fixed status words, so no JSON escaping is
     * needed. Every field is first captured into a local, so the document
     * describes one consistent moment and its own status can never contradict
     * its fields (a check that flips between two reads would otherwise make
     * the body self-contradicting). "status" is deliberately the first key:
     * HealthServlet decides the HTTP status code from the same serialization,
     * so the code and the body can never disagree either.
     */
    public static String snapshotJson() {
        // one consistent moment…
        final long now = System.currentTimeMillis();
        final boolean selfTest = selfTestPassed;
        final boolean gst = gstreamerInitialized;
        final boolean vad = tenVadLoaded;
        final boolean warm = warmupCompleted;
        final boolean dirWritable = sessionDirWritable;
        final boolean tokens = tokensDirWritable;
        final boolean auth = authConfigured;
        final boolean writeOk = lastSessionWriteOk;
        final long startedAt = startedAtMillis;
        final long usable = sessionDirUsableBytes;
        final boolean hasSpace = usable >= MIN_USABLE_SESSION_DIR_BYTES;
        final long writeAge = lastSessionWriteAtMillis > 0 ? (now - lastSessionWriteAtMillis) / 1000 : -1;
        final long uptime = startedAt > 0 ? Math.max(0, (now - startedAt) / 1000) : 0;
        final boolean ok = selfTest && gst && vad && warm && dirWritable && hasSpace
                && writeOk && tokens && auth && startedAt > 0;
        // …described in one pass
        return "{\"status\":\"" + (ok ? "ok" : "degraded") + "\""
            + ",\"uptimeSeconds\":" + uptime
            + ",\"selfTestPassed\":" + selfTest
            + ",\"gstreamerInitialized\":" + gst
            + ",\"tenVadLoaded\":" + vad
            + ",\"warmupCompleted\":" + warm
            + ",\"authConfigured\":" + auth
            + ",\"tokensDirWritable\":" + tokens
            + ",\"sessionDirWritable\":" + dirWritable
            + ",\"sessionDirHas1GBFree\":" + hasSpace
            + ",\"sessionDirUsableBytes\":" + usable
            + ",\"lastSessionWriteOk\":" + writeOk
            + ",\"lastSessionWriteAgeSeconds\":" + writeAge
            + "}";
    }

    // ── the slow background refresh ──────────────────────────────────────────

    /**
     * Starts the single background refresh thread: once a minute it re-reads
     * the sessions directory's usable space and writability, so the report
     * stays truthful during long idle stretches where no session write would
     * otherwise refresh it. One statfs plus one access check per minute —
     * negligible — and still zero file-system work on the request path.
     */
    public static void startBackgroundRefresh() {
        if (!backgroundRefreshStarted.compareAndSet(false, true)) return;
        Thread ticker = new Thread(() -> {
            while (true) {
                try {
                    Thread.sleep(REFRESH_INTERVAL_MS);
                    refreshSessionDirState();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return; // server shutdown
                } catch (Throwable t) {
                    LOGGER.log(Level.WARNING, "Health background refresh failed (will retry)", t);
                }
            }
        }, "shs-health-refresh");
        ticker.setDaemon(true);
        ticker.start();
    }

    /** Re-reads usable space and writability of the sessions base directory. */
    public static void refreshSessionDirState() {
        File baseDir = SessionStorage.getSessionBaseDir();
        sessionDirWritable = baseDir.isDirectory() && Files.isWritable(baseDir.toPath());
        refreshUsableSpace();
    }

    /** Reads the sessions base directory's usable space; -1 when unavailable. */
    private static void refreshUsableSpace() {
        try {
            FileStore store = Files.getFileStore(SessionStorage.getSessionBaseDir().toPath());
            sessionDirUsableBytes = store.getUsableSpace();
        } catch (Exception e) {
            sessionDirUsableBytes = -1;
        }
    }
}
