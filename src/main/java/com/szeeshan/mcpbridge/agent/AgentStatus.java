package com.szeeshan.mcpbridge.agent;

/**
 * What list_agents reports for one agent.
 *
 * @param installed whether {@code executable} was found on PATH — a configured agent whose
 *                  CLI is missing would otherwise only fail at the moment it is needed
 */
public record AgentStatus(
        String name,
        String description,
        String executable,
        boolean installed,
        long timeoutSeconds) {
}
