package com.szeeshan.mcpbridge.mcp;

import org.springframework.ai.tool.ToolCallbackProvider;
import org.springframework.ai.tool.method.MethodToolCallbackProvider;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** Publishes {@link BusTools} to the MCP server so connected clients can call them. */
@Configuration
public class McpToolsConfig {

    @Bean
    ToolCallbackProvider busToolCallbacks(BusTools busTools) {
        return MethodToolCallbackProvider.builder().toolObjects(busTools).build();
    }
}
