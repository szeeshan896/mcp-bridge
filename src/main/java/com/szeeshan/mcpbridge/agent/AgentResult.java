package com.szeeshan.mcpbridge.agent;

/**
 * The outcome of delegating one prompt to one agent.
 *
 * @param output    what the agent wrote on stdout — the answer
 * @param succeeded whether it exited cleanly; false means read {@code diagnostics}
 * @param diagnostics stderr and the failure reason, empty when all went well
 */
public record AgentResult(
        String agent,
        boolean succeeded,
        String output,
        String diagnostics,
        int exitCode,
        boolean timedOut,
        long durationMillis,
        boolean outputTruncated) {
}
