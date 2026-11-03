/**
 * Entity Auth Filter
 * The auth gate of the service, mapped over everything under /session:
 * session creation, session resources (media/export) — and, because
 * Jetty performs websocket upgrades through the servlet filter chain
 * (WebSocketUpgradeFilter), also every /session/{sessionId}/{entityId}
 * websocket handshake. A request without an entityKey, with an unknown
 * or expired one, or with one granting a different entity than the
 * request claims is rejected before any servlet or endpoint runs.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.auth;

import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.ReadListener;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;

/**
 *
 * @author jbk
 */
public class EntityAuthFilter implements Filter {

    @Override
    public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain) throws IOException, ServletException {
        if (!(request instanceof HttpServletRequest httpRequest) || !(response instanceof HttpServletResponse httpResponse)) {
            chain.doFilter(request, response);
            return;
        }

        try {
            HttpServletRequest effectiveRequest = authenticate(httpRequest);
            chain.doFilter(effectiveRequest, response);
        } catch (EntityAuth.AuthRejectException e) {
            httpResponse.setStatus(e.status);
            if (e.status == HttpServletResponse.SC_UNAUTHORIZED) {
                httpResponse.setHeader("WWW-Authenticate", "Bearer realm=\"SessionHistoryServer\"");
            }
            httpResponse.setContentType("text/plain;charset=utf-8");
            httpResponse.getWriter().println(e.getMessage());
        }
    }

    /**
     * Validates the request's entityKey and its claim to an entity id,
     * returning the request to continue with (the create call gets a
     * wrapper replaying its body once the claim was read from it) with
     * the authenticated entity attached as request attributes.
     * @throws EntityAuth.AuthRejectException 401 when no key is presented
     *         or it is unknown/expired; 403 when it grants a different
     *         entity than the request claims.
     */
    private HttpServletRequest authenticate(HttpServletRequest request) throws EntityAuth.AuthRejectException, IOException {
        EntityToken token;
        try {
            token = TokenStore.validate(EntityAuth.extractKey(request));
        } catch (TokenStore.TokenException e) {
            throw new EntityAuth.AuthRejectException(HttpServletResponse.SC_UNAUTHORIZED, e.getMessage());
        }

        HttpServletRequest effectiveRequest = request;
        String claimedEntityId;
        if (pathWithinContext(request).equals("/session") && "POST".equalsIgnoreCase(request.getMethod())) {
            // the create call claims its entity in the JSON body — read it
            // (and wrap the request so the servlet can read it again)
            CachedBodyRequestWrapper wrapper = new CachedBodyRequestWrapper(request);
            effectiveRequest = wrapper;
            claimedEntityId = EntityAuth.claimedEntityIdFromBody(wrapper.getCachedBody());
        } else if (isWebsocketUpgrade(request)) {
            // the websocket join claims its entity as the second path
            // segment (/session/{sessionId}/{entityId}). Other 2-segment
            // paths are the media/export categories — no claim, the
            // identity is the token's entity alone.
            claimedEntityId = EntityAuth.claimedEntityIdFromPath(pathWithinContext(request));
        } else {
            claimedEntityId = null;
        }

        if (claimedEntityId != null && !claimedEntityId.equals(token.entity)) {
            throw new EntityAuth.AuthRejectException(HttpServletResponse.SC_FORBIDDEN,
                "The presented entityKey belongs to entity '"+token.entity+"', not to '"+claimedEntityId+"'");
        }

        effectiveRequest.setAttribute(EntityAuth.ENTITY_ATTRIBUTE, token.entity);
        effectiveRequest.setAttribute(EntityAuth.TOKEN_ATTRIBUTE, token);
        return effectiveRequest;
    }

    /** The request path within the context path, e.g. "/session/{id}/{entity}". */
    private static String pathWithinContext(HttpServletRequest request) {
        String uri = request.getRequestURI();
        String contextPath = request.getContextPath();
        String path = uri != null && contextPath != null && !contextPath.isEmpty() && uri.startsWith(contextPath)
            ? uri.substring(contextPath.length()) : uri;
        return path == null || path.isEmpty() ? "/" : path;
    }

    /**
     * Whether the request is a websocket handshake (an upgrade to the
     * /session/{sessionId}/{entityId} endpoint). Only those carry an
     * entity id in their path; plain GETs of two-segment paths hit the
     * media/export categories instead.
     */
    private static boolean isWebsocketUpgrade(HttpServletRequest request) {
        return request.getHeader("Sec-WebSocket-Version") != null;
    }

    /**
     * Replays a request body the filter has already consumed: serves the
     * cached bytes again through getInputStream()/getReader().
     */
    private static class CachedBodyRequestWrapper extends HttpServletRequestWrapper {
        private final byte[] body;

        CachedBodyRequestWrapper(HttpServletRequest request) throws IOException {
            super(request);
            this.body = request.getInputStream().readAllBytes();
        }

        byte[] getCachedBody() {
            return body;
        }

        @Override
        public ServletInputStream getInputStream() {
            ByteArrayInputStream buffer = new ByteArrayInputStream(body);
            return new ServletInputStream() {
                @Override public int read() { return buffer.read(); }
                @Override public int read(byte[] b, int off, int len) { return buffer.read(b, off, len); }
                @Override public boolean isFinished() { return buffer.available() == 0; }
                @Override public boolean isReady() { return true; }
                @Override public void setReadListener(ReadListener listener) { throw new UnsupportedOperationException("Not async"); }
            };
        }

        @Override
        public BufferedReader getReader() {
            String encoding = getCharacterEncoding();
            Charset charset = encoding != null ? Charset.forName(encoding) : StandardCharsets.UTF_8;
            return new BufferedReader(new InputStreamReader(getInputStream(), charset));
        }
    }
}
