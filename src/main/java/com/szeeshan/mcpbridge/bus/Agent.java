package com.szeeshan.mcpbridge.bus;

import java.time.Instant;

/**
 * An AI agent connected to the bus. Agents identify themselves by a short
 * stable name ("claude", "codex") which others use to address them.
 */
public record Agent(String name, String description, Instant registeredAt, Instant lastSeenAt) {

    Agent seenNow() {
        return new Agent(name, description, registeredAt, Instant.now());
    }
}
