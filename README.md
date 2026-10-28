# MCP Bridge

[![CI](https://github.com/szeeshan896/mcpbridge/actions/workflows/ci.yml/badge.svg)](https://github.com/szeeshan896/mcpbridge/actions/workflows/ci.yml)

Delegate work to another AI agent from inside the one you are already in.

```bash
claude mcp add mcpbridge -- npx -y mcpbridge
```

That is the whole setup, once this is on npm. Until then, install from a clone — see
**Installing** below. Now, while you are coding in Claude Code:

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
| `list_agents` | who can be delegated to, and whether each can be started |
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

## The control panel: no terminal needed

```bash
mcpbridge ui          # or, on Windows, double-click start-ui.cmd in the repository
```

opens a page on this computer — `http://127.0.0.1:8809` — that does what the rest of this
README does with commands:

- **Add an agent from a preset** — NVIDIA (free tier at build.nvidia.com), DeepSeek, Grok
  through the Grok Build CLI or the xAI API, OpenRouter, Groq, Mistral, Ollama, or any
  OpenAI-compatible endpoint or command-line agent. Paste the key, press **List models** to
  see what it can reach, pick one, save.
- **Test** any agent with a one-word prompt and see the answer or the exact error.
- **Connect to the relay**: paste the agent token once; the page keeps this machine
  online while it is open, comes back online by itself the next time you open it, and
  pushes a newly added agent to the relay straight away.

Keys and the agent token are saved in `secrets.json` next to `config.json`, never in
`config.json` itself and never sent to the relay. Every `mcpbridge` command reads them,
so a key saved here also works for `--ask`, and a bare `mcpbridge connect` uses the saved
relay settings. A variable exported in the shell still wins over a saved key.

The page answers only on 127.0.0.1 and only to the browser that opened the link printed
in the terminal: that link carries a key made for this launch, swapped for an HttpOnly
cookie on first load, and requests with another Host or Origin are refused, so a web page
elsewhere cannot drive it through your browser.

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

## Installing

Needs Node 22 or newer (`node --version`).

```bash
git clone https://github.com/szeeshan896/mcpbridge.git
cd mcpbridge
npm install                 # builds dist/ via the prepare script
node dist/index.js --agents # see which agents are usable here
```

`--agents` says an agent can be *started*, not that its account works — a signed-out CLI
or a withdrawn subscription still lists as available and fails when asked. Checking
properly would mean spending a real call on every listing. So check an agent really
answers before wiring anything up — the built-in commands are each
tool's documented non-interactive mode, but those flags do change between releases:

```bash
node dist/index.js --ask claude "reply with exactly: OK"
```

Then point your client at it, with an absolute path — the client runs it from whatever
directory it likes, so a relative one will not resolve:

```bash
claude mcp add -s user mcpbridge -- node "$(pwd)/dist/index.js"
claude mcp list             # should say Connected
```

`-s user` matters: without it the server is registered for that one project, and a session
started anywhere else connects to nothing — the model then sees no tools, and will reach
for the agent's CLI directly if it happens to be on PATH, which looks like it worked while
going nowhere near this bridge.

Once published, that collapses to `npm i -g mcpbridge` and
`claude mcp add mcpbridge -- mcpbridge`, with no build step at all: the published package
carries a prebuilt `dist/`.

`npm i -g github:szeeshan896/mcpbridge` does **not** work, and the reason is worth knowing:
installing from a git URL means building from source, a global install does not install
devDependencies, and without `@types/node` and `typescript` the build fails with
`TS2688: Cannot find type definition file for 'node'`. Installing from git into a project
(`npm i github:szeeshan896/mcpbridge`) does work, because that path does install them.
Publishing removes the question entirely.

## From anywhere: the hosted relay

Everything above runs where the client runs. That rules out claude.ai in a browser or on a
phone, because Anthropic's servers call connectors from the cloud and cannot reach a
laptop's localhost. The answer is not to host the bridge — a server has no `claude.exe`
signed in as you, and holding users' sessions would be both a liability and against every
provider's terms — but to host a **relay** that only forwards, while the CLIs keep running
where they are signed in.

```
 claude.ai · phone · Desktop · Cursor ──HTTPS──►  relay  ──WebSocket──►  your laptop
                                                 (public URL,            mcpbridge connect
                                                  no AI credentials)     claude · codex · agy
```

On your machine:

```bash
npx -y mcpbridge connect --relay https://bridge.yourdomain.com --token mba_…
```

It opens an outbound connection — nothing listens, no firewall rule — and answers the
calls the relay forwards with exactly the same code the local server runs. Close the lid
and the dashboard shows *offline*; that is the point, not a limitation: it is why the
server needs no keys.

The relay itself lives in [`relay/`](relay/README.md): accounts (email or phone, password or
Google), 2-step verification with an authenticator app, two tokens per account stored as
hashes, a dashboard that generates the exact lines to paste into each client, and a
`Dockerfile` that deploys to Fly, Railway or any VPS. claude.ai — web, desktop app and
phone — connects to it as a custom connector through OAuth: you enter the relay's URL,
sign in, click *Allow*, and nothing is pasted anywhere. Claude Code signs in the same way;
clients that take a fixed header (Claude Desktop via `mcp-remote`, Cursor) use a client
token from the dashboard instead.

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

## When an agent will not authenticate

`--ask` separates "the command is wrong" from "the account is not usable", which look the
same from inside a client. Three real cases:

**A subscription CLI whose session has lapsed** reports it plainly, e.g. `Failed to
authenticate: OAuth session expired and could not be refreshed`. Run that tool
interactively once to sign in again; nothing here needs changing.

**A provider that has withdrawn a tier.** Gemini CLI now answers `IneligibleTierError:
This client is no longer supported for Gemini Code Assist for individuals`, pointing at
Antigravity. No flag works around that — but Antigravity ships its own CLI, `agy`, with a
print mode, and it reaches the same models through that login. The built-in `antigravity`
agent uses it, so this needs no key at all.

Failing both, Gemini models are also reachable through Google's OpenAI-compatible endpoint
with an AI Studio key, which this bridge speaks already:

```json
{
  "agents": {
    "gemini-api": {
      "type": "openai",
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai",
      "model": "<a model id>",
      "apiKeyEnv": "GEMINI_API_KEY"
    }
  }
}
```

**A CLI that refuses to act without a person present** — see **Running agents
unattended** below.

## Running agents unattended

Every one of these tools has a guard that assumes a person is sitting there to answer it.
Delegation has nobody, so each guard turns into a failure:

| Agent | What it refuses | What lifts it |
|---|---|---|
| `codex` | a directory that is not a git repository | `--skip-git-repo-check` |
| `antigravity` | acting without approval for each tool call | `--dangerously-skip-permissions` |
| `gemini` | a workspace it has not been told to trust | `GEMINI_CLI_TRUST_WORKSPACE=true` |

None of them are set for you, and that is the point: each gives up a check on whatever
directory a caller names — code written without a way to undo it, files edited and
commands run with nobody asked. Worth having, worth choosing deliberately.

```json
{
  "agents": {
    "codex": { "command": ["codex", "exec", "--skip-git-repo-check", "{prompt}"] },
    "antigravity": { "command": ["agy", "-p", "--dangerously-skip-permissions", "{prompt}"] },
    "gemini": { "command": ["gemini", "-p", "{prompt}"],
                "env": { "GEMINI_CLI_TRUST_WORKSPACE": "true" } }
  }
}
```

A delegation that only asks a question needs none of this. Point an agent at a git
repository and `codex` is content; ask it to read rather than write and `agy` has nothing
to request approval for.

## On Windows

Every npm-installed CLI appears as a `.cmd` shim, which Node cannot spawn without a shell
— and a prompt must never go through a shell. Rather than refusing every agent on the
platform, the shim is **read** and the program it would have run is spawned directly:

```
claude  ->  C:\Users\you\AppData\Roaming\npm\claude.cmd        (the shim, never run)
        ->  ...\node_modules\@anthropic-ai\claude-code\bin\claude.exe   (run instead)
```

Reading a shim is safe where running it is not: nothing from the prompt reaches the file.
Both shapes npm writes are handled — a native binary, and a script invoked through node,
which is run with the same node that is running the bridge rather than whichever one is
first on `PATH`. A shim whose target cannot be read or found falls back to being refused
with the path to set by hand, so an unrecognised one never produces a wrong command.

## What it will not do

- **Long tasks hit a timeout.** `ask_agent` is synchronous and the client has its own
  request deadline. Split big jobs, or use `start_task` and poll `get_task`.
- **Each call starts fresh.** The delegated agent remembers nothing between calls.
- **It is local only.** It drives CLIs signed in on this machine and reads this machine's
  files, so there is nothing to host and nothing to deploy.

## Development

```bash
npm install
npm test          # typecheck + 92 tests
npm run build
npm start         # stdio, from source
```

| | |
|---|---|
| Runtime | Node 22+ |
| SDK | `@modelcontextprotocol/sdk` 1.32.2 |
| Package size | ~16 KB |

```
src/agents/   cli.ts (spawns a command), shim.ts (what a Windows .cmd really runs),
              ollama.ts (local model),
              openai.ts (any OpenAI-compatible API), broken.ts (a config that did not
              load, so one typo costs that agent and not the bridge), registry.ts
test/fixtures/agent.mjs  a Node stand-in for an agent CLI, so the suite runs on Windows
src/config.ts built-in defaults and the config file
src/tasks.ts  background tasks behind start_task / get_task
src/limit.ts  the concurrency cap both paths queue through
src/server.ts the four tools
src/index.ts  entry point and transport choice
src/connect.ts the outbound connection to a relay; src/protocol.ts its wire format
src/tools.ts  the four tools as plain functions, shared by the server and the relay path
relay/        the hosted relay: accounts, tokens, 2FA, dashboard, MCP forwarding
```

A Java and Spring Boot implementation came first and is preserved in this repository's
history at commit `498634f`; it was ported here so the tool installs with one `npx`
command and no JRE.

## Roadmap

- [x] one-call delegation, Ollama agent, async tasks, allowlisted commands
- [ ] follow-up calls that reuse an agent's session instead of starting fresh
- [ ] streaming progress while a long delegation runs
