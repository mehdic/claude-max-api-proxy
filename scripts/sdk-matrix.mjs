#!/usr/bin/env node
/**
 * Live SDK/client compatibility matrix for claude-proxy.
 *
 * Requires a running proxy. Uses built-in fetch + Python stdlib everywhere,
 * and opportunistically exercises official OpenAI Node/Python and LangChain
 * clients when they are installed. Set SDK_MATRIX_REQUIRE_OPTIONAL=1 to fail
 * if optional SDKs are missing.
 */

import { spawnSync } from "node:child_process";

const BASE_URL = process.env.SDK_MATRIX_BASE_URL || "http://127.0.0.1:3456";
const MODEL = process.env.SDK_MATRIX_MODEL || "claude-haiku-4-5-20251001";
const TIMEOUT_MS = Number(process.env.SDK_MATRIX_TIMEOUT_MS || 90_000);
const REQUIRE_OPTIONAL = process.env.SDK_MATRIX_REQUIRE_OPTIONAL === "1";

const results = [];

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  const label = ok ? "PASS" : detail.startsWith("SKIP") ? "SKIP" : "FAIL";
  console.log(`[${label}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function fetchJson(path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer local-test" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSse(path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer local-test" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    return text.split("\n\n").filter(Boolean).map((block) => Object.fromEntries(block.split("\n").map((line) => {
      const idx = line.indexOf(":");
      return idx < 0 ? [line, ""] : [line.slice(0, idx), line.slice(idx + 1).trimStart()];
    })));
  } finally {
    clearTimeout(timer);
  }
}

function isClaudeLimitText(value) {
  return /hit your limit|resets/i.test(String(value || ""));
}

function toolBodyChat() {
  return {
    model: MODEL,
    messages: [{ role: "user", content: "Return ONLY one external tool call for lookup_city with city Zurich." }],
    tools: [{ type: "function", function: { name: "lookup_city", description: "Lookup city info", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }],
    tool_choice: { type: "function", function: { name: "lookup_city" } },
    max_tokens: 128,
  };
}

async function coreFetchMatrix() {
  const health = await fetch(`${BASE_URL}/health`).then((r) => r.json());
  if (health.status !== "ok") throw new Error(`health status ${health.status}`);
  record("fetch:/health", true, `runtime=${health.runtime}`);

  const chat = await fetchJson("/v1/chat/completions", { model: MODEL, messages: [{ role: "user", content: "Reply exactly: ok" }], max_tokens: 16 });
  if (!chat.choices?.[0]?.message?.content) throw new Error("chat missing content");
  record("fetch:chat non-stream", true);

  const chatSse = await fetchSse("/v1/chat/completions", { model: MODEL, messages: [{ role: "user", content: "Reply exactly: ok" }], stream: true, max_tokens: 16 });
  if (!chatSse.some((b) => b.data === "[DONE]")) throw new Error("chat stream missing DONE");
  record("fetch:chat stream", true, `${chatSse.length} blocks`);

  const responses = await fetchJson("/v1/responses", { model: MODEL, input: "Reply exactly: ok", max_output_tokens: 16 });
  if (responses.object !== "response" || !Array.isArray(responses.output)) throw new Error("responses envelope invalid");
  record("fetch:responses non-stream", true);

  const responsesSse = await fetchSse("/v1/responses", { model: MODEL, input: "Reply exactly: ok", stream: true, max_output_tokens: 16 });
  if (!responsesSse.some((b) => b.event === "response.completed")) throw new Error("responses stream missing completed");
  record("fetch:responses stream", true, `${responsesSse.length} blocks`);

  const toolChat = await fetchJson("/v1/chat/completions", toolBodyChat());
  const chatTool = toolChat.choices?.[0]?.message?.tool_calls?.[0]?.function?.name;
  if (chatTool) record("fetch:chat tool_calls", true, chatTool);
  else if (isClaudeLimitText(toolChat.choices?.[0]?.message?.content)) record("fetch:chat tool_calls", false, "SKIP Claude subscription limit text returned");
  else throw new Error("chat tool call missing");

  const toolResponses = await fetchJson("/v1/responses", {
    model: MODEL,
    input: "Return ONLY one external tool call for lookup_city with city Zurich.",
    tools: toolBodyChat().tools,
    tool_choice: toolBodyChat().tool_choice,
    max_output_tokens: 128,
  });
  if (toolResponses.output?.some((item) => item.type === "function_call" && item.name === "lookup_city")) {
    record("fetch:responses function_call", true);
  } else if (isClaudeLimitText(toolResponses.output_text)) {
    record("fetch:responses function_call", false, "SKIP Claude subscription limit text returned");
  } else {
    throw new Error("responses function_call output missing");
  }
}

async function optionalNodeOpenAI() {
  try {
    const mod = await import("openai");
    const OpenAI = mod.default;
    const client = new OpenAI({ apiKey: "local-test", baseURL: `${BASE_URL}/v1` });
    const chat = await client.chat.completions.create({ model: MODEL, messages: [{ role: "user", content: "Reply exactly: ok" }], max_tokens: 16 });
    if (!chat.choices?.[0]?.message?.content) throw new Error("missing chat content");
    const resp = await client.responses.create({ model: MODEL, input: "Reply exactly: ok", max_output_tokens: 16 });
    if (!resp.output || !resp.id) throw new Error("missing responses output");
    record("openai-node", true);
  } catch (err) {
    const missing = String(err?.code || err?.message || err).includes("ERR_MODULE_NOT_FOUND") || String(err).includes("Cannot find package 'openai'");
    if (missing && !REQUIRE_OPTIONAL) record("openai-node", false, "SKIP package openai not installed");
    else throw err;
  }
}

function runPython(name, code) {
  const proc = spawnSync("python3", ["-c", code], {
    env: { ...process.env, SDK_MATRIX_BASE_URL: BASE_URL, SDK_MATRIX_MODEL: MODEL },
    encoding: "utf8",
    timeout: TIMEOUT_MS,
  });
  if (proc.status === 0) {
    record(name, true, proc.stdout.trim());
    return;
  }
  const combined = `${proc.stdout}\n${proc.stderr}`;
  if (combined.includes("No module named 'openai'") && !REQUIRE_OPTIONAL) {
    record(name, false, "SKIP package openai not installed");
    return;
  }
  throw new Error(`${name} failed: ${combined}`);
}

function pythonStdlib() {
  runPython("python-stdlib", String.raw`
import json, os, urllib.request
base=os.environ['SDK_MATRIX_BASE_URL']; model=os.environ['SDK_MATRIX_MODEL']
req=urllib.request.Request(base+'/v1/chat/completions', data=json.dumps({'model':model,'messages':[{'role':'user','content':'Reply exactly: ok'}],'max_tokens':16}).encode(), headers={'content-type':'application/json','authorization':'Bearer local-test'}, method='POST')
body=json.loads(urllib.request.urlopen(req, timeout=90).read().decode())
assert body['choices'][0]['message']['content']
print('chat ok')
`);
}

function optionalPythonOpenAI() {
  runPython("openai-python", String.raw`
import os
from openai import OpenAI
client=OpenAI(api_key='local-test', base_url=os.environ['SDK_MATRIX_BASE_URL']+'/v1')
chat=client.chat.completions.create(model=os.environ['SDK_MATRIX_MODEL'], messages=[{'role':'user','content':'Reply exactly: ok'}], max_tokens=16)
assert chat.choices[0].message.content
resp=client.responses.create(model=os.environ['SDK_MATRIX_MODEL'], input='Reply exactly: ok', max_output_tokens=16)
assert resp.id
print('chat+responses ok')
`);
}

async function optionalLangChain() {
  try {
    const mod = await import("@langchain/openai");
    const ChatOpenAI = mod.ChatOpenAI;
    const llm = new ChatOpenAI({ apiKey: "local-test", model: MODEL, configuration: { baseURL: `${BASE_URL}/v1` }, maxTokens: 16 });
    const msg = await llm.invoke("Reply exactly: ok");
    if (!msg.content) throw new Error("missing LangChain content");
    record("langchain-js", true);
  } catch (err) {
    const missing = String(err?.code || err?.message || err).includes("ERR_MODULE_NOT_FOUND") || String(err).includes("Cannot find package '@langchain/openai'");
    if (missing && !REQUIRE_OPTIONAL) record("langchain-js", false, "SKIP package @langchain/openai not installed");
    else throw err;
  }
}

try {
  await coreFetchMatrix();
  await optionalNodeOpenAI();
  pythonStdlib();
  optionalPythonOpenAI();
  await optionalLangChain();
  const failed = results.filter((r) => !r.ok && !r.detail.startsWith("SKIP"));
  const skipped = results.filter((r) => r.detail.startsWith("SKIP"));
  console.log(`\nSDK matrix: ${results.length - failed.length - skipped.length} passed, ${skipped.length} skipped, ${failed.length} failed`);
  process.exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exitCode = 1;
}
