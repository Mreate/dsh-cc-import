/**
 * Import provider abstraction.
 *
 * One implementation per agent product (claude-code first, then cursor/codex/...).
 * A provider owns discovery, listing, and the conversion of one product's
 * conversation history into a resumable DSH session.
 */

/** Lightweight session summary shown in a list/picker. */
export interface ImportedSessionSummary {
  provider: string
  /** File basename, e.g. `abc123.jsonl`. */
  fileName: string
  /** Path relative to the data root's project directory. */
  relPath: string
  /** Encoded project directory the session belongs to. */
  projectDir: string
  size?: number
  /** Human title when the provider can derive one cheaply. */
  title?: string
  createdAt?: number
  /** Original working directory recorded in the source session. */
  cwd?: string
}

/** Outcome of importing one conversation into a DSH session. */
export interface ImportResult {
  sessionId: string
  eventCount: number
  /** Whether the session is now visible in sessionPersistence.list(). */
  listed: boolean
  /** Empty when sessionPersistence.inspect() loads the log cleanly. */
  inspectError?: string
  /** Non-empty on a hard failure (nothing was written). */
  error?: string
  /** Number of sub-agent side-chains imported as child sessions. */
  subagentCount?: number
  /** Non-empty when the session persisted but could not be attached to a workspace group. */
  attachError?: string
  /**
   * True when the source had been imported before and that session was later
   * archived in DSH, so a fresh session was created under a new `-reimport-N`
   * id (the archived session itself is left untouched).
   */
  reimported?: boolean
}

export interface ImportProvider {
  /** Stable id, e.g. `claude-code`. */
  readonly id: string
  readonly displayName: string
  /** Short icon label used by the client picker. */
  readonly icon: string

  /** Locate the product's data root (e.g. `~/.claude`), or undefined. */
  discoverDataRoot(): Promise<string | undefined>
  /** List importable sessions under the data root, optionally scoped to one workspace cwd. */
  listSessions(cwd?: string): Promise<ImportedSessionSummary[]>
  /** Read-only preview of one session as markdown. */
  previewSession(sessionId: string): Promise<{ markdown: string }>
  /**
   * Convert one session into DSH session events and persist it.
   * `cwd` overrides the imported session's workspace (default: the source cwd).
   * Idempotent: re-importing the same source returns the existing session.
   */
  importSession(sessionId: string, cwd?: string): Promise<ImportResult>
}
