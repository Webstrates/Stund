/**
 * Token Store
 * Minting and validation of entity tokens: one JSON file per token in the
 * tokens base directory (the auth.tokenPath config, "tokens" by default),
 * the file name being the secret entityKey. Tokens carry the entity they
 * grant, their creation and expiry times, and how they were minted
 * ("pass" for master-password logins; "openid" is reserved for the planned
 * OpenID Connect browser login).
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.auth;

import com.google.gson.Gson;
import com.google.gson.JsonSyntaxException;
import dk.cavi.sessionhistory.core.Core;
import dk.cavi.sessionhistory.core.ServerConfig;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.logging.Level;
import java.util.logging.Logger;
import java.util.regex.Pattern;

/**
 *
 * @author jbk
 */
public class TokenStore {
    private static final Logger LOGGER = Logger.getLogger(TokenStore.class.getName());
    private static final Gson gson = new Gson();
    private static final SecureRandom random = new SecureRandom();

    /**
     * The shape of a valid entityKey: 32 random bytes Base64url-encoded
     * (43 characters). Also doubles as the path-traversal guard — the key
     * becomes a file name, so it must be checked against this pattern
     * BEFORE it is ever resolved to a path.
     */
    private static final Pattern KEY_PATTERN = Pattern.compile("[A-Za-z0-9_-]{20,64}");

    private static File tokenDir = null;

    /** Rejection of a presented entityKey, with a message safe for the client. */
    public static class TokenException extends Exception {
        public TokenException(String message) {
            super(message);
        }
    }

    /**
     * Prepares the tokens base directory: creates it if needed, verifies it
     * is writable, and sweeps token files whose lifetime is over. Called
     * once at server startup (mirroring the sessions base directory checks
     * in Main); later calls are no-ops.
     * @return The tokens base directory.
     * @throws IOException If the directory cannot be created or written to.
     */
    public static synchronized Path init() throws IOException {
        if (tokenDir != null) return tokenDir.toPath();
        ServerConfig.AuthConfig auth = authConfig();
        File dir = new File(auth.tokenPath);
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Unable to create the tokens directory "+dir.getAbsolutePath());
        try {
            Path probe = Files.createTempFile(dir.toPath(), "shs-tokens-check-", ".tmp");
            Files.delete(probe);
        } catch (IOException e) {
            throw new IOException("The tokens directory "+dir.getAbsolutePath()+" is not writable", e);
        }
        tokenDir = dir;
        sweepExpired();
        return dir.toPath();
    }

    /**
     * Deletes token files past their expiry. Malformed files are left
     * alone (they fail validation as unknown keys anyway; destroying data
     * on a parse hiccup is worse than leaving it).
     */
    private static void sweepExpired() {
        long now = System.currentTimeMillis();
        try (DirectoryStream<Path> files = Files.newDirectoryStream(tokenDir.toPath(), "*.json")) {
            for (Path file : files) {
                EntityToken token = readToken(file);
                if (token != null && token.expires <= now) {
                    try { Files.deleteIfExists(file); LOGGER.fine("Deleted expired entity token for entity "+token.entity); } catch (IOException e) { LOGGER.log(Level.WARNING, "Failed to delete the expired entity token file for entity "+token.entity, e); }
                }
            }
        } catch (IOException e) {
            LOGGER.log(Level.WARNING, "Failed to sweep the tokens directory "+tokenDir+" for expired entity tokens", e);
        }
    }

    /**
     * Mints a new token for an entity and persists it as its own file. The
     * file name is the secret entityKey: 256 bits of SecureRandom,
     * Base64url-encoded. The write is atomic (temp file + move) so no
     * reader ever sees a half-written token.
     * @param entity The entity the token grants.
     * @param source How the token was minted ("pass" or "openid").
     * @return The minted token, with its key set.
     * @throws IOException If the token file cannot be written.
     */
    public static synchronized EntityToken create(String entity, String source) throws IOException {
        init();
        byte[] keyBytes = new byte[32];
        random.nextBytes(keyBytes);
        String key = Base64.getUrlEncoder().withoutPadding().encodeToString(keyBytes);

        ServerConfig.AuthConfig auth = authConfig();
        EntityToken token = new EntityToken();
        token.entity = entity;
        token.created = System.currentTimeMillis();
        token.expires = token.created + (long) (auth.tokenLifetimeDays * 24L * 60L * 60L * 1000L);
        token.source = source;

        Path file = new File(tokenDir, key + ".json").toPath();
        Path temp = Files.createTempFile(tokenDir.toPath(), "mint-", ".tmp");
        try {
            Files.writeString(temp, gson.toJson(token), StandardCharsets.UTF_8);
            Files.move(temp, file, StandardCopyOption.ATOMIC_MOVE);
        } finally {
            Files.deleteIfExists(temp); // no-op on success; cleans up on failure
        }
        token.key = key;
        LOGGER.info("Minted entity token for entity "+entity+" (source "+source+", valid for "+auth.tokenLifetimeDays+" days)");
        return token;
    }

    /**
     * Validates a presented entityKey: it must have the shape of a minted
     * key, its token file must exist and parse, and it must not have
     * expired. Expired tokens are rejected and their file deleted.
     * @param key The presented entityKey (may be null — rejected).
     * @return The token, with its key set.
     * @throws TokenException With a client-safe message if the key is not
     *         presented, unknown, malformed, or expired.
     */
    public static EntityToken validate(String key) throws TokenException {
        if (key == null || key.isBlank()) throw new TokenException("No entityKey presented — POST /login with the master password to obtain one, then send it as 'Authorization: Bearer <entityKey>' (or '?entityKey=', 'X-Entity-Key' or the entityKey cookie)");
        if (!KEY_PATTERN.matcher(key).matches()) throw new TokenException("Unknown entityKey");
        Path file = new File(getDir(), key + ".json").toPath();
        if (!Files.isRegularFile(file)) throw new TokenException("Unknown entityKey");
        EntityToken token = readToken(file);
        if (token == null || token.entity == null || token.entity.isBlank()) throw new TokenException("Unknown entityKey");
        if (token.expires <= System.currentTimeMillis()) {
            try { Files.deleteIfExists(file); } catch (IOException e) { LOGGER.log(Level.WARNING, "Failed to delete the expired entity token file for entity "+token.entity, e); }
            throw new TokenException("The entityKey has expired — POST /login again to mint a new one");
        }
        token.key = key;
        return token;
    }

    /**
     * Reads and parses a token file, or null if it is missing or not a
     * valid token. No expiry checking happens here.
     */
    private static EntityToken readToken(Path file) {
        try {
            EntityToken token = gson.fromJson(Files.readString(file, StandardCharsets.UTF_8), EntityToken.class);
            if (token == null) return null;
            if (token.entity == null || token.entity.isBlank()) return null;
            if (token.expires <= 0) return null;
            return token;
        } catch (IOException | JsonSyntaxException e) {
            return null;
        }
    }

    /**
     * The tokens base directory, initializing it if needed. The init in
     * Main runs before any request can arrive, so this is a fallback.
     */
    private static File getDir() {
        if (tokenDir == null) {
            try { init(); } catch (IOException e) { throw new IllegalStateException("The tokens directory is unusable: "+e.getMessage(), e); }
        }
        return tokenDir;
    }

    private static ServerConfig.AuthConfig authConfig() {
        ServerConfig config = Core.getServerConfig();
        if (config.auth != null) return config.auth;
        return new ServerConfig.AuthConfig(); // "auth": null in config.json — fall back to defaults
    }
}
