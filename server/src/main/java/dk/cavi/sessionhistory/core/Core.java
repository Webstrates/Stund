/**
 * Core
 * Global access point for the server configuration, loaded once from
 * config.json in the working directory with defaults as fallback.
 *
 * Copyright (c) 2025 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.core;

import com.google.gson.Gson;
import com.google.gson.JsonSyntaxException;
import java.io.File;
import java.io.FileReader;
import java.io.IOException;
import java.net.URI;
import java.nio.file.Paths;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 *
 * @author jbk
 */
public class Core {
    private static final Logger LOGGER = Logger.getLogger(Core.class.getName());
    private static ServerConfig config;
    private static final URI CONFIG_FILENAME = Paths.get("./config.json").toAbsolutePath().normalize().toUri();
    
    /**
     * Attempts to load configuration in the current working directory.
     * If the file is not found or parsing fails, it returns a default ServerConfig instance.
     * @return The loaded or default ServerConfig.
     */
    private static ServerConfig loadConfiguration() {
        // Define the path to the config file in the current working directory
        File configFile = Paths.get(CONFIG_FILENAME).toFile();
        Gson gson = new Gson();

        // Check if the file exists
        if (configFile.exists() && configFile.isFile()) {
            LOGGER.config("Found configuration file: " + configFile.getAbsolutePath());
            try (FileReader reader = new FileReader(configFile)) {
                ServerConfig loadedConfig = gson.fromJson(reader, ServerConfig.class);
                
                if (loadedConfig != null) {
                    LOGGER.info("Configuration loaded successfully from file.");
                    return loadedConfig;
                }
                
                // Fallthrough if fromJson somehow returns null (e.g., empty file)                
            } catch (IOException e) {
                LOGGER.log(Level.SEVERE, "I/O error reading config.json file - check permissions", e);
                System.exit(-1);
            } catch (JsonSyntaxException e) {
                LOGGER.log(Level.SEVERE, "Error parsing JSON in config.json - check file syntax", e);
                System.exit(-1);
            }
        } else {
            LOGGER.info("config.json not found in CWD. Using default configuration.");
        }

        // Return default configuration if the file doesn't exist or loading fails
        return new ServerConfig();
    }    
    
    public synchronized static ServerConfig getServerConfig(){
        if (config==null) config = loadConfiguration();
        return config;
    }
}
