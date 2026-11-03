/**
 * Login Servlet
 * The only way to mint an entity token: POST the server's master
 * password (auth.masterPassword in config.json) together with the entity
 * id to claim, and receive the entityKey that proves ownership of that
 * entity. Anyone holding the master password may claim any entity id.
 * The browser login (GET /login, planned to perform an OpenID Connect
 * login with the provider from config.json) is not implemented yet.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.endpoints;

import com.google.gson.Gson;
import dk.cavi.sessionhistory.auth.EntityToken;
import dk.cavi.sessionhistory.auth.TokenStore;
import dk.cavi.sessionhistory.core.Core;
import dk.cavi.sessionhistory.core.ServerConfig;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.security.MessageDigest;
import java.nio.charset.StandardCharsets;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 *
 * @author jbk
 */
public class LoginServlet extends HttpServlet {
    private static final Logger LOGGER = Logger.getLogger(LoginServlet.class.getName());
    private static final Gson gson = new Gson();

    private class LoginRequest {
        private String entity;
        private String masterPassword;
    }

    @Override
    protected void doGet(HttpServletRequest request, HttpServletResponse response) throws IOException {
        // The browser login (an OpenID Connect round trip with the provider
        // from config.json) is not implemented yet — only the programmatic
        // POST below exists. Hooking GET here is planned.
        response.setStatus(HttpServletResponse.SC_METHOD_NOT_ALLOWED);
        response.setHeader("Allow", "POST");
        response.setContentType("text/plain;charset=utf-8");
        response.getWriter().println("Browser login is not implemented yet — POST {\"entity\": ..., \"masterPassword\": ...} as JSON to /login to mint an entityKey");
    }

    @Override
    protected void doPost(HttpServletRequest request, HttpServletResponse response) throws IOException {
        ServerConfig.AuthConfig auth = authConfig();

        // Without a configured master password no token can ever be minted
        // (and every /session request is rejected): fail closed, but say so.
        if (auth.masterPassword == null || auth.masterPassword.isBlank()) {
            response.setStatus(HttpServletResponse.SC_SERVICE_UNAVAILABLE);
            response.setContentType("text/plain;charset=utf-8");
            response.getWriter().println("Auth is not configured: set auth.masterPassword in the server's config.json (see README) — no entityKey can be minted");
            return;
        }

        LoginRequest login;
        try {
            login = gson.fromJson(request.getReader(), LoginRequest.class);
        } catch (Throwable t) {
            login = null;
        }
        if (login == null || login.masterPassword == null) {
            response.setStatus(HttpServletResponse.SC_BAD_REQUEST);
            response.setContentType("text/plain;charset=utf-8");
            response.getWriter().println("Must POST {\"entity\": ..., \"masterPassword\": ...} as JSON");
            return;
        }

        if (login.entity == null || login.entity.isBlank()
                || login.entity.length() > 256
                || login.entity.contains("/") || login.entity.contains("..")) {
            response.setStatus(HttpServletResponse.SC_BAD_REQUEST);
            response.setContentType("text/plain;charset=utf-8");
            response.getWriter().println("Invalid entity id — it must be non-empty, at most 256 characters, and contain no '/' or '..'");
            return;
        }

        // Constant-time comparison: the master password is the one secret
        // that unlocks every entity id, so do not hand out an oracle for it.
        boolean passwordMatches = MessageDigest.isEqual(
                auth.masterPassword.getBytes(StandardCharsets.UTF_8),
                login.masterPassword.getBytes(StandardCharsets.UTF_8));
        if (!passwordMatches) {
            try { Thread.sleep(500); } catch (InterruptedException e) { Thread.currentThread().interrupt(); } // blunt brute-force damper
            response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
            response.setContentType("text/plain;charset=utf-8");
            response.getWriter().println("Invalid credentials");
            return;
        }

        EntityToken token;
        try {
            token = TokenStore.create(login.entity, "pass");
        } catch (IOException e) {
            LOGGER.log(Level.WARNING, "Failed to mint the entity token for entity "+login.entity, e);
            response.setStatus(HttpServletResponse.SC_INTERNAL_SERVER_ERROR);
            response.setContentType("text/plain;charset=utf-8");
            response.getWriter().println("Unable to mint the entityKey");
            return;
        }

        // Also hand the key to the browser as a cookie: websockets and
        // media elements cannot set headers, and with the cookie they (and
        // every same-origin fetch) authenticate automatically.
        long maxAgeSeconds = Math.max(0, (token.expires - System.currentTimeMillis()) / 1000);
        response.setHeader("Set-Cookie", "entityKey=" + token.key + "; Path=/; Max-Age=" + maxAgeSeconds
                + "; HttpOnly; SameSite=Lax" + (request.isSecure() ? "; Secure" : ""));

        LoginResponse reply = new LoginResponse();
        reply.entityKey = token.key;
        reply.entity = token.entity;
        reply.created = token.created;
        reply.expires = token.expires;
        reply.source = token.source;

        response.setStatus(HttpServletResponse.SC_CREATED);
        response.setContentType("application/json");
        gson.toJson(reply, response.getWriter());
    }

    /** The /login response: the entityKey plus the token file's contents. */
    public class LoginResponse {
        public String entityKey;
        public String entity;
        public long created;
        public long expires;
        public String source;
    }

    private ServerConfig.AuthConfig authConfig() {
        ServerConfig config = Core.getServerConfig();
        if (config.auth != null) return config.auth;
        return new ServerConfig.AuthConfig(); // "auth": null in config.json — fall back to defaults
    }
}
