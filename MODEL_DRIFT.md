# Model-map drift audit — 2026-04-29

Three sources of truth declare which Claude model ids the proxy supports. They MUST agree, but currently don't. This file surfaces the drift so the operator can decide what to do — **the harden/review-fixes branch deliberately does not silently reconcile them**.

| Source | File | Purpose |
|---|---|---|
| `MODEL_MAP` | `src/adapter/openai-to-cli.ts` | Maps incoming client model strings → `claude --model` values |
| `AVAILABLE_MODELS` | `src/index.ts` | What the openclaw plugin entry exposes via `buildModelDefinition()` |
| `handleModels` ids list | `src/server/routes.ts` | Response body for `GET /models` and `GET /v1/models` |

## Drift table

| Model id | MODEL_MAP | AVAILABLE_MODELS | handleModels |
|---|:-:|:-:|:-:|
| `claude-opus-4-7` | ✅ | ✅ | ✅ |
| `claude-opus-4-6` | ✅ | ✅ | ✅ |
| `claude-opus-4` (alias) | ✅ | ✅ | ✅ |
| `claude-sonnet-4-6` | ✅ | ✅ | ✅ |
| `claude-sonnet-4-5` | ✅ | ❌ | ❌ |
| `claude-sonnet-4` (alias) | ✅ | ❌ | ✅ |
| `claude-haiku-4-5-20251001` | ✅ | ✅ | ✅ |
| `claude-haiku-4-5` | ✅ | ❌ | ❌ |
| `claude-haiku-4` (alias) | ✅ | ❌ | ✅ |

## What the drift means in practice

- **`claude-sonnet-4-5`** and **`claude-haiku-4-5`** — accepted by the adapter (a request with these ids would be routed to `claude --model claude-sonnet-4-5`), but **invisible**: not advertised in the openclaw plugin's provider definitions and not returned by `GET /models`. A client that hardcodes these ids works; one that discovers via `/models` never sees them.
- **`claude-sonnet-4`** and **`claude-haiku-4`** legacy aliases — discoverable via `/models` and routed by the adapter, but **missing from the openclaw plugin definitions**, so an openclaw deployment that uses the bundled plugin (rather than declaring `claude-proxy` manually) won't see them.

## Decisions for the operator

Pick one for each row. None of these are bugs that block stream-json or the hardening fixes — they're scope creep accumulated over several PRs.

1. **Hide the unused 4-5 models** — remove `claude-sonnet-4-5` / `claude-haiku-4-5` from `MODEL_MAP` if you don't actually want them callable.
2. **Promote them** — add to `AVAILABLE_MODELS` and `handleModels` if you do.
3. **Drop the prior-generation aliases** (`claude-sonnet-4`, `claude-haiku-4`) — if you don't care about those any more, remove them from MODEL_MAP and handleModels.
4. **Promote the aliases** — add them to `AVAILABLE_MODELS` so the openclaw plugin advertises them.

The harden/review-fixes branch leaves all three lists exactly as they were on `main` so this audit can be discussed and resolved separately. Touch `MODEL_MAP` / `AVAILABLE_MODELS` / `handleModels` together when you do reconcile — that's the recipe in `infra/claude-proxy.md` ("Adding a new claude model").

## Automated drift test (v1.0.4+)

`src/__tests__/model-drift.test.ts` validates synchronization across all four sources of truth on every `npm test` run:

1. Every `handleModels` id is routable via `MODEL_MAP`.
2. Every `AVAILABLE_MODELS` id is in `handleModels`.
3. Every `AVAILABLE_MODELS` id is routable via `MODEL_MAP`.
4. `KNOWN_MODEL_LABELS` covers all `handleModels` ids (prevents `/metrics` cardinality leaks).
5. Provider-prefixed variants (`claude-proxy/`, `claude-code-cli/`) resolve identically to bare ids.

An informational log line lists MODEL_MAP entries that are routable but not advertised — this is non-fatal and expected for hidden/deprecated models. Promote or remove as needed.

**When adding a new model:** update MODEL_MAP, AVAILABLE_MODELS, handleModels ids, KNOWN_MODEL_LABELS, AND the mirror arrays in `model-drift.test.ts`. The test will fail until all are in sync.
