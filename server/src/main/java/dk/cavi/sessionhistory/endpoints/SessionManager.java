/**
 * Session Manager Servlet
 * HTTP servlet that creates a new session owned by the requesting entity and
 * returns its session id.
 *
 * Copyright (c) 2025 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.endpoints;

import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import com.google.gson.Gson;
import com.google.gson.JsonParseException;
import dk.cavi.sessionhistory.auth.EntityAuth;
import dk.cavi.sessionhistory.domain.SessionSpec;
import dk.cavi.sessionhistory.domain.SessionStorage;
import dk.cavi.sessionhistory.domain.processors.ProcessorDeserializer;
import java.io.IOException;
import java.util.logging.Logger;

/**
 *
 * @author jbk
 */
public class SessionManager extends HttpServlet {
    private static final Logger LOGGER = Logger.getLogger(SessionManager.class.getName());

    @Override
    protected void doPost(HttpServletRequest request, HttpServletResponse response) throws IOException {
        // The EntityAuthFilter has authenticated this request: the entityKey
        // it presented proves ownership of the entity id in the body. This
        // only double-checks that the filter really ran (fail closed).
        String authenticatedEntity = (String) request.getAttribute(EntityAuth.ENTITY_ATTRIBUTE);
        if (authenticatedEntity == null) {
            response.setStatus(HttpServletResponse.SC_INTERNAL_SERVER_ERROR);
            response.setContentType("text/plain;charset=utf-8");
            response.getWriter().println("SessionManager reached without an authenticated entity - is the auth filter mapped?");
            return;
        }

        // Parse request - the whole body goes through the ProcessorDeserializer
        // reader so spec.processors entries deserialize polymorphically into
        // their exact processor and config classes (fields the spec leaves out
        // keep the config classes' built-in defaults).
        Gson gson = ProcessorDeserializer.getReader();
        SessionRequest jsonRequest;
        try {
            jsonRequest = gson.fromJson(request.getReader(), SessionRequest.class);
        } catch (JsonParseException ex) {
            respond400(response, "Invalid session creation request: "+ex.getMessage()
                +" - POST {spec:{processors:[{name,type,config},...], models:[{name,config:{inputs:{...}}},...]}} (see /default-spec.json)");
            return;
        }
        if (jsonRequest == null || jsonRequest.spec == null) {
            respond400(response, "Must provide a session spec - POST {spec:{processors:[...], models:[...]}} "
                +"(fetch /default-spec.json for a generic starting point, /application-spec.json for the reference app setup, "
                +"or send an empty spec {processors:[],models:[]} for a bare session)");
            return;
        }

        SessionStorage storage;
        try {
            storage = SessionStorage.create(jsonRequest.spec);
        } catch (IllegalArgumentException ex) {
            respond400(response, "Invalid session spec: "+ex.getMessage());
            return;
        }

        // The owner is painted by the server from the authenticated entity -
        // it is never taken from (or overridable through) the request body.
        LOGGER.info("Created new session " + storage.getId() + " for entity: " + authenticatedEntity);
        storage.getSchema().owner = authenticatedEntity;
        storage.saveConfig();

        SessionResponse s = new SessionResponse();
        s.sessionId = storage.getId();

        // Return the 201 CREATED status with the JSON response body
        response.setStatus(HttpServletResponse.SC_CREATED); // 201 Created
        response.setContentType("application/json");
        gson.toJson(s, response.getWriter());
    }
    
    /**
     * The creation request body: only the session spec - the owner entity is
     * the authenticated entityKey's entity (painted by the server), and
     * bookkeeping fields (serverVersion, created, ...) are never
     * client-settable. Unknown JSON members are ignored by Gson.
     */
    private static class SessionRequest {
        private SessionSpec spec;
    }

    public class SessionResponse {
        private String sessionId;
    }

    private static void respond400(HttpServletResponse response, String message) throws IOException {
        response.setStatus(HttpServletResponse.SC_BAD_REQUEST);
        response.setContentType("text/plain;charset=utf-8");
        response.getWriter().println(message);
    }
}