/**
 * Protocol and error classification with bounded labels.
 *
 * Replaces ad-hoc string matching with an explicit taxonomy. Every error
 * the proxy encounters maps to exactly one ProtocolErrorClass — a fixed
 * set safe for Prometheus labels and trace records.
 */

/**
 * Bounded error classification. New classes require a code change,
 * keeping metrics cardinality controlled.
 */
export type ProtocolErrorClass =
  // Stream-json transport faults (fallback-eligible)
  | "init_handshake_timeout"
  | "worker_died"
  | "turn_timeout"
  | "spawn_enoent"
  | "stdin_closed"
  | "worker_invalid"
  | "control_protocol"
  // Upstream faults
  | "upstream_soft_dead"
  | "upstream_hard_dead"
  // Model-layer errors (not fallback-eligible)
  | "rate_limit"
  | "auth_error"
  | "content_policy"
  | "context_length"
  // Client errors
  | "invalid_request"
  // Proxy internal
  | "internal_error"
  // Unknown / catch-all
  | "other_stream_fault"
  | "unknown";

/**
 * Classify an error into a bounded ProtocolErrorClass.
 * Used for both fallback decisions and trace/metrics recording.
 */
export function classifyError(err: unknown): ProtocolErrorClass {
  if (!(err instanceof Error)) return "unknown";
  const msg = err.message.toLowerCase();

  // Stream-layer faults (transport)
  if (msg.includes("init handshake timed out")) return "init_handshake_timeout";
  if (msg.includes("subprocess closed before result")) return "worker_died";
  if (msg.includes("turn timed out")) return "turn_timeout";
  if (msg.includes("claude cli not found") || msg.includes("enoent")) return "spawn_enoent";
  if (msg.includes("stdin not writable")) return "stdin_closed";
  if (msg.includes("subprocess not initialized") || msg.includes("subprocess is dead")) return "worker_invalid";
  if (msg.includes("control error")) return "control_protocol";

  // Upstream faults
  if (msg.includes("upstream soft-dead") || msg.includes("upstream_dead")) return "upstream_soft_dead";

  // Model-layer errors
  if (msg.includes("rate limit") || msg.includes("429")) return "rate_limit";
  if (msg.includes("unauthorized") || msg.includes("401") || msg.includes("auth")) return "auth_error";
  if (msg.includes("content policy") || msg.includes("safety")) return "content_policy";
  if (msg.includes("context length") || msg.includes("too many tokens")) return "context_length";

  return "other_stream_fault";
}

/**
 * Whether an error class represents a stream-layer fault eligible for
 * --print fallback retry.
 */
export function isStreamLayerFaultClass(cls: ProtocolErrorClass): boolean {
  switch (cls) {
    case "init_handshake_timeout":
    case "worker_died":
    case "turn_timeout":
    case "spawn_enoent":
    case "stdin_closed":
    case "worker_invalid":
    case "control_protocol":
    case "other_stream_fault":
      return true;
    default:
      return false;
  }
}

/**
 * Whether an error looks like a stream-layer fault worth retrying.
 * Drop-in replacement for the old `isStreamLayerFault` in routes.ts.
 */
export function isStreamLayerFault(err: unknown): boolean {
  return isStreamLayerFaultClass(classifyError(err));
}
