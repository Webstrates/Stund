/**
 * Session Archival
 * Exports a complete session directory as a single standards-compliant MP4
 * file (ISO/IEC 14496-12) and imports it back byte-exactly, using the
 * external MP4Box CLI from GPAC.
 *
 * The export reuses the metadata the session directory already carries
 * instead of inventing a manifest:
 *
 *  - every resource the server writes is paired with a `.udta` sidecar
 *    (the serialized track-added event). Only sidecar-linked resources
 *    belong to the session; anything else in the directory (cache files,
 *    …) is skipped.
 *  - the sidecars and the session-level `schema.udta` are embedded
 *    verbatim, twice: as ISO meta *items* (the byte-exact archive layer,
 *    one item per file, named after the resource) and — for sessions with
 *    media — as native `udta` boxes: `schema.udta` at movie level, each
 *    media sidecar at its remuxed track, so ordinary MP4 tooling can read
 *    the session metadata straight off the box tree.
 *  - session media (*.mkv) is additionally remuxed into real tracks so
 *    players and editors can open the export. The wall-clock anchors in
 *    the sidecars become track delays (`elst`), preserving the true
 *    relative timing between tracks. The original Matroska bytes stay
 *    in the item layer, so importing restores them exactly.
 *  - the export time is the MP4 header creation time; file modification
 *    times are re-derived from `created` in each sidecar / the schema.
 *
 * Import reads the item table back (item names are the resource names,
 * the sidecar items are the manifest), verifies every item, refuses
 * payloads without a sidecar, and atomically promotes a staged directory
 * into the sessions base directory — always as a NEW session with a
 * freshly generated id (importing into an existing session is not
 * possible), or under an explicit unused target id when one is given.
 *
 * Requirements: MP4Box (GPAC ≥ 2.2) on the PATH, or the session.mp4boxPath
 * property pointing at it; session.mp4boxTimeoutMs overrides the
 * per-invocation timeout (default 300 s). Sessions with non-ASCII
 * resource names need a UTF-8 filesystem encoding (e.g. LC_ALL=C.UTF-8).
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.Reader;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.FileTime;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.logging.Level;
import java.util.logging.Logger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

/**
 *
 * @author jbk
 */
public class SessionArchival {
    private static final Logger LOGGER = Logger.getLogger(SessionArchival.class.getName());
    private static final String MP4BOX = System.getProperty("session.mp4boxPath", "MP4Box");
    private static final long MP4BOX_TIMEOUT_MS = Long.getLong("session.mp4boxTimeoutMs", 300_000L);
    /** 4CC of the udta boxes carrying sidecars / the session schema verbatim. */
    private static final String UDTA_CODE = "stnd";
    /** iloc v0 32-bit extents: one item must stay below 4 GiB. */
    private static final long MAX_ITEM_BYTES = 4L * 1024L * 1024L * 1024L;
    private static final int MAX_ITEMS = 65_534;
    /** MP4Box tolerates very long argument lists badly; batch item options. */
    private static final int BATCH = 250;
    private static final Pattern TRACKS_PATTERN = Pattern.compile("File has (\\d+) track");

    private static final Charset JNU_CHARSET = jnuCharset();

    // ==================================================================
    // Public API
    // ==================================================================

    /**
     * Packs the session directory for sessionId into a single MP4 file at
     * targetFile. Naming the target "<sessionId>.mp4" is the convention
     * (the id is not needed for import — an import always creates a new
     * session id).
     * @return the resolved target file
     */
    public static File exportSessionToMp4(String sessionId, File targetFile) throws IOException {
        UUID id = parseUuid(sessionId, "session id");
        Path sessionDir = SessionStorage.getSessionBaseDir().toPath().resolve(sessionId);
        if (!Files.isDirectory(sessionDir))
            throw new IOException("No such session '" + sessionId + "' under " + SessionStorage.getSessionBaseDir());
        Path schema = sessionDir.resolve("schema.udta");
        if (!Files.isRegularFile(schema))
            throw new IOException("Session '" + sessionId + "' has no schema.udta; not a session directory");
        if (targetFile == null) throw new IllegalArgumentException("targetFile is null");
        Path target = targetFile.toPath().toAbsolutePath().normalize();
        if (Files.exists(target))
            throw new IOException("Refusing to overwrite existing file " + target);
        Path targetDir = target.getParent();
        if (targetDir == null || !Files.isDirectory(targetDir))
            throw new IOException("Target directory does not exist: " + targetDir);

        // Which resources belong to the session: only sidecar-linked ones.
        Map<String, Entry> linked = scanSession(sessionDir);

        Path work = Files.createTempDirectory(targetDir, ".shexp-");
        try {
            // Freeze the embedded files (a consistent point-in-time snapshot
            // even for a still-recording session) under MP4Box-safe aliases;
            // the true resource names travel as item names.
            Files.copy(schema, work.resolve("schema.udta"));
            Map<Integer, Path> itemSources = new TreeMap<>();
            Map<Integer, String> itemNames = new TreeMap<>();
            int alias = 0;
            for (Entry e : linked.values()) {
                e.sidecarAlias = "s" + (++alias) + ".udta";
                Files.copy(e.sidecar, work.resolve(e.sidecarAlias));
                if (e.payload != null) {
                    long size = Files.size(e.payload);
                    if (size > MAX_ITEM_BYTES)
                        throw new IOException("Resource '" + e.resource + "' is " + size
                                + " bytes; a single MP4 item cannot exceed 4 GiB");
                    if (size > 0) {
                        // the .mkv extension lets MP4Box import the remux source
                        e.payloadAlias = e.resource.endsWith(".mkv")
                                ? "p" + alias + ".mkv" : "d" + alias + ".bin";
                        Files.copy(e.payload, work.resolve(e.payloadAlias));
                    }
                }
            }

            // Sidecar metadata: creation times (for mtimes), wall-clock
            // anchors (for track delays), resource cross-check. Torn
            // sidecars archive as bytes only.
            for (Entry e : linked.values()) readSidecarInto(work.resolve(e.sidecarAlias), e);

            // Media candidates: single-track Matroska resources with a
            // usable wall-clock anchor.
            List<Entry> media = new ArrayList<>();
            for (Entry e : linked.values()) {
                if (e.payloadAlias != null && e.resource.endsWith(".mkv")
                        && e.anchorMs != null && probeSingleTrack(work, e.payloadAlias)) {
                    e.remux = true;
                    media.add(e);
                }
            }
            long baseline = Long.MAX_VALUE;
            for (Entry e : media) baseline = Math.min(baseline, e.anchorMs);

            // Item ids: payload, then its sidecar, per resource; schema last.
            int item = 0;
            for (Entry e : linked.values()) {
                if (e.payloadAlias != null) {
                    e.payloadItem = ++item;
                    itemSources.put(e.payloadItem, work.resolve(e.payloadAlias));
                    itemNames.put(e.payloadItem, e.resource);
                }
                e.sidecarItem = ++item;
                itemSources.put(e.sidecarItem, work.resolve(e.sidecarAlias));
                itemNames.put(e.sidecarItem, e.resource + ".udta");
            }
            int schemaItem = ++item;
            itemSources.put(schemaItem, work.resolve("schema.udta"));
            itemNames.put(schemaItem, "schema.udta");
            if (item > MAX_ITEMS)
                throw new IOException("Session has " + item + " archived files; one MP4 carries at most " + MAX_ITEMS + " items");

            Path out = work.resolve("out.mp4");
            try {
                authorMp4(work, out, id.toString(), linked, media, baseline, schemaItem);
            } catch (IOException failed) {
                if (media.isEmpty()) throw failed;
                LOGGER.log(Level.WARNING, "SessionArchival: remuxing the media failed; writing an items-only export", failed);
                Files.deleteIfExists(out);
                for (Entry e : media) { e.remux = false; e.trackId = 0; }
                authorMp4(work, out, id.toString(), linked, List.of(), baseline, schemaItem);
                media = List.of();
            }

            verifyExport(work, out, linked, media, itemSources, itemNames, schemaItem);

            moveAtomically(out, target);
            LOGGER.info("SessionArchival: exported session " + id + " ("
                    + item + " items, " + media.size() + " tracks) to " + target);
            return target.toFile();
        } finally {
            deleteRecursively(work);
        }
    }

    /**
     * Restores the session packed in mp4File as a brand-new session in the
     * sessions base directory: a fresh session id is generated (importing
     * into an existing session is not possible — the new session and its
     * SessionStorage instance materialize on first access, like any other
     * session directory). Importing the same file twice yields two
     * independent sessions.
     * @return the id of the newly created session
     */
    public static String importSessionFromMp4(File mp4File) throws IOException {
        return importSessionFromMp4(mp4File, null);
    }

    /**
     * Restores the session packed in mp4File as a new session in the
     * sessions base directory, under targetSessionId when given (useful to
     * restore an archived session under its original id) or under a freshly
     * generated id when null. An existing session is never overwritten —
     * an import into an existing session is refused — and a failed or
     * interrupted import never leaves a partial directory behind.
     * @return the id of the newly created session
     */
    public static String importSessionFromMp4(File mp4File, String targetSessionId) throws IOException {
        if (mp4File == null) throw new IllegalArgumentException("mp4File is null");
        Path src = mp4File.toPath();
        if (!Files.isRegularFile(src)) throw new IOException("No such file: " + mp4File);

        Path base = SessionStorage.getSessionBaseDir().toPath();
        Files.createDirectories(base);
        String id;
        if (targetSessionId != null) {
            // explicit placement: validate and normalize (e.g. case variants)
            id = parseUuid(targetSessionId, "target session id").toString();
        } else {
            // an import is always a NEW session: fresh id, never an existing one
            do { id = UUID.randomUUID().toString(); }
            while (Files.exists(base.resolve(id)));
        }
        Path targetDir = base.resolve(id);
        if (Files.exists(targetDir))
            throw new IOException("A session with id " + id + " already exists; import refused"
                    + " (importing into an existing session is not possible)");

        Path work = Files.createTempDirectory(base, ".shimp-");
        try {
            Files.copy(src, work.resolve("in.mp4"));
            Map<Integer, ItemRec> items = itemsFromXml(runDiso(work.resolve("in.mp4")), mp4File.toString());
            if (items.isEmpty())
                throw new IOException(mp4File + " carries no embedded items; not a SessionHistory session export");

            // The item names are flat resource names; validate before use.
            Map<String, ItemRec> byName = new TreeMap<>();
            for (ItemRec rec : items.values()) {
                requireSafeImportName(rec.name());
                ItemRec prev = byName.put(rec.name(), rec);
                if (prev != null)
                    throw new IOException("Duplicate item name in " + mp4File + ": '" + rec.name() + "'");
            }
            if (!byName.containsKey("schema.udta"))
                throw new IOException(mp4File + " carries no schema.udta item; not a SessionHistory session export"
                        + " (re-saving the file with ffmpeg or a media editor drops embedded items)");

            // Pairing: every payload item needs its .udta sidecar item —
            // that pairing is what makes a file part of the session.
            Map<String, ItemRec> sidecars = new TreeMap<>();
            for (ItemRec rec : byName.values()) {
                if (!rec.name().equals("schema.udta") && rec.name().endsWith(".udta")) {
                    String resource = rec.name().substring(0, rec.name().length() - 5);
                    if (resource.equals("schema.udta"))
                        throw new IOException("Item 'schema.udta.udta' claims the reserved schema name; import refused");
                    sidecars.put(resource, rec);
                }
            }
            for (ItemRec rec : byName.values()) {
                if (rec.name().equals("schema.udta") || rec.name().endsWith(".udta")) continue;
                if (!sidecars.containsKey(rec.name()))
                    throw new IOException("Item '" + rec.name() + "' is not linked to the session"
                            + " (no '" + rec.name() + ".udta' item); import refused");
            }

            // Dump every item into the staged session directory, under safe
            // aliases first, then rename to the real resource names.
            Path tree = Files.createDirectory(work.resolve("tree"));
            List<Integer> ids = new ArrayList<>(items.keySet());
            for (int i = 0; i < ids.size(); i += BATCH) {
                List<String> args = new ArrayList<>();
                for (Integer item : ids.subList(i, Math.min(ids.size(), i + BATCH))) {
                    // '-a<id>' cannot collide with an item name: item names
                    // never start with '-' (validated above)
                    args.add("-dump-item"); args.add(item + ":path=-a" + item);
                }
                args.add("../in.mp4"); // outside the tree: no collision with item names
                mp4box(tree, args, "extracting session items");
            }
            for (Map.Entry<Integer, ItemRec> en : items.entrySet()) {
                Path staged = tree.resolve("-a" + en.getKey());
                if (!Files.isRegularFile(staged) || Files.size(staged) != en.getValue().bytes())
                    throw new IOException("Extracted item '" + en.getValue().name() + "' does not match the item table; the file is corrupt");
                Files.move(staged, tree.resolve(en.getValue().name()));
            }

            // Derive mtimes from the sidecar/schema creation times and
            // materialize zero-length resources (empty or never-written).
            for (Map.Entry<String, ItemRec> en : sidecars.entrySet()) {
                String resource = en.getKey();
                Path sidecarFile = tree.resolve(resource + ".udta");
                Long created = sidecarCreatedMs(sidecarFile, resource);
                Path payload = tree.resolve(resource);
                if (!Files.exists(payload)) Files.writeString(payload, "");
                if (created != null) {
                    setMtime(payload, created);
                    setMtime(sidecarFile, created);
                }
            }
            Long schemaCreated = schemaCreatedMs(tree.resolve("schema.udta"));
            if (schemaCreated != null) setMtime(tree.resolve("schema.udta"), schemaCreated);

            moveAtomically(tree, targetDir);
            // the new session is picked up (and its SessionStorage instance
            // created) on first access, like any other session directory
            LOGGER.info("SessionArchival: imported session " + id + " ("
                    + items.size() + " files) from " + mp4File);
            return id;
        } finally {
            deleteRecursively(work);
        }
    }

    // ==================================================================
    // Session directory scanning
    // ==================================================================

    /** One sidecar-linked session resource. */
    private static final class Entry {
        final String resource;   // file name inside the session directory
        final Path payload;      // null when absent (never-written resource)
        final Path sidecar;      // <resource>.udta, always present
        Long createdMs;          // from sidecar event.created, null when torn
        Long anchorMs;           // from sidecar event.start, null when torn
        String payloadAlias;     // frozen copy names in the work directory
        String sidecarAlias;
        int payloadItem;         // MP4 item ids
        int sidecarItem;
        boolean remux;           // media candidate that passed the probe
        int trackId;             // 1-based track id when remuxed

        Entry(String resource, Path payload, Path sidecar) {
            this.resource = resource; this.payload = payload; this.sidecar = sidecar;
        }
    }

    /** One meta item from a -diso structural dump. */
    private record ItemRec(String name, long bytes) {}

    /**
     * Scans the flat session directory: schema.udta plus every resource X
     * that has a sibling X.udta sidecar. Unlinked files are reported and
     * skipped.
     */
    private static Map<String, Entry> scanSession(Path sessionDir) throws IOException {
        Map<String, Path> files = new TreeMap<>();
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(sessionDir)) {
            for (Path p : ds) files.put(p.getFileName().toString(), p);
        }

        Map<String, Entry> linked = new TreeMap<>();
        for (Map.Entry<String, Path> en : files.entrySet()) {
            String name = en.getKey();
            if (name.equals("schema.udta") || !name.endsWith(".udta")) continue;
            String resource = name.substring(0, name.length() - 5);
            if (resource.isEmpty() || resource.endsWith(".udta") || resource.equals("schema.udta"))
                continue; // not a sidecar the server writes; ignore
            if (!Files.isRegularFile(en.getValue())) continue;
            Path payload = files.get(resource);
            if (payload != null && !Files.isRegularFile(payload))
                throw new IOException("Resource '" + resource + "' is not a regular file; cannot archive it");
            requireSafeItemName(resource);
            linked.put(resource, new Entry(resource, payload, en.getValue()));
        }

        for (Map.Entry<String, Path> en : files.entrySet()) {
            String name = en.getKey();
            if (name.equals("schema.udta") || name.endsWith(".udta")) continue;
            if (!linked.containsKey(name))
                LOGGER.info("SessionArchival: skipping '" + name
                        + "' (not linked to the session: no " + name + ".udta)");
        }
        return linked;
    }

    /** Reads created/anchor/resource out of a frozen sidecar; tolerant of torn writes. */
    private static void readSidecarInto(Path frozenSidecar, Entry e) throws IOException {
        JsonObject event = jsonTop(frozenSidecar, "event");
        if (event == null) {
            LOGGER.warning("SessionArchival: '" + e.resource + ".udta' is not valid JSON"
                    + " (torn write?); archiving its bytes without timestamps and track metadata");
            return;
        }
        e.createdMs = longOrNull(event, "created");
        e.anchorMs = longOrNull(event, "start");
        JsonElement track = event.get("track");
        if (track != null && track.isJsonObject()) {
            JsonElement res = track.getAsJsonObject().get("resource");
            if (res != null && res.isJsonPrimitive() && !e.resource.equals(res.getAsString()))
                throw new IOException("Sidecar '" + e.resource + ".udta' references resource '"
                        + res.getAsString() + "'; the session directory is inconsistent");
        }
    }

    /** Tolerant JSON accessors. */
    private static JsonObject jsonTop(Path file, String member) {
        try (Reader r = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
            JsonObject root = JsonParser.parseReader(r).getAsJsonObject();
            JsonElement el = root.get(member);
            return el != null && el.isJsonObject() ? el.getAsJsonObject() : null;
        } catch (Exception unreadable) {
            return null;
        }
    }

    private static Long longOrNull(JsonObject obj, String member) {
        try {
            JsonElement el = obj.get(member);
            return el != null && el.isJsonPrimitive() ? el.getAsLong() : null;
        } catch (NumberFormatException notANumber) {
            return null;
        }
    }

    /** mtime source: event.created, with the resource cross-check. */
    private static Long sidecarCreatedMs(Path sidecar, String resource) throws IOException {
        JsonObject event = jsonTop(sidecar, "event");
        if (event == null) return null;
        JsonElement track = event.get("track");
        if (track != null && track.isJsonObject()) {
            JsonElement res = track.getAsJsonObject().get("resource");
            if (res != null && res.isJsonPrimitive() && !resource.equals(res.getAsString()))
                throw new IOException("Sidecar '" + resource + ".udta' references resource '"
                        + res.getAsString() + "'; the archive is inconsistent");
        }
        return longOrNull(event, "created");
    }

    private static Long schemaCreatedMs(Path schema) {
        try (Reader r = Files.newBufferedReader(schema, StandardCharsets.UTF_8)) {
            return longOrNull(JsonParser.parseReader(r).getAsJsonObject(), "created");
        } catch (Exception unreadable) {
            return null;
        }
    }

    // ==================================================================
    // MP4 authoring and verification (export)
    // ==================================================================

    /**
     * One MP4Box invocation: meta setup, media remuxes with anchored
     * delays, items named after the resources, verbatim udta boxes for the
     * schema (movie level) and the media sidecars (track level), and a
     * human-readable warning tag. media empty ⇒ items-only export.
     */
    private static void authorMp4(Path work, Path out, String sessionId, Map<String, Entry> linked,
                                  List<Entry> media, long baseline, int schemaItem) throws IOException {
        List<String> args = new ArrayList<>();
        args.add("-set-meta"); args.add("hbin");
        args.add("-brand"); args.add("isom:0");
        args.add("-ab"); args.add("iso2"); args.add("-ab"); args.add("iso4");

        int tk = 0;
        for (Entry e : media) {
            e.trackId = ++tk;
            StringBuilder add = new StringBuilder(e.payloadAlias);
            add.append(":name=").append(trackNameOf(e.resource));
            add.append(":lang=und:delay=").append(e.anchorMs - baseline);
            if (e.resource.endsWith(".opus.mkv")) add.append(":group=1"); // alternate audio group
            args.add("-add"); args.add(add.toString());
        }

        for (Entry e : linked.values()) {
            if (e.payloadAlias != null)
                addAddItem(args, e.payloadAlias, e.resource, mimeOf(e.resource), e.payloadItem);
            addAddItem(args, e.sidecarAlias, e.resource + ".udta", "application/json", e.sidecarItem);
        }
        addAddItem(args, "schema.udta", "schema.udta", "application/json", schemaItem);
        args.add("-set-primary"); args.add(String.valueOf(schemaItem));

        if (!media.isEmpty()) {
            // needs a moov, which the -add calls above created
            args.add("-udta"); args.add("0:type=" + UDTA_CODE + ":src=schema.udta");
            for (Entry e : media) {
                args.add("-udta");
                args.add(e.trackId + ":type=" + UDTA_CODE + ":src=" + e.sidecarAlias);
            }
            Files.writeString(work.resolve("tags.txt"),
                    "title=SessionHistory archive " + sessionId + "\n"
                  + "comment=Do not re-save this file with media tools: the embedded session data items will be dropped\n");
            args.add("-itags"); args.add("tags.txt");
        }

        args.add(out.getFileName().toString());
        mp4box(work, args, "authoring the session export");
    }

    private static void addAddItem(List<String> args, String alias, String name, String mime, int id) {
        args.add("-add-item");
        args.add(alias + ":name=" + name + ":mime=" + mime + ":id=" + id);
    }

    /** The resource name without its .mkv container extension. */
    private static String trackNameOf(String resource) {
        return resource.endsWith(".mkv") ? resource.substring(0, resource.length() - 4) : resource;
    }

    private static String mimeOf(String resource) {
        if (resource.endsWith(".json")) return "application/json";
        if (resource.endsWith(".mkv")) return "video/x-matroska";
        return "application/octet-stream";
    }

    /** A remux candidate must be a single-track file (one track per server recording). */
    private static boolean probeSingleTrack(Path work, String alias) {
        try {
            Matcher m = TRACKS_PATTERN.matcher(mp4box(work, List.of("-info", alias), "probing media"));
            return m.find() && Integer.parseInt(m.group(1)) == 1;
        } catch (IOException noRemux) {
            return false;
        }
    }

    /**
     * Self-verification before anything is committed: the item table must
     * match the planned set exactly (names, sizes, no zero extents, no
     * stowaways), every track must have landed, the udta boxes must
     * byte-match their sources, and every item must dump back identical.
     */
    private static void verifyExport(Path work, Path out, Map<String, Entry> linked, List<Entry> media,
                                     Map<Integer, Path> itemSources, Map<Integer, String> itemNames,
                                     int schemaItem) throws IOException {
        Path vdir = Files.createDirectory(work.resolve("verify"));
        Files.copy(out, vdir.resolve("in.mp4"));
        Document doc = runDiso(vdir.resolve("in.mp4"));
        Map<Integer, ItemRec> items = itemsFromXml(doc, "export");

        Map<String, Long> expect = new TreeMap<>();
        for (Entry e : linked.values()) {
            if (e.payloadAlias != null) expect.put(e.resource, Files.size(work.resolve(e.payloadAlias)));
            expect.put(e.resource + ".udta", Files.size(work.resolve(e.sidecarAlias)));
        }
        expect.put("schema.udta", Files.size(work.resolve("schema.udta")));

        Map<String, Long> actual = new TreeMap<>();
        for (ItemRec rec : items.values()) {
            Long prev = actual.put(rec.name(), rec.bytes());
            if (prev != null)
                throw new IOException("Export verification failed: duplicate item name '" + rec.name() + "'");
        }
        if (!actual.equals(expect))
            throw new IOException("Export verification failed: item table is " + actual.keySet()
                    + " but the session planned " + expect.keySet());

        if (!media.isEmpty()) {
            int handlers = 0;
            NodeList hd = doc.getElementsByTagName("HandlerBox");
            for (int i = 0; i < hd.getLength(); i++) {
                String type = ((Element) hd.item(i)).getAttribute("hdlrType");
                if (type.equals("vide") || type.equals("soun")) handlers++;
            }
            if (handlers != media.size())
                throw new IOException("Export verification failed: " + handlers + " media tracks in the file, "
                        + media.size() + " planned");

            // movie-level udta must be the schema bytes
            mp4box(vdir, List.of("-dump-udta", UDTA_CODE, "in.mp4"), "dumping the session udta");
            byteEqual(vdir.resolve("in_" + UDTA_CODE + ".udta"), work.resolve("schema.udta"), "the session udta box");
            // each track's udta must be its sidecar bytes
            for (Entry e : media) {
                Files.deleteIfExists(vdir.resolve("in_" + UDTA_CODE + ".udta"));
                mp4box(vdir, List.of("-dump-udta", e.trackId + ":" + UDTA_CODE, "in.mp4"), "dumping a track udta");
                byteEqual(vdir.resolve("in_" + UDTA_CODE + ".udta"), work.resolve(e.sidecarAlias),
                        "the udta box of track " + e.trackId + " (" + e.resource + ")");
            }
        }

        // byte-exact item round-trip: dump every item next to its frozen copy
        Path ddir = Files.createDirectory(work.resolve("dump"));
        List<Integer> ids = new ArrayList<>(itemSources.keySet());
        for (int i = 0; i < ids.size(); i += BATCH) {
            List<String> args = new ArrayList<>();
            for (Integer item : ids.subList(i, Math.min(ids.size(), i + BATCH))) {
                args.add("-dump-item"); args.add(item + ":path=a" + item);
            }
            args.add("../out.mp4"); // outside the dump dir: no collision with staged names
            mp4box(ddir, args, "dumping items for verification");
        }
        for (Integer item : ids)
            byteEqual(ddir.resolve("a" + item), itemSources.get(item), "item " + item + " ('" + itemNames.get(item) + "')");
    }

    // ==================================================================
    // MP4Box process handling and XML parsing
    // ==================================================================

    /** Runs MP4Box with a drained output cap and a hard timeout. */
    private static String mp4box(Path cwd, List<String> args, String what) throws IOException {
        List<String> cmd = new ArrayList<>();
        cmd.add(MP4BOX); cmd.addAll(args);
        ProcessBuilder pb = new ProcessBuilder(cmd).directory(cwd.toFile()).redirectErrorStream(true);
        Process p;
        try {
            p = pb.start();
        } catch (IOException notFound) {
            throw new IOException("Unable to run MP4Box ('" + MP4BOX + "'): " + notFound.getMessage()
                    + " — install GPAC or set the session.mp4boxPath property", notFound);
        }
        StringBuilder out = new StringBuilder();
        Thread drain = new Thread(() -> {
            try (InputStream in = p.getInputStream()) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) >= 0) {
                    if (out.length() < 65536) out.append(new String(buf, 0, n, StandardCharsets.UTF_8));
                }
            } catch (IOException ignored) {}
        }, "SessionArchival-MP4Box");
        drain.setDaemon(true);
        drain.start();
        boolean finished;
        try {
            finished = p.waitFor(MP4BOX_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            p.destroyForcibly();
            throw new IOException("Interrupted while MP4Box was " + what, interrupted);
        }
        if (!finished) {
            p.destroyForcibly();
            throw new IOException("MP4Box timed out while " + what + " (after " + MP4BOX_TIMEOUT_MS
                    + " ms; raise the session.mp4boxTimeoutMs property)");
        }
        try { drain.join(2000); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
        if (p.exitValue() != 0)
            throw new IOException("MP4Box failed while " + what + " (exit " + p.exitValue() + "): " + tail(out.toString()));
        return out.toString();
    }

    /** Runs -diso and parses the produced XML. */
    private static Document runDiso(Path mp4) throws IOException {
        Path dir = mp4.getParent();
        mp4box(dir, List.of("-diso", mp4.getFileName().toString()), "dumping the file structure");
        String name = mp4.getFileName().toString();
        int dot = name.lastIndexOf('.');
        String xml = (dot > 0 ? name.substring(0, dot) : name) + "_info.xml";
        return parseXml(dir.resolve(xml));
    }

    private static Document parseXml(Path f) throws IOException {
        try {
            DocumentBuilderFactory dbf = DocumentBuilderFactory.newInstance();
            dbf.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            dbf.setXIncludeAware(false);
            dbf.setExpandEntityReferences(false);
            return dbf.newDocumentBuilder().parse(f.toFile());
        } catch (Exception bad) {
            throw new IOException("Unable to parse MP4Box XML output " + f + ": " + bad.getMessage(), bad);
        }
    }

    /** item id → (name, total extent bytes); refuses zero-length extents. */
    private static Map<Integer, ItemRec> itemsFromXml(Document doc, String what) throws IOException {
        Map<Integer, Long> extents = new LinkedHashMap<>();
        NodeList locs = doc.getElementsByTagName("ItemLocationEntry");
        for (int i = 0; i < locs.getLength(); i++) {
            Element loc = (Element) locs.item(i);
            int id = Integer.parseInt(loc.getAttribute("item_ID"));
            long bytes = 0;
            NodeList ext = loc.getElementsByTagName("ItemExtentEntry");
            for (int j = 0; j < ext.getLength(); j++)
                bytes += Long.parseLong(((Element) ext.item(j)).getAttribute("extent_length"));
            extents.put(id, bytes);
        }
        Map<Integer, ItemRec> items = new LinkedHashMap<>();
        NodeList infos = doc.getElementsByTagName("ItemInfoEntryBox");
        for (int i = 0; i < infos.getLength(); i++) {
            Element info = (Element) infos.item(i);
            int id = Integer.parseInt(info.getAttribute("item_ID"));
            Long bytes = extents.get(id);
            if (bytes == null)
                throw new IOException("Item '" + info.getAttribute("item_name") + "' in " + what + " has no location entry");
            if (bytes == 0)
                throw new IOException("Zero-length item extent for '" + info.getAttribute("item_name")
                        + "' in " + what + "; the file is corrupt");
            items.put(id, new ItemRec(info.getAttribute("item_name"), bytes));
        }
        return items;
    }

    // ==================================================================
    // Name safety, ids, files
    // ==================================================================

    /**
     * Resource names must ride MP4Box item-name options and come back as
     * flat file names: no ':' (MP4Box option separator), no path
     * separators, no option-shaped names, no sidecar/schema namespace
     * collisions, and representable in the server's filesystem encoding.
     */
    private static void requireSafeItemName(String name) throws IOException {
        String bad = null;
        if (name.isEmpty()) bad = "the name is empty";
        else if (name.length() > 200) bad = "the name is longer than 200 characters";
        else if (name.startsWith("-")) bad = "the name starts with '-'";
        else if (name.contains(":")) bad = "':' is MP4Box's option separator";
        else if (name.contains("/") || name.contains("\\")) bad = "the name contains a path separator";
        else if (name.indexOf('\0') >= 0) bad = "the name contains a NUL byte";
        else if (name.endsWith(".udta")) bad = "'.udta' names are reserved for sidecars";
        else if (name.equals("schema.udta")) bad = "'schema.udta' is reserved for the session schema";
        if (bad != null)
            throw new IOException("Cannot archive resource '" + name + "': " + bad);
        if (name.indexOf('�') >= 0 || !new String(name.getBytes(JNU_CHARSET), JNU_CHARSET).equals(name))
            throw new IOException("Cannot archive resource '" + name + "': the server's filesystem encoding ("
                    + JNU_CHARSET + ") cannot represent it. Restart the server with a UTF-8 locale (e.g. LC_ALL=C.UTF-8)");
    }

    /** Item names arriving from an MP4 must be usable as flat file names. */
    private static void requireSafeImportName(String name) throws IOException {
        String bad = null;
        if (name.isEmpty()) bad = "the item name is empty";
        else if (name.length() > 200) bad = "the item name is longer than 200 characters";
        else if (name.startsWith("-")) bad = "the item name starts with '-'";
        else if (name.contains(":")) bad = "the item name contains ':'";
        else if (name.contains("/") || name.contains("\\")) bad = "the item name contains a path separator";
        else if (name.equals(".") || name.equals("..")) bad = "the item name is '" + name + "'";
        else if (name.indexOf('\0') >= 0) bad = "the item name contains a NUL byte";
        if (bad != null)
            throw new IOException("Refusing to import item '" + name + "': " + bad);
        try {
            Paths.get(name);
        } catch (InvalidPathException unencodable) {
            throw new IOException("Refusing to import item '" + name + "': it cannot be written as a file name with the"
                    + " server's filesystem encoding; restart the server with a UTF-8 locale (e.g. LC_ALL=C.UTF-8): "
                    + unencodable.getMessage());
        }
    }

    private static UUID parseUuid(String s, String what) throws IOException {
        try {
            return UUID.fromString(s);
        } catch (IllegalArgumentException notAUuid) {
            throw new IOException("Invalid " + what + ": '" + s + "' is not a UUID");
        }
    }


    private static void byteEqual(Path a, Path b, String what) throws IOException {
        if (Files.mismatch(a, b) != -1L)
            throw new IOException("Byte verification failed for " + what);
    }

    private static void setMtime(Path p, long epochMs) {
        try {
            Files.setLastModifiedTime(p, FileTime.fromMillis(epochMs));
        } catch (IOException e) {
            LOGGER.log(Level.WARNING, "SessionArchival: could not restore the modification time of "
                    + p.getFileName(), e);
        }
    }

    private static void moveAtomically(Path from, Path to) throws IOException {
        try {
            Files.move(from, to, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException plainMove) {
            Files.move(from, to);
        }
    }

    private static void deleteRecursively(Path root) {
        try (var walk = Files.walk(root)) {
            walk.sorted(Comparator.reverseOrder()).forEach(p -> {
                try { Files.delete(p); } catch (IOException ignored) {}
            });
        } catch (IOException ignored) {}
    }

    private static String tail(String s) {
        s = s.replaceAll("\u001b\\[[0-9;]*[A-Za-z]", "");
        return s.length() > 600 ? "…" + s.substring(s.length() - 600) : s;
    }

    private static Charset jnuCharset() {
        try {
            return Charset.forName(System.getProperty("sun.jnu.encoding", "UTF-8"));
        } catch (Exception unavailable) {
            return Charset.defaultCharset();
        }
    }
}
