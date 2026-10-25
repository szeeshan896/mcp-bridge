package com.szeeshan.mcpbridge.mcp;

import java.time.Duration;
import java.util.List;
import java.util.Map;

import com.szeeshan.mcpbridge.agent.AgentDefinition;
import com.szeeshan.mcpbridge.agent.AgentRegistry;
import com.szeeshan.mcpbridge.agent.AgentResult;
import com.szeeshan.mcpbridge.agent.AgentRunner;
import com.szeeshan.mcpbridge.agent.AgentStatus;
import com.szeeshan.mcpbridge.agent.AgentsProperties;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class AgentToolsTest {

    private final AgentsProperties properties = new AgentsProperties(Map.of(
            "echoer", new AgentDefinition("echoes back", List.of("echo", "{prompt}"), Duration.ofSeconds(10), null),
            "ghost", new AgentDefinition("not installed", List.of("nope-xyz", "{prompt}"), Duration.ofSeconds(5), null)),
            60_000);

    private final AgentTools tools = new AgentTools(
            new AgentRegistry(properties), new AgentRunner(properties));

    @Test
    void delegatesAndReturnsTheAnswerInOneCall() {
        AgentResult result = tools.askAgent("echoer", "what is 2+2", null);

        assertThat(result.succeeded()).isTrue();
        assertThat(result.output()).isEqualTo("what is 2+2");
    }

    @Test
    void namesTheAvailableAgentsWhenAskedForOneThatIsNotConfigured() {
        AgentResult result = tools.askAgent("grok", "hello", null);

        assertThat(result.succeeded()).isFalse();
        assertThat(result.diagnostics()).contains("no agent named 'grok'").contains("echoer");
    }

    @Test
    void refusesABlankPrompt() {
        assertThat(tools.askAgent("echoer", "   ", null).succeeded()).isFalse();
    }

    @Test
    void resolvesAgentNamesCaseInsensitively() {
        assertThat(tools.askAgent("ECHOER", "hi", null).succeeded()).isTrue();
    }

    @Test
    void listAgentsSaysWhichOnesAreActuallyInstalled() {
        List<AgentStatus> statuses = tools.listAgents();

        assertThat(statuses).extracting(AgentStatus::name).containsExactly("echoer", "ghost");
        assertThat(statuses).filteredOn(AgentStatus::installed)
                .extracting(AgentStatus::name).containsExactly("echoer");
    }
}
