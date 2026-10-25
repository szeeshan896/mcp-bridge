package com.szeeshan.mcpbridge.agent;

import java.time.Duration;
import java.util.List;

/**
 * One AI agent the bridge can delegate work to, as declared in configuration.
 *
 * <p>The command is the security boundary of this application. It comes only from
 * configuration, never from a tool call, so a prompt cannot choose what gets executed —
 * it can only fill the {@code {prompt}} placeholder, and it does so as a single argv
 * element that never reaches a shell.
 *
 * @param command       argv to run, with one element containing {@code {prompt}}
 * @param workingDirectory default directory to run in, or null for the bridge's own
 */
public record AgentDefinition(
        String description,
        List<String> command,
        Duration timeout,
        String workingDirectory) {

    public static final String PROMPT_PLACEHOLDER = "{prompt}";

    public AgentDefinition {
        if (command == null || command.isEmpty()) {
            throw new IllegalArgumentException("agent command must not be empty");
        }
        if (command.stream().noneMatch(part -> part.contains(PROMPT_PLACEHOLDER))) {
            throw new IllegalArgumentException(
                    "agent command must contain one " + PROMPT_PLACEHOLDER + " element: " + command);
        }
        timeout = timeout == null ? Duration.ofMinutes(5) : timeout;
    }

    /** The executable, used to report whether this agent is actually installed. */
    public String executable() {
        return command.getFirst();
    }

    /** argv with the prompt substituted, each element kept separate. */
    public List<String> commandFor(String prompt) {
        return command.stream()
                .map(part -> part.replace(PROMPT_PLACEHOLDER, prompt))
                .toList();
    }
}
