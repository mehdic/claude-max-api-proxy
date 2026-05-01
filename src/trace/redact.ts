/**
 * Trace redaction — strips secrets, auth headers, credential env values,
 * and large prompt bodies from trace records.
 *
 * Policy: traces should contain structured debug metadata, never raw
 * secrets or user content. Tool argument values are replaced with type
 * indicators; only keys are preserved.
 */

/** Patterns that indicate a value is secret and should not appear in traces. */
const SECRET_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /token/i,
  /bearer/i,
  /authorization/i,
  /credential/i,
  /private[_-]?key/i,
  /passphrase/i,
];

/**
 * Check if a key name looks like it holds a secret value.
 */
export function isSecretKey(key: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(key));
}

/**
 * Extract only the top-level keys from a JSON arguments string.
 * Returns key names only — values are never stored in traces.
 */
export function extractArgumentKeys(argsJson: string): string[] {
  try {
    const parsed = JSON.parse(argsJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.keys(parsed);
    }
  } catch {
    // malformed JSON — return empty
  }
  return [];
}

/**
 * Redact env values from a record, replacing secret-looking keys with "[REDACTED]".
 * Non-secret values are left as-is. Returns a new object.
 */
export function redactEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = isSecretKey(k) ? "[REDACTED]" : v;
  }
  return out;
}

/**
 * Produce a safe tool-choice label for trace records.
 */
export function redactToolChoice(
  choice: "auto" | "none" | "required" | { type: "function"; function: { name: string } } | undefined,
): string {
  if (choice === undefined) return "auto";
  if (typeof choice === "string") return choice;
  if (typeof choice === "object" && choice.type === "function") {
    return `function:${choice.function.name}`;
  }
  return "unknown";
}
