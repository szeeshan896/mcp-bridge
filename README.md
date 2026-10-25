# MCP Bridge

Delegate work to another AI agent without leaving the one you are already in.

Connect it once and forget it. Then, while coding in Claude Code:

> ask gemini through mcp-bridge to review the caching layer in this module

Claude calls `ask_agent`, the bridge runs Gemini's CLI, and the answer comes straight
back into your conversation. **One call, work done.** There is no inbox to check, no
conversation to keep, and nothing to nudge.

## No API keys

The bridge never calls a model API. It runs the agent CLIs already installed and signed
in on your machine, so each one uses **its own existing subscription**. Nothing here
needs an Anthropic, OpenAI, Google or xAI key, and nothing is billed per token.

```
                                     ┌──→ claude -p "..."     (your Claude subscription)
Claude Code ──MCP──→  MCP BRIDGE  ───┼──→ codex exec "..."    (your Codex subscription)
                       (this app)    └──→ gemini -p "..."     (your Gemini subscription)
```

It speaks **streamable HTTP**, not stdio, so it is one long-running process you register
once rather than a fresh copy spawned per client.

## Run it

```bash
./mvnw spring-boot:run
```

Listens on `http://localhost:8080/mcp`. Register it with Claude Code once:

```bash
claude mcp add --transport http mcp-bridge http://localhost:8080/mcp
```

That is the whole setup. Ask for `list_agents` first — it tells you which CLIs were
actually found on your `PATH`.

## The two tools

| Tool | What it does |
|---|---|
| `list_agents` | who can be delegated to, and whether their CLI is installed |
| `ask_agent` | hand one of them a task, wait, get the answer |

`ask_agent` takes `agent`, `prompt` and an optional `workingDirectory`. Pass the working
directory whenever the task is about code: the other agent starts fresh, knows nothing of
your conversation, and cannot see your files unless you point it at them.

## Configuring agents

Agents live in `application.yml`. The shipped entries are starting points — **verify the
flags against the CLI versions you have**, since each tool's headless invocation differs
and changes between releases.

```yaml
mcp-bridge:
  max-output-chars: 60000
  agents:
    gemini:
      description: "Google Gemini CLI - large context, good for whole-repo questions"
      command: ["gemini", "-p", "{prompt}"]
      timeout: 5m
```

Adding an agent is one block. Nothing in the code knows the difference between Gemini and
anything else you put here.

## Why the command lives in configuration

This application runs programs. If a tool call could choose the command, a prompt
injected into the calling model would be remote code execution.

So the command comes **only** from configuration. A tool call names an agent, and that
name is looked up in the configured allowlist; it can never supply a command of its own.
The prompt fills a `{prompt}` placeholder and reaches `ProcessBuilder` as a single argv
element, so **no shell is ever involved** and a prompt full of `;` and backticks arrives
as text. There is a test that asserts exactly this.

## What it will not do

- **Long tasks hit the timeout.** A delegated agent is a real model doing real work, and
  the call is synchronous. Split a large job into steps rather than sending one
  open-ended request. Per-agent `timeout` is configurable.
- **Each call is a fresh context.** The delegated agent remembers nothing between calls,
  so every prompt must stand on its own.
- **Your subscription limits still apply** — the bridge removes the key, not the quota.

## Stack

| | |
|---|---|
| Java | 21 |
| Spring Boot | 4.1.2 |
| Spring AI | 2.0.2 (`spring-ai-starter-mcp-server-webmvc`) |
| Build | Maven (wrapper included) |

```bash
./mvnw test      # 22 tests
./mvnw clean package
```

Always `clean` before packaging — a resource you deleted can otherwise linger in
`target/classes` and ship inside the jar.

## Layout

```
agent/   AgentDefinition (the allowlist entry), AgentRegistry (name -> definition,
         and is it installed), AgentRunner (runs it), AgentResult
mcp/     AgentTools - the two @Tool methods, and the provider that publishes them
```

## Roadmap

- [x] one-call delegation, allowlisted commands, install reporting, output caps
- [ ] async delegation (`start_task` / `get_result`) for jobs past the timeout
- [ ] follow-up calls that reuse an agent's session instead of starting fresh
- [ ] a local-model agent (Ollama) for work that should not leave the machine
