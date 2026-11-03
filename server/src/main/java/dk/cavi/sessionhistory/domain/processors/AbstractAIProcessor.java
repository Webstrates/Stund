/**
 * Abstract AI Processor
 * Base for processors calling OpenAI-compatible services: builds the API client
 * from a named connection in the server configuration and provides the shared
 * model, prompt, timeout and connection settings.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain.processors;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import com.fasterxml.jackson.annotation.JsonPropertyDescription;
import com.openai.client.OpenAIClient;
import com.openai.client.okhttp.OpenAIOkHttpClient;

import dk.cavi.sessionhistory.core.Core;
import dk.cavi.sessionhistory.core.ServerConfig.OpenAIConnection;
import dk.cavi.sessionhistory.domain.SessionStorage;
import java.time.Duration;

/**
 *
 * @author jbk
 */
public abstract class AbstractAIProcessor extends Processor {
    protected transient final ExecutorService openAI = Executors.newFixedThreadPool(1);

    @Override
    public void init(SessionStorage session, String name, ProcessorConfig conf) {
        super.init(session, name, conf);
    }
   
    public OpenAIBaseConfig getConfig(){
        return (OpenAIBaseConfig) config;
    }
    public OpenAIConnection getConnectionConfig(){
        OpenAIConnection connection = Core.getServerConfig().openAIConnections.get(getConfig().connection);
        if (connection==null) throw new IllegalArgumentException("Unknown OpenAI connection '"+getConfig().connection+"' in the processor settings - define it in the openAIConnections section of config.json (see config.json.sample)");
        return connection;
    }
        
    public OpenAIClient getClient() {
        OpenAIConnection connectionConfig = getConnectionConfig();
        OpenAIOkHttpClient.Builder builder = OpenAIOkHttpClient.builder()
                .baseUrl(connectionConfig.url)
                .timeout(Duration.ofSeconds(getConfig().timeout))
                .maxRetries(2);

        builder.apiKey(connectionConfig.key);
        return builder.build();
    }
    
    public static abstract class OpenAIBaseConfig extends ProcessorConfig {
        @JsonPropertyDescription("The AI model to use (the server's ai.defaultModel from config.json when unset)")
        public String model = Core.getServerConfig().ai.defaultModel;

        @JsonPropertyDescription("A prompt that guides the AI")
        public String prompt = "fail";

        @JsonPropertyDescription("Number of seconds before cancelling a prompt")
        protected int timeout = 60;

        @JsonPropertyDescription("Identifier of the connection credentials to use (an openAIConnections entry in config.json - 'default' unless configured otherwise)")
        protected String connection = "default";
    }
}
