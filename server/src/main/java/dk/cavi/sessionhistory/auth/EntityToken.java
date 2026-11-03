/**
 * Entity Token
 * The JSON model of a token file in the tokens directory: proof that its
 * holder owns the named entity. The file name (not the content) is the
 * secret entityKey — this class is what the file contains.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.auth;

/**
 *
 * @author jbk
 */
public class EntityToken {
    /** The entity this token grants. Must match the entity id a client tries to act as. */
    public String entity;
    /** Milliseconds since epoch: when the token was minted. */
    public long created;
    /** Milliseconds since epoch: when the token stops being valid. */
    public long expires;
    /** How the token was minted: "pass" (master password) or "openid" (OIDC login, planned). */
    public String source;
    /** The secret key (the token file name). Set by the TokenStore, never serialized. */
    public transient String key;
}
