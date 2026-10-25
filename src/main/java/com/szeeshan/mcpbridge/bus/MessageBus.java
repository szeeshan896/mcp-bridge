package com.szeeshan.mcpbridge.bus;

import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

import org.springframework.stereotype.Service;

/**
 * The shared bus. Holds agents, messages and rooms in memory and is the single
 * source of truth for all of them, so state is shared across every MCP client
 * connected to this process.
 *
 * <p>State is in-memory on purpose for now: it is lost on restart. Swapping in a
 * persistent store means replacing the three maps below, nothing else.
 */
@Service
public class MessageBus {

    private final Map<String, Agent> agents = new ConcurrentHashMap<>();
    private final Map<String, Message> messages = new ConcurrentHashMap<>();
    private final Map<String, Room> rooms = new ConcurrentHashMap<>();
    private final AtomicLong sequence = new AtomicLong();

    private static String key(String name) {
        return name == null ? null : name.trim().toLowerCase();
    }

    // --- agents ---------------------------------------------------------

    public Agent register(String name, String description) {
        String id = requireName(name);
        return agents.compute(id, (k, existing) -> existing == null
                ? new Agent(id, description, Instant.now(), Instant.now())
                : new Agent(id, description == null ? existing.description() : description,
                        existing.registeredAt(), Instant.now()));
    }

    public List<Agent> agents() {
        return agents.values().stream()
                .sorted(Comparator.comparing(Agent::name))
                .toList();
    }

    public boolean isRegistered(String name) {
        return agents.containsKey(key(name));
    }

    /** Records that an agent is active. Agents that message without registering are auto-registered. */
    private String touch(String name) {
        String id = requireName(name);
        agents.compute(id, (k, existing) -> existing == null
                ? new Agent(id, null, Instant.now(), Instant.now())
                : existing.seenNow());
        return id;
    }

    private static String requireName(String name) {
        String id = key(name);
        if (id == null || id.isEmpty()) {
            throw new IllegalArgumentException("agent name must not be blank");
        }
        return id;
    }

    // --- direct messages ------------------------------------------------

    public Message send(String from, String to, String text, String replyTo) {
        String sender = touch(from);
        String recipient = requireName(to);
        if (sender.equals(recipient)) {
            throw new IllegalArgumentException("cannot send a message to yourself");
        }
        if (text == null || text.isBlank()) {
            throw new IllegalArgumentException("message text must not be blank");
        }
        if (replyTo != null && !messages.containsKey(replyTo)) {
            throw new IllegalArgumentException("no message with id " + replyTo);
        }
        Message message = new Message(sequence.incrementAndGet(), UUID.randomUUID().toString(),
                sender, recipient, null, text, replyTo, Instant.now(), false);
        messages.put(message.id(), message);
        return message;
    }

    /** Unread messages addressed to {@code me}, oldest first. Marks them read. */
    public List<Message> drainInbox(String me) {
        String recipient = touch(me);
        List<Message> pending = messages.values().stream()
                .filter(m -> recipient.equals(m.to()) && !m.read())
                .sorted(Comparator.comparingLong(Message::seq))
                .toList();
        pending.forEach(m -> messages.put(m.id(), m.asRead()));
        return pending;
    }

    /** Unread messages addressed to {@code me} without marking them read. */
    public List<Message> peekInbox(String me) {
        String recipient = requireName(me);
        return messages.values().stream()
                .filter(m -> recipient.equals(m.to()) && !m.read())
                .sorted(Comparator.comparingLong(Message::seq))
                .toList();
    }

    public Optional<Message> replyTo(String messageId) {
        return messages.values().stream()
                .filter(m -> messageId.equals(m.replyTo()))
                .min(Comparator.comparingLong(Message::seq));
    }

    public Optional<Message> message(String id) {
        return Optional.ofNullable(messages.get(id));
    }

    public List<Message> conversation(String agentA, String agentB, int limit) {
        String a = requireName(agentA);
        String b = requireName(agentB);
        List<Message> between = messages.values().stream()
                .filter(m -> (a.equals(m.from()) && b.equals(m.to()))
                        || (b.equals(m.from()) && a.equals(m.to())))
                .sorted(Comparator.comparingLong(Message::seq))
                .toList();
        return between.size() <= limit ? between : between.subList(between.size() - limit, between.size());
    }

    // --- rooms ----------------------------------------------------------

    public Room createRoom(String name, String topic) {
        String id = requireName(name);
        return rooms.computeIfAbsent(id, k -> new Room(id, topic, Instant.now()));
    }

    public List<Room> rooms() {
        return rooms.values().stream().sorted(Comparator.comparing(Room::name)).toList();
    }

    public Message post(String from, String room, String text) {
        String sender = touch(from);
        String roomId = requireName(room);
        if (!rooms.containsKey(roomId)) {
            throw new IllegalArgumentException("no room named " + roomId + "; create it first");
        }
        if (text == null || text.isBlank()) {
            throw new IllegalArgumentException("message text must not be blank");
        }
        Message message = new Message(sequence.incrementAndGet(), UUID.randomUUID().toString(),
                sender, null, roomId, text, null, Instant.now(), true);
        messages.put(message.id(), message);
        return message;
    }

    public List<Message> readRoom(String room, int limit) {
        String roomId = requireName(room);
        if (!rooms.containsKey(roomId)) {
            throw new IllegalArgumentException("no room named " + roomId);
        }
        List<Message> posts = messages.values().stream()
                .filter(m -> roomId.equals(m.room()))
                .sorted(Comparator.comparingLong(Message::seq))
                .toList();
        return posts.size() <= limit ? posts : posts.subList(posts.size() - limit, posts.size());
    }
}
