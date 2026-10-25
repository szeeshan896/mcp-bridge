package com.szeeshan.mcpbridge.agent;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.assertj.core.api.Assertions.assertThat;

class AgentRunnerTest {

    private final AgentRunner runner = new AgentRunner(new AgentsProperties(Map.of(), 60_000));

    private static AgentDefinition agent(List<String> command, Duration timeout) {
        return new AgentDefinition("test agent", command, timeout, null);
    }

    @Test
    void returnsWhatTheAgentWroteOnStdout() {
        AgentResult result = runner.run("echoer",
                agent(List.of("echo", "{prompt}"), Duration.ofSeconds(10)), "the answer is 42", null);

        assertThat(result.succeeded()).isTrue();
        assertThat(result.output()).isEqualTo("the answer is 42");
        assertThat(result.exitCode()).isZero();
    }

    @Test
    void doesNotLetAPromptEscapeIntoAShell() {
        // the whole point of passing argv rather than a command line: these metacharacters
        // must come back as text, never run
        String hostile = "harmless; touch /tmp/mcp-bridge-pwned; echo $(whoami) `id` && ls /";

        AgentResult result = runner.run("echoer",
                agent(List.of("echo", "{prompt}"), Duration.ofSeconds(10)), hostile, null);

        assertThat(result.output()).isEqualTo(hostile);
        assertThat(Path.of("/tmp/mcp-bridge-pwned")).doesNotExist();
    }

    @Test
    void reportsFailureWhenTheAgentExitsNonZero() {
        AgentResult result = runner.run("failer",
                agent(List.of("sh", "-c", "echo bad >&2; exit 3; : {prompt}"), Duration.ofSeconds(10)),
                "anything", null);

        assertThat(result.succeeded()).isFalse();
        assertThat(result.exitCode()).isEqualTo(3);
        assertThat(result.diagnostics()).contains("exited with code 3").contains("bad");
    }

    @Test
    void doesNotStallAfterStoppingAnAgentWhoseGrandchildOutlivesIt() {
        long start = System.currentTimeMillis();

        AgentResult result = runner.run("sleeper",
                agent(List.of("sh", "-c", "sleep 60; : {prompt}"), Duration.ofMillis(500)),
                "anything", null);

        assertThat(result.timedOut()).isTrue();
        // the orphaned sleep must not keep us waiting for its full 60s
        assertThat(System.currentTimeMillis() - start).isLessThan(15_000);
    }

    @Test
    void stopsAnAgentThatOverrunsItsTimeout() {
        AgentResult result = runner.run("sleeper",
                agent(List.of("sh", "-c", "sleep 30; : {prompt}"), Duration.ofMillis(600)),
                "anything", null);

        assertThat(result.timedOut()).isTrue();
        assertThat(result.succeeded()).isFalse();
        assertThat(result.diagnostics()).contains("did not finish");
        assertThat(result.durationMillis()).isLessThan(20_000);
    }

    @Test
    void explainsAMissingExecutableInsteadOfThrowing() {
        AgentResult result = runner.run("ghost",
                agent(List.of("definitely-not-installed-xyz", "{prompt}"), Duration.ofSeconds(5)),
                "hello", null);

        assertThat(result.succeeded()).isFalse();
        assertThat(result.diagnostics()).contains("on PATH");
    }

    @Test
    void doesNotDeadlockWhenAnAgentFloodsBothStreams() {
        // stdout and stderr are drained concurrently; reading them in sequence would block
        // here once the first pipe filled
        AgentRunner roomy = new AgentRunner(new AgentsProperties(Map.of(), 1_000_000));

        AgentResult result = roomy.run("noisy",
                // ~130KB per stream, comfortably past a 64KB pipe buffer, and far faster
                // than a shell loop
                agent(List.of("sh", "-c", "seq 1 20000; seq 1 20000 >&2; : {prompt}"),
                        Duration.ofSeconds(30)),
                "anything", null);

        assertThat(result.succeeded()).isTrue();
        assertThat(result.output()).contains("20000");
    }

    @Test
    void truncatesOutputThatWouldFloodTheCaller() {
        AgentRunner small = new AgentRunner(new AgentsProperties(Map.of(), 50));

        AgentResult result = small.run("chatty",
                agent(List.of("sh", "-c", "printf 'x%.0s' $(seq 1 500); : {prompt}"), Duration.ofSeconds(10)),
                "anything", null);

        assertThat(result.outputTruncated()).isTrue();
        assertThat(result.output()).endsWith("...[truncated]");
    }

    @Test
    void runsInTheRequestedWorkingDirectory(@TempDir Path dir) throws Exception {
        Files.writeString(dir.resolve("marker.txt"), "found me");

        AgentResult result = runner.run("lister",
                agent(List.of("sh", "-c", "cat marker.txt; : {prompt}"), Duration.ofSeconds(10)),
                "anything", dir.toString());

        assertThat(result.output()).isEqualTo("found me");
    }

    @Test
    void rejectsAWorkingDirectoryThatIsNotADirectory() {
        AgentResult result = runner.run("lister",
                agent(List.of("echo", "{prompt}"), Duration.ofSeconds(10)),
                "anything", "/no/such/place");

        assertThat(result.succeeded()).isFalse();
        assertThat(result.diagnostics()).contains("not a directory");
    }
}
