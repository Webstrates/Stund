/**
 * HealthServlet
 * Serves GET /health: a small JSON report of the server's self-observations
 * for Zabbix (or any uptime monitor). The report is read back from the
 * booleans and counters that Health maintains as a side effect of the
 * server doing its usual work, so answering costs no file-system or
 * lock activity and polling cannot burden the server. Answers 200 when
 * everything is green, 503 when any observation is degraded.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.endpoints;

import dk.cavi.sessionhistory.core.Health;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 *
 * @author jbk
 */
public class HealthServlet extends HttpServlet {
    @Override
    protected void doGet(HttpServletRequest request, HttpServletResponse response) throws IOException {
        // One serialization decides both the code and the body (Health puts
        // "status" first), so they can never disagree about a check that
        // flips between two separate reads.
        String json = Health.snapshotJson();
        byte[] body = json.getBytes(StandardCharsets.UTF_8);
        response.setContentType("application/json;charset=utf-8");
        response.setContentLength(body.length);
        response.setStatus(json.startsWith("{\"status\":\"ok\"") ? HttpServletResponse.SC_OK
                : HttpServletResponse.SC_SERVICE_UNAVAILABLE);
        response.getOutputStream().write(body);
    }
}
