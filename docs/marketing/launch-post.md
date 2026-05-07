# Launch post drafts

## Short social post

I just released `openclaw-claude-proxy`: a local OpenAI-compatible HTTP proxy for Claude Code.

It lets OpenAI-compatible clients talk to a local authenticated `claude` CLI session via familiar endpoints like `/v1/chat/completions`, `/v1/responses`, `/v1/models`, streaming, health, metrics, usage/cost annotations, and optional traces.

Install:

```bash
npm install -g https://github.com/mehdic/openclaw-claude-proxy/releases/download/v1.0.8/openclaw-claude-proxy-1.0.8.tgz
claude-proxy
```

Repo: https://github.com/mehdic/openclaw-claude-proxy

## Longer Reddit/HN-style post

I built `openclaw-claude-proxy`, a local OpenAI-compatible server that wraps the official Claude Code CLI.

Why: a lot of local tools and agent frameworks already know how to talk to OpenAI-compatible APIs, but Claude Code is usually driven through its own CLI. This proxy bridges that gap for local developer workflows.

What it supports:

- `/v1/chat/completions` streaming and non-streaming
- practical `/v1/responses` compatibility
- `/v1/models`, `/health`, `/metrics`, and optional trace endpoints
- persistent `stream-json` runtime by default, with `print` fallback
- caller-dispatched OpenAI tool calls, so the outer agent framework can keep approvals/audit/allowlists
- optional MCP injection for trusted local setups
- GitHub release tarballs and npm install path

Install:

```bash
npm install -g https://github.com/mehdic/openclaw-claude-proxy/releases/download/v1.0.8/openclaw-claude-proxy-1.0.8.tgz
claude-proxy
```

Source: https://github.com/mehdic/openclaw-claude-proxy

It is intentionally local-first: bind to loopback, keep secrets out of the repo, and let the caller own tool execution unless you deliberately enable direct MCP injection.
