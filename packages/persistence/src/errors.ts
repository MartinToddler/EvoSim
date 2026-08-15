/**
 * Storage-layer failures, as data the UI can act on.
 *
 * Persistence fails for reasons that call for genuinely different responses —
 * "your disk is full" is a user action, "another tab is upgrading the schema"
 * is a retry, "this save was written by an older engine" is neither — so the
 * kind travels with the error instead of being reverse-engineered from message
 * text.
 */
export type PersistenceErrorKind =
  /** IndexedDB is missing or refused to open (private mode, locked-down WebView). */
  | "unavailable"
  /** Another connection is blocking a schema upgrade. */
  | "blocked"
  /** Storage quota exhausted. */
  | "quota"
  /** A read or write failed for an unclassified reason. */
  | "io"
  /** The stored data exists but this build cannot use it. */
  | "version"
  /** The requested world or snapshot is not there. */
  | "not-found"
  /** Stored bytes failed validation; see the cause for the specific code. */
  | "corrupt"
  /** The caller asked for something contradictory; storage is fine, the request is not. */
  | "invalid-request";

export class PersistenceError extends Error {
  readonly kind: PersistenceErrorKind;

  constructor(kind: PersistenceErrorKind, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PersistenceError";
    this.kind = kind;
  }
}

/** Human-readable one-liner for any failure, for status lines and toasts. */
export function describePersistenceError(error: unknown): string {
  if (error instanceof PersistenceError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
