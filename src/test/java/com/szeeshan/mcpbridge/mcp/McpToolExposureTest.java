package com.szeeshan.mcpbridge.mcp;

import org.junit.jupiter.api.Test;
import org.springframework.ai.tool.ToolCallbackProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import static org.assertj.core.api.Assertions.assertThat;

/** Guards the MCP wiring: if the tools stop being published, clients see an empty server. */
@SpringBootTest
class McpToolExposureTest {

    @Autowired
    ToolCallbackProvider toolCallbackProvider;

    @Test
    void publishesExactlyTheTwoDelegationTools() {
        assertThat(toolCallbackProvider.getToolCallbacks())
                .extracting(callback -> callback.getToolDefinition().name())
                .containsExactlyInAnyOrder("list_agents", "ask_agent");
    }
}
