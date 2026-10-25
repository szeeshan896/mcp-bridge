package com.szeeshan.mcpbridge.agent;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import org.springframework.stereotype.Service;

/** Resolves agent names against configuration and reports which ones are usable. */
@Service
public class AgentRegistry {

    private final AgentsProperties properties;

    public AgentRegistry(AgentsProperties properties) {
        this.properties = properties;
    }

    public Optional<AgentDefinition> find(String name) {
        return name == null ? Optional.empty()
                : Optional.ofNullable(properties.agents().get(name.trim().toLowerCase()));
    }

    public List<String> names() {
        return properties.agents().keySet().stream().sorted().toList();
    }

    public List<AgentStatus> statuses() {
        return properties.agents().entrySet().stream()
                .map(entry -> new AgentStatus(
                        entry.getKey(),
                        entry.getValue().description(),
                        entry.getValue().executable(),
                        isOnPath(entry.getValue().executable()),
                        entry.getValue().timeout().toSeconds()))
                .sorted(Comparator.comparing(AgentStatus::name))
                .toList();
    }

    /**
     * Whether the executable can actually be found, so list_agents can say that an agent is
     * configured but not installed instead of leaving the caller to discover it on failure.
     */
    private static boolean isOnPath(String executable) {
        if (executable.contains(File.separator)) {
            return Files.isExecutable(Path.of(executable));
        }
        String path = System.getenv("PATH");
        if (path == null) {
            return false;
        }
        for (String dir : path.split(File.pathSeparator)) {
            if (!dir.isBlank() && Files.isExecutable(Path.of(dir, executable))) {
                return true;
            }
        }
        return false;
    }
}
