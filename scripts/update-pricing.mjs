#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const out = process.env.CLAUDE_PROXY_PRICING_FILE || join(homedir(), ".claude-proxy", "pricing.json");
const now = new Date().toISOString().slice(0, 10);

const book = {
  updatedAt: now,
  source: "claude-proxy updater fallback; public pricing pages unavailable or incomplete",
  models: {
    "claude-opus-4-7": price(5, 25, "Anthropic Claude Opus 4.7 public pricing fallback"),
    "claude-opus-4-6": price(5, 25, "Anthropic Claude Opus 4.6 public pricing fallback"),
    "claude-opus-4": price(15, 75, "Anthropic public pricing page fallback"),
    "claude-sonnet-4-6": price(3, 15, "Anthropic Claude Sonnet 4.6 public pricing fallback"),
    "claude-sonnet-4-5": price(3, 15, "Anthropic public pricing page fallback"),
    "claude-sonnet-4": price(3, 15, "Anthropic public pricing page fallback"),
    "claude-haiku-4-5": price(1, 5, "Anthropic public pricing page fallback"),
    "claude-haiku-4": { ...price(1, 5, "family fallback aligned to Claude Haiku 4.5"), note: "estimated fallback" },
  },
};

function price(inputPer1M, outputPer1M, source) {
  return {
    inputPer1M,
    cacheCreationInputPer1M: roundPrice(inputPer1M * 1.25),
    cachedInputPer1M: roundPrice(inputPer1M * 0.1),
    outputPer1M,
    source,
    updatedAt: now,
  };
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "user-agent": "claude-proxy-pricing-refresh/1.0" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "user-agent": "claude-proxy-pricing-refresh/1.0" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

function normalizeModel(id) {
  const stripped = String(id || "").replace(/^(anthropic|openrouter\/anthropic)\//, "");
  if (/^claude-opus-4-7/.test(stripped)) return "claude-opus-4-7";
  if (/^claude-opus-4-6/.test(stripped)) return "claude-opus-4-6";
  if (/^claude-opus-4/.test(stripped)) return "claude-opus-4";
  if (/^claude-sonnet-4-6/.test(stripped)) return "claude-sonnet-4-6";
  if (/^claude-sonnet-4-5/.test(stripped)) return "claude-sonnet-4-5";
  if (/^claude-sonnet-4/.test(stripped)) return "claude-sonnet-4";
  if (/^claude-haiku-4-5/.test(stripped)) return "claude-haiku-4-5";
  if (/^claude-haiku-4/.test(stripped)) return "claude-haiku-4";
  return stripped;
}

function applyOpenRouterModels(data) {
  const items = Array.isArray(data?.data) ? data.data : [];
  for (const item of items) {
    const key = normalizeModel(item?.id);
    if (!book.models[key]) continue;
    const prompt = Number(item.pricing?.prompt);
    const completion = Number(item.pricing?.completion);
    if (!Number.isFinite(prompt) || !Number.isFinite(completion)) continue;
    const current = book.models[key];
    const cacheRead = Number(item.pricing?.input_cache_read ?? item.pricing?.prompt_cache_read);
    const cacheWrite = Number(item.pricing?.input_cache_write ?? item.pricing?.prompt_cache_write);
    book.models[key] = {
      ...current,
      inputPer1M: roundPrice(prompt * 1_000_000),
      outputPer1M: roundPrice(completion * 1_000_000),
      cachedInputPer1M: Number.isFinite(cacheRead) ? roundPrice(cacheRead * 1_000_000) : current.cachedInputPer1M,
      cacheCreationInputPer1M: Number.isFinite(cacheWrite) ? roundPrice(cacheWrite * 1_000_000) : current.cacheCreationInputPer1M,
      source: "https://openrouter.ai/api/v1/models public model pricing",
      updatedAt: now,
      note: undefined,
    };
  }
}

function roundPrice(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function applyAnthropicPricingHints(html) {
  const page = String(html || "");
  const known = [
    ["claude-opus-4", /Claude Opus 4[^.]*\$15\s*\/\s*MTok[^.]*\$75\s*\/\s*MTok/i],
    ["claude-sonnet-4-5", /Claude Sonnet 4\.5[^.]*\$3\s*\/\s*MTok[^.]*\$15\s*\/\s*MTok/i],
    ["claude-sonnet-4", /Claude Sonnet 4[^.]*\$3\s*\/\s*MTok[^.]*\$15\s*\/\s*MTok/i],
    ["claude-haiku-4-5", /Claude Haiku 4\.5[^.]*\$1\s*\/\s*MTok[^.]*\$5\s*\/\s*MTok/i],
  ];
  for (const [key, pattern] of known) {
    if (pattern.test(page) && book.models[key]) {
      book.models[key] = {
        ...book.models[key],
        source: "https://platform.claude.com/docs/en/about-claude/pricing public pricing page",
        updatedAt: now,
      };
    }
  }
}

const warnings = [];
try {
  applyOpenRouterModels(await fetchJson("https://openrouter.ai/api/v1/models"));
  book.source = "public pricing refresh: OpenRouter models API + Anthropic pricing page; static fallback for missing models";
} catch (err) {
  warnings.push(String(err?.message || err));
}

try {
  applyAnthropicPricingHints(await fetchText("https://platform.claude.com/docs/en/about-claude/pricing"));
} catch (err) {
  warnings.push(String(err?.message || err));
}

if (warnings.length) book.warnings = warnings;
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(book, null, 2) + "\n");
console.log(`wrote ${out}`);
if (warnings.length) console.warn(`warnings: ${warnings.join("; ")}`);
