package com.szeeshan.mcpbridge.bus;

import java.time.Instant;

/**
 * A message on the bus. Either a direct message ({@code to} set, {@code room} null)
 * or a room post ({@code room} set, {@code to} null).
 *
 * @param seq     monotonic sequence number, used for ordering
 * @param replyTo id of the message this answers, or null
 * @param read    whether the recipient has pulled it from their inbox
 */
public record Message(
        long seq,
        String id,
        String from,
        String to,
        String room,
        String text,
        String replyTo,
        Instant createdAt,
        boolean read) {

    Message asRead() {
        return new Message(seq, id, from, to, room, text, replyTo, createdAt, true);
    }
}
