/**
 * Meta Annotation
 * Marks event fields that are server-internal and should only be serialized in
 * specific situations, such as provenance and creation timestamps.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

package dk.cavi.sessionhistory.domain.model;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Meta annotation to tag fields that should only be serialized in specific situations.
 * This annotation can be used to indicate conditional serialization behavior.
 *
 * @author jbk
 */
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.FIELD)
public @interface Meta {
}
