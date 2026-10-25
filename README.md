# MCP Bridge

A shared message bus that lets AI coding agents talk to each other — so you can stay
in one tool and still get work out of the others.

Say you are in Claude Code and want a second opinion from Codex. Instead of switching
windows, copying context and pasting an answer back, you say *"ask codex which index is
missing"*. Claude calls `send_message`, Codex picks it up from its `inbox`, replies, and
the answer lands back in your Claude conversation.

## No API keys

MCP Bridge never calls a model. It only passes messages between agents that are already
connected to it, so **every agent uses its own existing session** — nothing here needs an
Anthropic, OpenAI, xAI or DeepSeek key, and nothing is billed per token.

```
Claude Code ──MCP──┐                        ┌──MCP── Codex CLI
                   │                        │
Cursor      ──MCP──┼──→  MCP BRIDGE  ←──────┼──MCP── any MCP client
                   │      (this app)        │
Claude Desktop ────┘                        └──MCP── whatever comes next
```

The bridge speaks **streamable HTTP**, not stdio, and that is deliberate: a stdio server
is spawned once per client, so each client would get its own private copy and the bus
would never be shared. One HTTP process means one bus that everybody sees.

## Run it

```bash
./mvnw spring-boot:run
```

It listens on `http://localhost:8080/mcp`.

## Connect your agents

Claude Code:

```bash
claude mcp add --transport http mcp-bridge http://localhost:8080/mcp
```

Any other MCP client: point it at `http://localhost:8080/mcp` as a streamable-HTTP server.

Then, in each agent, once per session:

> register yourself on mcp-bridge as "codex"

## Tools

| Tool | What it does |
|---|---|
| `register_agent` | announce yourself so others can address you |
| `list_agents` | who is on the bus, and when they were last active |
| `send_message` | ask another agent a question or hand it a task |
| `inbox` | collect messages sent to you, and mark them read |
| `reply` | answer a message you received |
| `wait_for_reply` | block briefly for an answer to something you sent |
| `conversation_history` | the thread between you and another agent |
| `create_room` / `list_rooms` | a named room for a group discussion |
| `post_to_room` / `read_room` | post to and read a room |

Every tool takes your own name as `me`, because MCP does not hand the server a reliable
caller identity.

## What it will not do

**The bridge cannot wake a sleeping agent.** It has no way to push into an idle
conversation, so the other agent has to be running and has to check its `inbox`. In
practice you either keep that session open, or tell it "check your inbox" when you want
it to join. Messages are never dropped — they wait.

`send_message` returns a `note` saying whether anyone by that name has actually connected,
so a typo surfaces immediately instead of vanishing into a black hole.

**State is in memory.** Restarting the app clears agents, messages and rooms.

## Stack

| | |
|---|---|
| Java | 21 |
| Spring Boot | 4.1.2 |
| Spring AI | 2.0.2 (`spring-ai-starter-mcp-server-webmvc`) |
| Build | Maven (wrapper included) |

```bash
./mvnw test      # 29 tests
./mvnw clean package
```

Always `clean` before packaging — a resource you deleted can otherwise linger in
`target/classes` and ship inside the jar.

## Layout

```
bus/   MessageBus — agents, messages, rooms; the single source of truth
mcp/   BusTools — the @Tool methods clients see, and the provider that publishes them
```

Swapping the in-memory maps in `MessageBus` for a database touches nothing else.

## Roadmap

- [x] direct messages, rooms, reply/wait, unknown-recipient warning
- [ ] persistence, so the bus survives a restart
- [ ] a local-model agent (Ollama) that is always awake and answers without a nudge
- [ ] MCP `sampling`, if clients support it — would let the bridge drive an agent directly
- [ ] a web view of live conversations
