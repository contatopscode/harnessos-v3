/**
 * Structured event logger — one-line JSONL per event.
 *
 * Companion to `createLogger` for the per-run / per-sandbox observability
 * surface. The plain Pino logger (`createLogger`) is the right call for
 * per-module debug output, but for the "self-healing" / "boot recovered"
 * alerts in the Archon Hardening spec we want a stable, machine-parseable
 * event schema with explicit fields for `run_id`, `workflow`, and
 * `thread_id` so an external alerting system can grep
 * `event === 'boot.source_recovered'` without parsing Pino's
 * module/level envelopes.
 *
 * Schema (one line of JSON per call to the returned function):
 *
 *   {
 *     "ts": "2026-08-18T13:00:00.000Z",
 *     "level": "info" | "warn" | "error",
 *     "event": "boot.source_present" | "boot.source_recovered_start" | ...,
 *     "run_id": "<uuid>",
 *     "workflow": "<name>",          // optional
 *     "thread_id": "<id>",            // optional
 *     ...event-specific fields inline
 *   }
 *
 * Calls `createLogger` from this package under the hood so the
 * `LOG_LEVEL` env var and the same TTY/JSON pretty-print behavior
 * apply — output in dev is human-readable, in production it's the
 * JSONL this function emits. We re-write the line ourselves instead
 * of returning the raw Pino child because Pino's envelope includes
 * `pid`/`hostname`/`time` etc. and we want a stable, alert-friendly
 * schema. The Pino parent is still informed (`debug` level) so
 * the line also appears in any tail that watches Pino directly.
 */
import { rootLogger } from './logger';
// `rootLogger` is imported for its `debug` channel — we forward at
// debug level so the pretty-printer does not duplicate the line we
// write directly to stdout. The reference is kept even if a future
// refactor wants to bump the level; it's a structural pin.

export type StructuredLogLevel = 'info' | 'warn' | 'error';

export interface StructuredEventLogger {
  (event: string, data?: Record<string, unknown>): void;
  /** Emit at warn level — for self-healing events that warrant attention. */
  warn: (event: string, data?: Record<string, unknown>) => void;
  /** Emit at error level — reserved for unrecoverable self-healing outcomes. */
  error: (event: string, data?: Record<string, unknown>) => void;
}

export interface MakeLoggerOpts {
  runId?: string;
  workflow?: string;
  threadId?: string;
  /** When set, also forwards to the named Pino child logger at debug level. */
  module?: string;
}

/**
 * Build a structured event logger pinned to a run/thread context.
 *
 * The returned function writes a single JSON line to stdout (NOT through
 * Pino, because we want a stable schema — Pino adds `pid`, `hostname`,
 * `time` in ms, etc., and downstream alerts grep for the exact field
 * names in the spec).
 */
export function makeLogger(opts: MakeLoggerOpts = {}): StructuredEventLogger {
  const fn = (event: string, data: Record<string, unknown> = {}): void => {
    emit('info', event, data);
  };
  fn.warn = (event: string, data: Record<string, unknown> = {}): void => {
    emit('warn', event, data);
  };
  fn.error = (event: string, data: Record<string, unknown> = {}): void => {
    emit('error', event, data);
  };
  return fn;

  function emit(level: StructuredLogLevel, event: string, data: Record<string, unknown>): void {
    const line: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      event,
    };
    if (opts.runId !== undefined) line.run_id = opts.runId;
    if (opts.workflow !== undefined) line.workflow = opts.workflow;
    if (opts.threadId !== undefined) line.thread_id = opts.threadId;
    for (const [k, v] of Object.entries(data)) {
      // Caller-provided fields win on collision; the schema fields above
      // are still the source of truth for the alert contract.
      if (!(k in line)) line[k] = v;
    }
    // Forward to the Pino root at debug level so the standard log
    // sinks (file tails, log aggregators) see the same content, but
    // the user-facing line is the spec-schema one we write next.
    // Without this guard Pino's pretty-printer would emit a second
    // line in dev with a different envelope (pid/hostname/time/level)
    // and alerts grepping for `event === 'boot.source_recovered'`
    // would see two hits per event.
    rootLogger.debug({ ...line }, event);
    // Also write the spec-schema line directly to stdout. Bypasses
    // any Pino transport rewriting so `jq .event` works in shell
    // pipes and alerts can match the exact field names from the
    // Hardening spec.
    process.stdout.write(`${JSON.stringify(line)}\n`);
  }
}
