import test from "node:test";
import assert from "node:assert/strict";
import { parseClaudeHelpFlags, pushClaudeFlagIfSupported } from "../subprocess/claude-flags.js";

test("parseClaudeHelpFlags extracts long flags from help text", () => {
  const flags = parseClaudeHelpFlags(`Usage: claude [options]\n  --model <model>\n  --input-format <fmt>, --output-format <fmt>\n  --include-partial-messages\n`);
  assert.deepEqual(flags, ["--include-partial-messages", "--input-format", "--model", "--output-format"]);
});

test("parseClaudeHelpFlags returns empty set for missing help", () => {
  assert.deepEqual(parseClaudeHelpFlags("no flags here"), []);
});

test("pushClaudeFlagIfSupported does nothing when not requested", async () => {
  const args = ["--model", "haiku"];
  const ok = await pushClaudeFlagIfSupported(args, "--definitely-not-a-real-flag", { requested: false });
  assert.equal(ok, false);
  assert.deepEqual(args, ["--model", "haiku"]);
});
