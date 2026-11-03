/**
 * Websocket Auth Configurator
 * The backstop of the auth layer on the websocket endpoint: the
 * EntityAuthFilter already rejects unauthenticated upgrade requests (the
 * websocket upgrade runs through the servlet filter chain), and this
 * configurator re-checks the entityKey during the handshake so that a
 * mis-ordered or bypassed filter cannot let an unauthenticated websocket
 * through. Throwing from modifyHandshake aborts the upgrade.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.auth;

import jakarta.websocket.HandshakeResponse;
import jakarta.websocket.server.HandshakeRequest;
import jakarta.websocket.server.ServerEndpointConfig;

/**
 *
 * @author jbk
 */
public class WebsocketAuthConfigurator extends ServerEndpointConfig.Configurator {
    @Override
    public void modifyHandshake(ServerEndpointConfig config, HandshakeRequest request, HandshakeResponse response) {
        String entityKey = EntityAuth.extractKey(request);
        if (entityKey == null) {
            throw new IllegalStateException("WebSocket rejected: no entityKey presented (POST /login with the master password to obtain one)");
        }
        EntityToken token;
        try {
            token = TokenStore.validate(entityKey);
        } catch (TokenStore.TokenException e) {
            throw new IllegalStateException("WebSocket rejected: "+e.getMessage());
        }
        String claimedEntityId = EntityAuth.claimedEntityIdFromRequestURI(request.getRequestURI());
        if (claimedEntityId == null || !claimedEntityId.equals(token.entity)) {
            throw new IllegalStateException("WebSocket rejected: the presented entityKey belongs to entity '"+token.entity+"', not to '"+claimedEntityId+"'");
        }
    }
}
