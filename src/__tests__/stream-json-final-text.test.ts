import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_FINAL_RESPONSE_FALLBACK,
  resolveStreamJsonFinalText,
} from "../server/routes.js";

test("final-only stream-json does not promote progress-only deltas to final text", () => {
  const resolved = resolveStreamJsonFinalText({
    resultText: "",
    assistantMessageText: "",
    contentDeltaText: "Bubbling...\n🫧 Working: thinking…\nPytest is still running...",
    allowContentDeltaFallback: false,
  });

  assert.equal(resolved.text, EMPTY_FINAL_RESPONSE_FALLBACK);
  assert.equal(resolved.source, "fallback");
  assert.equal(resolved.usedFallback, true);
});

test("stream-json final text prefers Claude CLI result text", () => {
  const resolved = resolveStreamJsonFinalText({
    resultText: "Final answer",
    assistantMessageText: "Assistant message fallback",
    contentDeltaText: "Bubbling...\nprogress",
    allowContentDeltaFallback: false,
  });

  assert.equal(resolved.text, "Final answer");
  assert.equal(resolved.source, "result_text");
  assert.equal(resolved.usedFallback, false);
});

test("stream-json final text can use assistant message text when result text is missing", () => {
  const resolved = resolveStreamJsonFinalText({
    resultText: "",
    assistantMessageText: "Final assistant message",
    contentDeltaText: "Bubbling...\nprogress",
    allowContentDeltaFallback: false,
  });

  assert.equal(resolved.text, "Final assistant message");
  assert.equal(resolved.source, "assistant_message");
  assert.equal(resolved.usedFallback, false);
});

test("stream-json only uses content deltas as final text when explicitly allowed", () => {
  const resolved = resolveStreamJsonFinalText({
    resultText: "",
    assistantMessageText: "",
    contentDeltaText: "Live streamed final answer",
    allowContentDeltaFallback: true,
  });

  assert.equal(resolved.text, "Live streamed final answer");
  assert.equal(resolved.source, "buffered_text");
  assert.equal(resolved.usedFallback, false);
});
