package com.szeeshan.mcpbridge.agent;

import java.time.Duration;
import java.util.List;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class AgentDefinitionTest {

    @Test
    void rejectsCommandWithoutAPromptPlaceholder() {
        assertThatThrownBy(() -> new AgentDefinition("d", List.of("gemini", "-p"), null, null))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("{prompt}");
    }

    @Test
    void rejectsEmptyCommand() {
        assertThatThrownBy(() -> new AgentDefinition("d", List.of(), null, null))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void defaultsTheTimeoutWhenNoneIsConfigured() {
        AgentDefinition definition = new AgentDefinition("d", List.of("x", "{prompt}"), null, null);

        assertThat(definition.timeout()).isEqualTo(Duration.ofMinutes(5));
    }

    @Test
    void keepsThePromptAsOneArgumentHoweverItIsWritten() {
        AgentDefinition definition = new AgentDefinition(
                "d", List.of("agent", "--run", "{prompt}"), null, null);

        List<String> argv = definition.commandFor("two words; and a semicolon");

        assertThat(argv).containsExactly("agent", "--run", "two words; and a semicolon");
    }

    @Test
    void substitutesIntoASurroundingArgument() {
        AgentDefinition definition = new AgentDefinition(
                "d", List.of("agent", "--prompt={prompt}"), null, null);

        assertThat(definition.commandFor("hi")).containsExactly("agent", "--prompt=hi");
    }
}
