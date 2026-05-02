/**
 * n8n progress fetcher (optional).
 *
 * When CLAUDE_PROXY_N8N_API_URL + CLAUDE_PROXY_N8N_API_KEY are set, the proxy
 * can query n8n's REST API to surface the status of a currently-running
 * workflow execution as a visible progress payload — instead of relying on
 * a generic transport-only SSE comment keepalive.
 *
 * Best-effort design:
 *   - We don't know the execution_id of the in-flight n8n run (claude calls
 *     the webhook from inside its Bash tool; we don't see the response).
 *     Instead we ask n8n for "the most recently started RUNNING execution"
 *     and assume it's the one claude triggered.
 *   - Cached for 3s to avoid hammering n8n on a 5s keepalive cycle.
 *   - All errors swallowed: this is a non-essential progress hint.
 *
 * No-op when env vars are unset.
 */

const N8N_API_URL = process.env.CLAUDE_PROXY_N8N_API_URL || "";
const N8N_API_KEY = process.env.CLAUDE_PROXY_N8N_API_KEY || "";
const ENABLED = !!(N8N_API_URL && N8N_API_KEY);

const CACHE_TTL_MS = 3000;
const FETCH_TIMEOUT_MS = 2500;

interface ProgressSnapshot {
  workflowName: string;
  executionId: string;
  startedAt: number;
  // n8n's API doesn't expose a clean "current node" field on /executions
  // without ?includeData=true (which is huge). For now we report what we have.
}

let cache: { value: ProgressSnapshot | null; at: number } | null = null;

export function n8nProgressEnabled(): boolean {
  return ENABLED;
}

export async function getRunningExecution(): Promise<ProgressSnapshot | null> {
  if (!ENABLED) return null;

  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(
      `${N8N_API_URL.replace(/\/$/, "")}/executions?status=running&limit=1`,
      {
        headers: { "X-N8N-API-KEY": N8N_API_KEY, Accept: "application/json" },
        signal: ctrl.signal,
      },
    );
    clearTimeout(timer);
    if (!res.ok) {
      cache = { value: null, at: Date.now() };
      return null;
    }
    const body = (await res.json()) as { data?: Array<{ id: string; workflowId: string; startedAt?: string; workflowData?: { name?: string } }> };
    const top = body.data?.[0];
    if (!top) {
      cache = { value: null, at: Date.now() };
      return null;
    }
    const snapshot: ProgressSnapshot = {
      workflowName: top.workflowData?.name || `workflow ${top.workflowId}`,
      executionId: top.id,
      startedAt: top.startedAt ? new Date(top.startedAt).getTime() : Date.now(),
    };
    cache = { value: snapshot, at: Date.now() };
    return snapshot;
  } catch {
    cache = { value: null, at: Date.now() };
    return null;
  }
}

/** Format a snapshot as a short human-readable line for embedding in a chunk. */
export function formatProgress(s: ProgressSnapshot): string {
  const elapsed = Math.max(0, Math.floor((Date.now() - s.startedAt) / 1000));
  return `[n8n: ${s.workflowName} · ${elapsed}s elapsed · exec ${s.executionId}]`;
}
