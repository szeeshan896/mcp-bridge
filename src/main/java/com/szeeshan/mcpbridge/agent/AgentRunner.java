package com.szeeshan.mcpbridge.agent;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.lang.ProcessHandle;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Runs an agent's CLI as a child process and returns what it wrote.
 *
 * <p>The command is always passed to {@link ProcessBuilder} as a list, so no shell is
 * involved and nothing in the prompt can be read as a shell metacharacter.
 */
@Component
public class AgentRunner {

    private static final Logger log = LoggerFactory.getLogger(AgentRunner.class);

    private final AgentsProperties properties;

    public AgentRunner(AgentsProperties properties) {
        this.properties = properties;
    }

    public AgentResult run(String name, AgentDefinition definition, String prompt, String workingDirectory) {
        List<String> command = definition.commandFor(prompt);
        ProcessBuilder builder = new ProcessBuilder(command);

        String directory = workingDirectory != null ? workingDirectory : definition.workingDirectory();
        if (directory != null && !directory.isBlank()) {
            File dir = new File(directory);
            if (!dir.isDirectory()) {
                return failure(name, "workingDirectory is not a directory: " + directory, 0, false, 0);
            }
            builder.directory(dir);
        }

        long started = System.nanoTime();
        Process process;
        try {
            process = builder.start();
        } catch (IOException e) {
            return failure(name, ("could not start %s. Is it installed and on PATH? (%s)")
                    .formatted(definition.executable(), e.getMessage()), 0, false, elapsed(started));
        }

        // stdout and stderr must be drained at the same time: if one pipe fills while we
        // are blocked reading the other, the child process stops and never exits.
        ExecutorService readers = Executors.newVirtualThreadPerTaskExecutor();
        try {
            Future<String> stdout = readers.submit(read(process.getInputStream()));
            Future<String> stderr = readers.submit(read(process.getErrorStream()));

            boolean exited = process.waitFor(definition.timeout().toMillis(), TimeUnit.MILLISECONDS);
            if (!exited) {
                terminate(process);
                log.warn("agent {} timed out after {}", name, definition.timeout());
                return failure(name, "%s did not finish within %s and was stopped."
                        .formatted(name, definition.timeout()), -1, true, elapsed(started));
            }

            String out = stdout.get(10, TimeUnit.SECONDS);
            String err = stderr.get(10, TimeUnit.SECONDS);
            int exitCode = process.exitValue();
            Truncated body = truncate(out);

            if (exitCode != 0) {
                return new AgentResult(name, false, body.text(),
                        "%s exited with code %d. %s".formatted(name, exitCode, truncate(err).text()),
                        exitCode, false, elapsed(started), body.truncated());
            }
            return new AgentResult(name, true, body.text(), "", 0, false, elapsed(started), body.truncated());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            terminate(process);
            return failure(name, "interrupted while waiting for " + name, -1, false, elapsed(started));
        } catch (ExecutionException | java.util.concurrent.TimeoutException e) {
            terminate(process);
            return failure(name, "could not read output from " + name + ": " + e.getMessage(),
                    -1, false, elapsed(started));
        } finally {
            // shutdownNow, not close(): close() waits for the readers, and a reader blocked
            // on a pipe an orphaned grandchild still holds would stall us for its lifetime
            readers.shutdownNow();
        }
    }

    /**
     * Kills the whole process tree and closes its pipes. Killing only the direct child
     * leaves grandchildren alive — {@code sh -c "sleep 30"} outlives the shell — and an
     * orphan holding the pipe open keeps a reader blocked long after we gave up.
     */
    private static void terminate(Process process) {
        process.descendants().forEach(ProcessHandle::destroyForcibly);
        process.destroyForcibly();
        closeQuietly(process.getInputStream());
        closeQuietly(process.getErrorStream());
        try {
            process.waitFor(5, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static void closeQuietly(java.io.Closeable stream) {
        try {
            stream.close();
        } catch (IOException ignored) {
            // the pipe is going away either way
        }
    }

    private Callable<String> read(InputStream stream) {
        return () -> new String(stream.readAllBytes(), StandardCharsets.UTF_8);
    }

    private record Truncated(String text, boolean truncated) {
    }

    private Truncated truncate(String text) {
        if (text == null) {
            return new Truncated("", false);
        }
        String trimmed = text.strip();
        int max = properties.maxOutputChars();
        if (trimmed.length() <= max) {
            return new Truncated(trimmed, false);
        }
        return new Truncated(trimmed.substring(0, max) + "\n...[truncated]", true);
    }

    private static AgentResult failure(String name, String reason, int exitCode, boolean timedOut, long millis) {
        return new AgentResult(name, false, "", reason, exitCode, timedOut, millis, false);
    }

    private static long elapsed(long startedNanos) {
        return (System.nanoTime() - startedNanos) / 1_000_000;
    }
}
