import test from "node:test";
import assert from "node:assert/strict";
import { shouldHoldBridgeToolStreamText } from "../server/routes.js";

test("bridge streaming holds possible raw JSON tool calls", () => {
  assert.equal(shouldHoldBridgeToolStreamText(""), true);
  assert.equal(shouldHoldBridgeToolStreamText("   "), true);
  assert.equal(shouldHoldBridgeToolStreamText(" {\"tool_call\": {\"name\": \"read\", \"arguments\": {}}}"), true);
});

test("bridge streaming holds possible fenced JSON tool calls", () => {
  assert.equal(shouldHoldBridgeToolStreamText("`"), true);
  assert.equal(shouldHoldBridgeToolStreamText("``"), true);
  assert.equal(shouldHoldBridgeToolStreamText("```json\n"), true);
  assert.equal(shouldHoldBridgeToolStreamText("```json\n{\"tool_call\":"), true);
});

test("bridge streaming releases normal prose", () => {
  assert.equal(shouldHoldBridgeToolStreamText("Sure — here is the answer."), false);
  assert.equal(shouldHoldBridgeToolStreamText("\n\nThe answer is 42."), false);
});

test("bridge streaming releases non-json fenced content", () => {
  assert.equal(shouldHoldBridgeToolStreamText("```ts\nconsole.log('hi')"), false);
  assert.equal(shouldHoldBridgeToolStreamText("```\nplain code block"), false);
});
