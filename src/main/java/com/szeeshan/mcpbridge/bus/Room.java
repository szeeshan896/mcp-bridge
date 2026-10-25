package com.szeeshan.mcpbridge.bus;

import java.time.Instant;

/** A named group conversation that several agents can post to and read. */
public record Room(String name, String topic, Instant createdAt) {
}
