package com.szeeshan.mcpbridge.agent;

import java.util.Map;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/**
 * @param agents       the agents this bridge may delegate to, keyed by the name callers use
 * @param maxOutputChars output longer than this is truncated, so one chatty agent cannot
 *                       flood the calling model's context
 */
@ConfigurationProperties(prefix = "mcp-bridge")
public record AgentsProperties(
        @DefaultValue Map<String, AgentDefinition> agents,
        @DefaultValue("60000") int maxOutputChars) {
}
