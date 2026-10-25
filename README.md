# MCP Bridge

Delegate work to another AI agent from inside the one you are already in.

```bash
claude mcp add mcpbridge -- npx -y mcpbridge
```

That is the whole setup. Now, while you are coding in Claude Code:

> ask gemini through mcpbridge to review the caching layer in this module

Claude calls `ask_agent`, the bridge runs Gemini, and the answer comes back into your
conversation. **One call, work done.** No mailbox to check, nothing to nudge.

## No API keys

The bridge never calls a model API. It drives the agent CLIs already installed and signed
in on your machine, so each one uses **its own existing subscription** — and it can talk to
a model running locally in Ollama, which needs no account at all.

```
                                  ┌──→ claude -p "…"      your Claude subscription
Claude Code ──MCP──→  mcpbridge ──┼──→ codex exec "…"     your Codex subscription
Cursor      ──MCP──→              ├──→ gemini -p "…"      your Gemini subscription
                                  └──→ Ollama (localhost) no account, no network
```

It removes the key, not the quota: your subscription limits still apply.

## Tools

| Tool | What it does |
|---|---|
| `list_agents` | who can be delegated to, and whether each is usable right now |
| `ask_agent` | hand one a task, wait, get the answer |
| `start_task` | same, but returns an id immediately for work that outlasts the request |
| `get_task` | check on a started task |

`ask_agent` is the normal path. The agent you delegate to starts fresh: it cannot see your
conversation or your files, so write a self-contained prompt and pass `workingDirectory`
whenever the task is about code.

## Check what you have

```bash
npx mcpbridge --agents
```

```
✓ claude     claude found on PATH
✗ codex      codex is not on PATH — install it or fix the command
✗ gemini     gemini is not on PATH — install it or fix the command
✓ ollama     Ollama at http://127.0.0.1:11434, using qwen3:latest
```

Nothing to configure to get here — the four agents above are built in, and anything not
installed is simply reported, never silently broken.

## Adding or fixing an agent

Write `~/.config/mcpbridge/config.json` (or point `MCPBRIDGE_CONFIG` elsewhere). Entries
replace the built-in one of the same name outright.

```json
{
  "agents": {
    "gemini": {
      "command": ["gemini", "--prompt", "{prompt}"],
      "timeoutMs": 300000
    },
    "local": {
      "type": "ollama",
      "model": "qwen3:latest",
      "description": "Local model for anything that should not leave this machine"
    }
  }
}
```

Each tool's non-interactive flags change between releases, so if a built-in default does
not match your version, override it here — `--agents` will confirm.

## Why the command lives in configuration

This program runs other programs. If a tool call could choose the command, a prompt
injected into the calling model would be remote code execution.

So commands come **only** from configuration. A call names an agent, that name is looked up
in the configured set, and the prompt fills a `{prompt}` placeholder that reaches `spawn`
as a single argument with **no shell involved**. A prompt full of `;` and backticks arrives
as text; there is a test that asserts exactly that, and that nothing in it executes.

## stdio or HTTP

stdio is the default and what you want: the client starts the bridge itself, so there is no
port, no daemon and no listening socket at all.

For one shared instance instead:

```bash
npx mcpbridge --http 8808        # http://127.0.0.1:8808/mcp
```

That mode binds loopback only, and rejects requests whose `Host` header is not
`127.0.0.1`/`localhost` — otherwise a web page you visit could make your browser POST to
the port and run `ask_agent` on your machine. Loopback binding alone does not stop that.

## What it will not do

- **Long tasks hit a timeout.** `ask_agent` is synchronous and the client has its own
  request deadline. Split big jobs, or use `start_task` and poll `get_task`.
- **Each call starts fresh.** The delegated agent remembers nothing between calls.
- **It is local only.** It drives CLIs signed in on this machine and reads this machine's
  files, so there is nothing to host and nothing to deploy.

## Development

```bash
npm install
npm test          # typecheck + 30 tests
npm run build
npm start         # stdio, from source
```

| | |
|---|---|
| Runtime | Node 20+ |
| SDK | `@modelcontextprotocol/sdk` 1.32.2 |
| Package size | ~16 KB |

```
src/agents/   cli.ts (spawns a command), ollama.ts (local model), registry.ts, types.ts
src/config.ts built-in defaults and the config file
src/tasks.ts  background tasks behind start_task / get_task
src/server.ts the four tools
src/index.ts  entry point and transport choice
```

A Java and Spring Boot implementation came first and is preserved in this repository's
history at commit `498634f`; it was ported here so the tool installs with one `npx`
command and no JRE.

## Roadmap

- [x] one-call delegation, Ollama agent, async tasks, allowlisted commands
- [ ] follow-up calls that reuse an agent's session instead of starting fresh
- [ ] streaming progress while a long delegation runs
