/**
 * The single canonical shape for an Aera control-plane identifier.
 *
 * Identifiers arrive from the cloud and are only ever compared, never decoded,
 * so the accepted version range stays deliberately wide (1 through 8) while the
 * variant nibble and overall layout stay strict. The reason is asymmetry, not a
 * particular version: the cloud client at the ingress boundary already accepts
 * the wide range, so any downstream validator pinned narrower would admit an
 * identifier at the edge and then reject it deeper in, surfacing as an invalid
 * request or a verification failure far from its cause. Today every plane mints
 * v4, so widening changes no live behavior; it removes the trap that appears the
 * moment one of them adopts a different version.
 *
 * This is a well-formedness check, never a substitute for authorization. Every
 * caller must still verify ownership, membership, and signatures separately.
 */
export const AGENTERA_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The case-sensitive spelling for identifiers that must already be canonical.
 *
 * Signed and digested payloads are compared byte for byte, so callers on those
 * paths reject uppercase spellings outright instead of normalizing them.
 */
export const AGENTERA_CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** True when `value` is a well-formed identifier in any accepted UUID version. */
export function isAgenteraUuid(value: unknown): value is string {
  return typeof value === "string" && AGENTERA_UUID_PATTERN.test(value);
}

/**
 * True when `value` is well formed and already lowercase.
 *
 * Responses that participate in signature or digest verification must be
 * byte-stable, so canonical comparisons reject uppercase spellings rather than
 * normalizing them.
 */
export function isCanonicalAgenteraUuid(value: unknown): value is string {
  return isAgenteraUuid(value) && value === value.toLowerCase();
}
