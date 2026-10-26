# MCP Bridge

[![CI](https://github.com/szeeshan896/mcpbridge/actions/workflows/ci.yml/badge.svg)](https://github.com/szeeshan896/mcpbridge/actions/workflows/ci.yml)

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

Every answer carries `notes` as well as `diagnostics`: `diagnostics` is why a call failed,
`notes` is what you should know about one that succeeded — a directory that was ignored,
tokens spent, an answer cut short at the model's output limit.

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
  "maxConcurrent": 2,
  "agents": {
    "gemini": {
      "command": ["gemini", "--prompt", "{prompt}"],
      "timeoutMs": 300000
    },
    "big-context": {
      "command": ["some-cli", "--read-stdin"],
      "promptVia": "stdin",
      "env": { "SOME_CLI_QUIET": "1" }
    },
    "local": {
      "type": "ollama",
      "model": "qwen3:latest",
      "description": "Local model for anything that should not leave this machine"
    }
  }
}
```

**`promptVia`** decides how the prompt reaches the agent. The default, `"argv"`, is subject
to the operating system's argument-size limit, which varies a lot — roughly 128KB per
argument on Linux, about 1MB on macOS, and as little as 32KB on Windows. A prompt carrying
file contents passes the lower ones easily, and past the limit the spawn fails outright.
`"stdin"` has no such limit and is right for any CLI that reads its prompt from a pipe. The
built-in `claude` agent uses it for that reason. If you do hit the limit, the error names
this setting instead of leaving you with an errno.

**`maxConcurrent`** caps how many delegations run at once (default 2). Each one is a whole
model doing real work, so an unbounded number saturates the machine and spends the quota of
whatever account is behind it.

Terminal escape codes are stripped from every answer, and agents run with `NO_COLOR=1`, so
colour and spinners do not end up in the calling model's context as if they were content.

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

## Reaching a model that has no CLI

Some providers publish no command-line tool at all. xAI is one: there is no official Grok
CLI, so the xAI API is the only route, and that means a key. The same shape reaches most
providers that are not Anthropic or Google, because they all speak
`POST /v1/chat/completions` — DeepSeek, Mistral, Groq, Together, OpenRouter, LM Studio,
llama.cpp and vLLM included. One adapter, differing only in base URL, model and key.

```json
{
  "agents": {
    "grok": {
      "type": "openai",
      "baseUrl": "https://api.x.ai/v1",
      "model": "<a model id from xAI's docs>",
      "apiKeyEnv": "XAI_API_KEY"
    },
    "openrouter": {
      "type": "openai",
      "baseUrl": "https://openrouter.ai/api/v1",
      "model": "<a model id>",
      "apiKeyEnv": "OPENROUTER_API_KEY"
    }
  }
}
```

**`apiKeyEnv` names an environment variable; it is not the key.** Config files get copied
into repositories and pasted into issues, and a key in one is a key leaked. An inline
`apiKey` works but is the worse habit. The key never appears in a result, a note or an
error — there is a test asserting exactly that.

Leave `model` out until you know it: with the key exported, `mcpbridge --agents` lists the
ids that endpoint offers, where the provider exposes a listing.

**Keys stay entirely optional.** An agent without one reports `available: false` exactly
like a CLI that is not installed, so a setup of only CLIs and Ollama needs no key anywhere.
Add one only where a provider leaves no other door.

Because these agents are HTTP, they report `readsFiles: false` and say what they spent:
`notes` carries the token usage, since unlike a subscription CLI these calls are billed per
call.

```bash
mcpbridge --example-config > ~/.config/mcpbridge/config.json
```

## On Windows

An agent whose command resolves to a `.cmd` or `.bat` shim — which is how npm-installed
CLIs appear on Windows — is refused rather than run, because a batch file can only be
invoked through a shell and putting a prompt through a shell is the one thing this program
must not do. `list_agents` says so and names the fix: point the agent at the real
executable.

```json
{ "agents": { "claude": { "command": ["node", "C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js", "-p", "{prompt}"] } } }
```

## What it will not do

- **Long tasks hit a timeout.** `ask_agent` is synchronous and the client has its own
  request deadline. Split big jobs, or use `start_task` and poll `get_task`.
- **Each call starts fresh.** The delegated agent remembers nothing between calls.
- **It is local only.** It drives CLIs signed in on this machine and reads this machine's
  files, so there is nothing to host and nothing to deploy.

## Development

```bash
npm install
npm test          # typecheck + 60 tests
npm run build
npm start         # stdio, from source
```

| | |
|---|---|
| Runtime | Node 22+ |
| SDK | `@modelcontextprotocol/sdk` 1.32.2 |
| Package size | ~16 KB |

```
src/agents/   cli.ts (spawns a command), ollama.ts (local model),
              openai.ts (any OpenAI-compatible API), broken.ts (a config that did not
              load, so one typo costs that agent and not the bridge), registry.ts
test/fixtures/agent.mjs  a Node stand-in for an agent CLI, so the suite runs on Windows
src/config.ts built-in defaults and the config file
src/tasks.ts  background tasks behind start_task / get_task
src/limit.ts  the concurrency cap both paths queue through
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
