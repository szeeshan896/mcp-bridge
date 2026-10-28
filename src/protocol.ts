import { z } from 'zod';

/**
 * The wire protocol between a local agent (`mcpbridge connect`, running where the AI CLIs
 * are signed in) and a relay (the hosted endpoint clients talk to). JSON messages over a
 * WebSocket the agent opens outbound, so nothing on the user's machine listens.
 *
 * The relay only ever forwards: it never sees a credential, only prompts and answers.
 */
export const PROTOCOL_VERSION = 1 as const;

export const AgentStatusSchema = z.object({
  name: z.string(),
  description: z.string(),
  requires: z.string(),
  available: z.boolean(),
  readsFiles: z.boolean(),
  detail: z.string(),
  // optional, so an older agent's hello still parses
  status: z.string().optional(),
  writesFiles: z.boolean().optional(),
  runsCommands: z.boolean().optional(),
  timeoutSeconds: z.number().optional(),
  lastError: z.string().optional(),
  lastErrorAt: z.string().optional(),
  retryAt: z.string().optional(),
  lastSuccessAt: z.string().optional(),
  calls: z.number().optional(),
});
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const TOOL_NAME = z.enum(['list_agents', 'ask_agent', 'start_task', 'get_task']);

// ---- agent -> relay ---------------------------------------------------------

/** First message after the socket opens. */
export const HelloMessage = z.object({
  type: z.literal('hello'),
  protocol: z.literal(PROTOCOL_VERSION),
  agentVersion: z.string(),
  device: z.string().min(1).max(80),
  agents: z.array(AgentStatusSchema),
});

/** A refreshed agent list, so a dashboard can show what is installed without a call. */
export const AgentsMessage = z.object({
  type: z.literal('agents'),
  agents: z.array(AgentStatusSchema),
});

/** The answer to a call. `ok: false` means the tool itself threw; `payload` is the message. */
export const ResultMessage = z.object({
  type: z.literal('result'),
  id: z.string(),
  ok: z.boolean(),
  payload: z.unknown(),
});

export const AgentToRelay = z.discriminatedUnion('type', [HelloMessage, AgentsMessage, ResultMessage]);
export type AgentToRelay = z.infer<typeof AgentToRelay>;

// ---- relay -> agent ---------------------------------------------------------

export const WelcomeMessage = z.object({
  type: z.literal('welcome'),
  /** what the relay will call this device, which may differ if the name was taken */
  device: z.string(),
});

export const CallMessage = z.object({
  type: z.literal('call'),
  id: z.string(),
  tool: TOOL_NAME,
  args: z.record(z.string(), z.unknown()),
});

/** Sent before the relay closes the socket on purpose, so the agent knows not to retry. */
export const GoodbyeMessage = z.object({
  type: z.literal('goodbye'),
  reason: z.string(),
  retry: z.boolean(),
});

export const RelayToAgent = z.discriminatedUnion('type', [WelcomeMessage, CallMessage, GoodbyeMessage]);
export type RelayToAgent = z.infer<typeof RelayToAgent>;

export function parseAgentMessage(raw: string): AgentToRelay | null {
  const result = AgentToRelay.safeParse(tryJson(raw));
  return result.success ? result.data : null;
}

export function parseRelayMessage(raw: string): RelayToAgent | null {
  const result = RelayToAgent.safeParse(tryJson(raw));
  return result.success ? result.data : null;
}

function tryJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
