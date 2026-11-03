/**
 * Entity Authentication
 * The shared logic of the auth layer: where an entityKey is read from a
 * request (Authorization Bearer header, X-Entity-Key header, entityKey
 * query parameter, entityKey cookie — the websocket handshake and media
 * elements cannot set headers, so parameters and cookies must work), and
 * how the entity id a request claims is extracted from its shape. Used
 * by the EntityAuthFilter for HTTP requests and websocket upgrades, and
 * re-used by the WebsocketAuthConfigurator as a backstop.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.auth;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.websocket.server.HandshakeRequest;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/**
 *
 * @author jbk
 */
public class EntityAuth {
    /** Request attribute carrying the authenticated entity id (set by the filter). */
    public static final String ENTITY_ATTRIBUTE = "dk.cavi.sessionhistory.auth.entity";
    /** Request attribute carrying the full validated EntityToken (set by the filter). */
    public static final String TOKEN_ATTRIBUTE = "dk.cavi.sessionhistory.auth.entityToken";

    /** Rejection with the HTTP status to answer with (401 unauthenticated, 403 wrong identity). */
    public static class AuthRejectException extends Exception {
        public final int status;
        public AuthRejectException(int status, String message) {
            super(message);
            this.status = status;
        }
    }

    /**
     * Extracts the entityKey from an HTTP request: Authorization Bearer
     * header, then X-Entity-Key header, then the entityKey parameter, then
     * the entityKey cookie. Null when none is presented. (getParameter
     * consumes the body only for form posts; the create call posts JSON.)
     * @return The presented entityKey, or null.
     */
    public static String extractKey(HttpServletRequest request) {
        String key = keyFromAuthorization(request.getHeader("Authorization"));
        if (key != null) return key;
        key = trimToNull(request.getHeader("X-Entity-Key"));
        if (key != null) return key;
        key = trimToNull(request.getParameter("entityKey"));
        if (key != null) return key;
        Cookie[] cookies = request.getCookies();
        if (cookies != null) {
            for (Cookie cookie : cookies) {
                if ("entityKey".equals(cookie.getName())) return trimToNull(cookie.getValue());
            }
        }
        return null;
    }

    /**
     * Extracts the entityKey from a websocket handshake request (the same
     * places as the HTTP variant, read through the HandshakeRequest API).
     * @return The presented entityKey, or null.
     */
    public static String extractKey(HandshakeRequest request) {
        Map<String, List<String>> headers = request.getHeaders();
        String key = keyFromAuthorization(firstHeader(headers, "Authorization"));
        if (key != null) return key;
        key = trimToNull(firstHeader(headers, "X-Entity-Key"));
        if (key != null) return key;
        List<String> parameter = request.getParameterMap().get("entityKey");
        if (parameter != null && !parameter.isEmpty()) {
            key = trimToNull(parameter.get(0));
            if (key != null) return key;
        }
        // a Cookie header may appear several times; the key may hide in any of them
        for (String cookieHeader : headers.getOrDefault("Cookie", List.of())) {
            for (String cookie : cookieHeader.split(";")) {
                int eq = cookie.indexOf('=');
                if (eq > 0 && "entityKey".equals(cookie.substring(0, eq).trim())) {
                    key = trimToNull(cookie.substring(eq + 1));
                    if (key != null) return key;
                }
            }
        }
        return null;
    }

    /** "Bearer &lt;key&gt;" → key (case-insensitive scheme, per RFC 6750). */
    private static String keyFromAuthorization(String header) {
        if (header == null) return null;
        String trimmed = header.trim();
        if (trimmed.regionMatches(true, 0, "Bearer", 0, 6)) return trimToNull(trimmed.substring(6));
        return null;
    }

    /**
     * The entity id a websocket join claims with its path, or null when
     * the path makes no such claim:
     * <pre>
     *   /session                              the create call — the claim is the body's {entity}
     *   /session/{sessionId}                  no claim
     *   /session/{sessionId}/{entityId}       the websocket join — claims {entityId}
     *   /session/{sessionId}/{category}/...   media/export — no claim
     * </pre>
     * The two-segment case is only a join for actual websocket handshakes:
     * /session/{sessionId}/export and /session/{sessionId}/media are the
     * resource categories, where the identity is the token's entity alone.
     * @param pathWithinContext The request path within the context path (raw/encoded).
     * @return The claimed, percent-decoded entity id, or null.
     */
    public static String claimedEntityIdFromPath(String pathWithinContext) {
        if (pathWithinContext == null) return null;
        if (!pathWithinContext.equals("/session") && !pathWithinContext.startsWith("/session/")) return null;
        String rest = pathWithinContext.substring("/session".length());
        if (rest.isEmpty() || rest.equals("/")) return null;
        String[] segments = rest.substring(1).split("/");
        if (segments.length != 2) return null;
        return decodePathSegment(segments[1]);
    }

    /**
     * The entity id claimed by a websocket request URI: the endpoint is
     * /session/{sessionId}/{entityId}, so it is the last path segment.
     * @param requestURI The handshake request URI.
     * @return The claimed, percent-decoded entity id, or null.
     */
    public static String claimedEntityIdFromRequestURI(URI requestURI) {
        if (requestURI == null) return null;
        String path = requestURI.getPath();
        if (path == null || path.isEmpty() || path.equals("/")) return null;
        String[] segments = path.split("/");
        return decodePathSegment(segments[segments.length - 1]);
    }

    /**
     * The entity id claimed in the JSON body of a create call
     * ({entity: "..."}), or null when the body carries none (the servlet
     * then produces its own error for the missing owner).
     * @param body The raw request body bytes.
     */
    public static String claimedEntityIdFromBody(byte[] body) {
        if (body == null || body.length == 0) return null;
        try {
            JsonElement parsed = JsonParser.parseString(new String(body, StandardCharsets.UTF_8));
            if (!parsed.isJsonObject()) return null;
            JsonElement entity = parsed.getAsJsonObject().get("entity");
            return entity != null && entity.isJsonPrimitive() ? entity.getAsString() : null;
        } catch (Throwable t) {
            return null; // garbage body — the servlet answers with its own error
        }
    }

    /**
     * Percent-decodes a single path segment (%XX sequences, UTF-8). Unlike
     * URLDecoder, a '+' stays a '+' — that convention only applies to
     * query strings, not to path segments. Malformed sequences pass
     * through undecoded, so the worst outcome is an identity mismatch.
     */
    public static String decodePathSegment(String segment) {
        if (segment == null || segment.indexOf('%') < 0) return segment;
        java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream(segment.length());
        for (int i = 0; i < segment.length(); i++) {
            char c = segment.charAt(i);
            if (c == '%' && i + 2 < segment.length()) {
                try {
                    bytes.write(Integer.parseInt(segment.substring(i + 1, i + 3), 16));
                    i += 2;
                    continue;
                } catch (NumberFormatException ignored) { /* fall through, keep the literal '%' */ }
            }
            if (c < 0x80) bytes.write(c);
            else bytes.write((byte) c); // non-ASCII raw chars — mismatch is the worst outcome
        }
        return new String(bytes.toByteArray(), StandardCharsets.UTF_8);
    }

    private static String firstHeader(Map<String, List<String>> headers, String name) {
        List<String> values = headers.get(name);
        return values == null || values.isEmpty() ? null : values.get(0);
    }

    private static String trimToNull(String s) {
        if (s == null) return null;
        String trimmed = s.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }
}
