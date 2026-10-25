package com.szeeshan.mcpbridge.bus;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/**
 * @param maxWaitSeconds upper bound for wait_for_reply, so a blocked tool call
 *                       cannot outlive the MCP request timeout
 * @param historyLimit   how many messages read_room and history return at most
 */
@ConfigurationProperties(prefix = "mcp-bridge")
public record BusProperties(
        @DefaultValue("90") int maxWaitSeconds,
        @DefaultValue("200") int historyLimit) {
}
