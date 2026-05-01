import { execFile } from "child_process";

export interface ClaudeCliCapabilities {
  checkedAt: number;
  flags: string[];
  source: "claude --help" | "error";
  error?: string;
}

let cachedCapabilities: ClaudeCliCapabilities | null = null;

export function parseClaudeHelpFlags(helpText: string): string[] {
  const flags = new Set<string>();
  for (const match of helpText.matchAll(/(^|[\s,])(--[a-zA-Z0-9][a-zA-Z0-9-]*)(?=[\s,=]|$)/g)) {
    flags.add(match[2]);
  }
  return Array.from(flags).sort();
}

export async function getClaudeCliCapabilities(forceRefresh = false): Promise<ClaudeCliCapabilities> {
  if (cachedCapabilities && !forceRefresh) return cachedCapabilities;

  cachedCapabilities = await new Promise<ClaudeCliCapabilities>((resolve) => {
    const started = Date.now();
    const child = execFile("claude", ["--help"], { timeout: 5_000, maxBuffer: 512_000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({
          checkedAt: started,
          flags: [],
          source: "error",
          error: err.message || String(err),
        });
        return;
      }
      resolve({
        checkedAt: started,
        flags: parseClaudeHelpFlags(`${stdout}\n${stderr}`),
        source: "claude --help",
      });
    });
    child.stdin?.end();
  });

  return cachedCapabilities;
}

export async function supportsClaudeFlag(flag: string, forceRefresh = false): Promise<boolean> {
  const caps = await getClaudeCliCapabilities(forceRefresh);
  return caps.flags.includes(flag);
}

export async function pushClaudeFlagIfSupported(
  args: string[],
  flag: string,
  options: { requested?: boolean; value?: string; warn?: boolean } = {},
): Promise<boolean> {
  if (options.requested === false) return false;
  const supported = await supportsClaudeFlag(flag);
  if (supported) {
    args.push(flag);
    if (options.value !== undefined) args.push(options.value);
    return true;
  }
  if (options.warn !== false) {
    console.warn(`[Claude CLI] Skipping unsupported flag ${flag}. Current claude --help does not advertise it.`);
  }
  return false;
}

export function resetClaudeCliCapabilitiesForTests(): void {
  cachedCapabilities = null;
}
