/**
 * Session Resource Servlet
 * HTTP servlet serving the stored resources of a session, streaming media
 * tracks to clients even while they are still being written.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.endpoints;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dk.cavi.sessionhistory.auth.EntityAuth;
import dk.cavi.sessionhistory.domain.SessionArchival;
import dk.cavi.sessionhistory.domain.SessionStorage;
import dk.cavi.sessionhistory.domain.tracks.AbstractMediaTrack;
import dk.cavi.sessionhistory.domain.tracks.AbstractTrack;
import jakarta.servlet.ServletException;
import jakarta.servlet.annotation.WebServlet;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.io.Reader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 *
 * @author jbk
 */
@WebServlet(urlPatterns = "/session/*")
public class SessionEndpoint extends HttpServlet {
    private static final Logger LOGGER = Logger.getLogger(SessionEndpoint.class.getName());

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp)
            throws ServletException, IOException {

        // Example Path: /session/abc-123/media/images/icon.png
        // getPathInfo() returns: /abc-123/media/images/icon.png
        String pathInfo = req.getPathInfo();

        if (pathInfo == null || pathInfo.length() < 2) {
            resp.sendError(HttpServletResponse.SC_BAD_REQUEST, "Missing session ID");
            return;
        }

        // Split with limit 4: ["", "abc-123", "media", "images/icon.png"]
        String[] parts = pathInfo.split("/", 4);

        if (parts.length < 3) {
            resp.sendError(HttpServletResponse.SC_NOT_FOUND);
            return;
        }

        String sessionId = parts[1];
        String category = parts[2];

        // Export resolves the session itself (and must not register an
        // in-memory instance for it): handle it before the storage lookup.
        if (category.equals("export")) {
            handleExportRequest(sessionId, req, resp);
            return;
        }

        SessionStorage session = SessionStorage.get(sessionId);
        if (session==null) {
            resp.sendError(HttpServletResponse.SC_NOT_FOUND, "Unknown session " + sessionId);
            return;
        }

        switch (category) {
            case "media":       // the serving category (README endpoint table)
                // Grab everything after the category
                String resourcePath = (parts.length == 4) ? parts[3] : "";
                handleStreamRequest(session, resourcePath, resp);
                break;

            default:
                resp.sendError(HttpServletResponse.SC_NOT_FOUND, "Unknown category: " + category);
                break;
        }
    }

    /**
     * GET /session/{sessionId}/export?type=raw
     *
     * Exports the session as a single MP4 archive and sends it as an
     * attachment (sesraw_<timestamp>.mp4). Only the session's owner may
     * export it — their identity is the authenticated entity behind the
     * request (the entityKey verified by the EntityAuthFilter; the old
     * ?entity= parameter is no longer consulted) — and the session must
     * have been at least started. The checks read schema.udta from disk —
     * the authoritative state even for sessions loaded after a server
     * restart.
     */
    private void handleExportRequest(String sessionId, HttpServletRequest req, HttpServletResponse resp) throws IOException {
        String type = req.getParameter("type");
        if (!"raw".equals(type)) {
            resp.sendError(HttpServletResponse.SC_BAD_REQUEST,
                    "Unknown export type '" + type + "'; supported types: raw");
            return;
        }

        Path sessionDir = SessionStorage.getSessionBaseDir().toPath().resolve(sessionId);
        Path schemaFile = sessionDir.resolve("schema.udta");
        if (!Files.isRegularFile(schemaFile)) {
            resp.sendError(HttpServletResponse.SC_NOT_FOUND, "Unknown session " + sessionId);
            return;
        }

        // Read only what the checks need as plain JSON: the full schema's
        // processors do not deserialize into their typed form.
        JsonObject schema;
        try (Reader reader = Files.newBufferedReader(schemaFile)) {
            schema = JsonParser.parseReader(reader).getAsJsonObject();
        } catch (Exception unreadable) {
            resp.sendError(HttpServletResponse.SC_INTERNAL_SERVER_ERROR,
                    "Unable to read the schema of session " + sessionId);
            return;
        }

        // The entity is the authenticated identity behind the entityKey;
        // the old ?entity= parameter was a spoofable self-claim and is gone.
        String entity = (String) req.getAttribute(EntityAuth.ENTITY_ATTRIBUTE);
        if (entity == null || entity.isBlank()) {
            resp.sendError(HttpServletResponse.SC_INTERNAL_SERVER_ERROR,
                    "Export reached without an authenticated entity - is the auth filter mapped?");
            return;
        }
        JsonElement ownerEl = schema.get("owner");
        String owner = ownerEl != null && ownerEl.isJsonPrimitive() ? ownerEl.getAsString() : null;
        if (owner == null || !owner.equals(entity)) {
            resp.sendError(HttpServletResponse.SC_FORBIDDEN, "Must be owner of session to export it");
            return;
        }
        JsonElement startEl = schema.get("start");
        if (startEl == null || startEl.isJsonNull()) {
            resp.sendError(HttpServletResponse.SC_CONFLICT,
                    "Session " + sessionId + " has not been started yet; export requires a started session");
            return;
        }

        // Export into a transient file next to the sessions (the exporter
        // stages its work there too), stream it as an attachment, delete it.
        File target = new File(SessionStorage.getSessionBaseDir(),
                ".shdl-" + UUID.randomUUID() + ".mp4");
        try {
            SessionArchival.exportSessionToMp4(sessionId, target);
            String filename = "sesraw_" + System.currentTimeMillis() + ".mp4";
            resp.setContentType("video/mp4");
            resp.setHeader("Content-Disposition", "attachment; filename=\"" + filename + "\"");
            resp.setContentLengthLong(target.length());
            Files.copy(target.toPath(), resp.getOutputStream());
        } finally {
            target.delete();
        }
    }

    private void handleStreamRequest(SessionStorage session, String path, HttpServletResponse resp) throws IOException {
        if (path.isEmpty()) {
            resp.sendError(HttpServletResponse.SC_NOT_FOUND);
            return;
        }

        // Get a tailing input stream from a resource ID in a session
        try (InputStream is = getProviderStream(session, path)) {
            if (is == null) {
                resp.sendError(HttpServletResponse.SC_NOT_FOUND);
                return;
            }

            String mimeType = getServletContext().getMimeType(path);
            resp.setContentType(mimeType != null ? mimeType : "application/octet-stream");
            is.transferTo(resp.getOutputStream());
        }
    }

    /**
     *
     */
    private InputStream getProviderStream(SessionStorage session, String resourcePath) {
        AbstractTrack track = AbstractTrack.fromRelativeResource(session,resourcePath);

        if (track instanceof AbstractMediaTrack){
            try {
                return track.getTailingInputStream();
            } catch (FileNotFoundException e) {
                LOGGER.warning("Media track not available ("+resourcePath+"): "+e.getMessage());
            }
        }
        return null;
    }
}