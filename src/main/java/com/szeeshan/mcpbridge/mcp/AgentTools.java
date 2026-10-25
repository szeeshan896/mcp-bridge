package com.szeeshan.mcpbridge.mcp;

import java.util.List;

import com.szeeshan.mcpbridge.agent.AgentDefinition;
import com.szeeshan.mcpbridge.agent.AgentRegistry;
import com.szeeshan.mcpbridge.agent.AgentResult;
import com.szeeshan.mcpbridge.agent.AgentRunner;
import com.szeeshan.mcpbridge.agent.AgentStatus;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;
import org.springframework.stereotype.Component;

/**
 * The two tools this bridge exposes. Delegating is one call that returns the answer —
 * there is no mailbox to poll and no conversation to keep, because the agent on the other
 * side is a CLI this bridge starts and waits for.
 */
@Component
public class AgentTools {

    private static final Logger log = LoggerFactory.getLogger(AgentTools.class);

    private final AgentRegistry registry;
    private final AgentRunner runner;

    public AgentTools(AgentRegistry registry, AgentRunner runner) {
        this.registry = registry;
        this.runner = runner;
    }

    @Tool(name = "list_agents", description = """
            List the AI agents this bridge can delegate work to. Check this before asking,
            because an agent can be configured here without its CLI being installed —
            "installed": false means a request to it will fail.""")
    public List<AgentStatus> listAgents() {
        return registry.statuses();
    }

    @Tool(name = "ask_agent", description = """
            Hand a task to another AI agent and wait for its answer. One call does the whole
            thing: the bridge runs that agent and returns what it produced.

            The agent starts with no knowledge of this conversation and cannot see your
            files unless you point it at them, so write a self-contained prompt and pass
            workingDirectory when the task is about code in a project.

            Long tasks can hit the agent's timeout — split a large job into steps rather
            than sending one open-ended request. If "succeeded" is false, read
            "diagnostics": it says what went wrong instead of silently returning nothing.""")
    public AgentResult askAgent(
            @ToolParam(description = "Which agent to use, exactly as list_agents names it, e.g. \"gemini\".")
            String agent,
            @ToolParam(description = "The full self-contained task or question for that agent.")
            String prompt,
            @ToolParam(description = "Absolute path to run the agent in, so it can read the project's files. Omit to use the bridge's own directory.", required = false)
            String workingDirectory) {

        if (prompt == null || prompt.isBlank()) {
            return rejected(agent, "prompt must not be blank");
        }
        AgentDefinition definition = registry.find(agent).orElse(null);
        if (definition == null) {
            return rejected(agent, "no agent named '%s' is configured on this bridge. Available: %s"
                    .formatted(agent, String.join(", ", registry.names())));
        }

        log.info("delegating {} chars to agent {}", prompt.length(), agent);
        AgentResult result = runner.run(agent.trim().toLowerCase(), definition, prompt, workingDirectory);
        log.info("agent {} finished in {}ms, succeeded={}", agent, result.durationMillis(), result.succeeded());
        return result;
    }

    private static AgentResult rejected(String agent, String reason) {
        return new AgentResult(agent, false, "", reason, 0, false, 0, false);
    }
}
