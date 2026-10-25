package com.szeeshan.mcpbridge.mcp;

import java.util.List;
import java.util.Optional;

import com.szeeshan.mcpbridge.bus.Agent;
import com.szeeshan.mcpbridge.bus.BusProperties;
import com.szeeshan.mcpbridge.bus.Message;
import com.szeeshan.mcpbridge.bus.MessageBus;
import com.szeeshan.mcpbridge.bus.Room;

import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;
import org.springframework.stereotype.Component;

/**
 * The tools this MCP server exposes. Every connected AI client sees these and
 * calls them to reach the other agents on the bus.
 *
 * <p>Each tool takes the caller's own name as {@code me} rather than relying on
 * transport-level identity, which MCP does not give the server reliably.
 */
@Component
public class BusTools {

    private static final long POLL_INTERVAL_MS = 250;

    private final MessageBus bus;
    private final BusProperties properties;

    public BusTools(MessageBus bus, BusProperties properties) {
        this.bus = bus;
        this.properties = properties;
    }

    @Tool(name = "register_agent", description = """
            Announce yourself on the bus so other AI agents can see and address you.
            Call this once, early in the session. Pick a short stable name such as
            "claude", "codex" or "cursor" — others will use it to message you.""")
    public Agent registerAgent(
            @ToolParam(description = "Your own short name, e.g. \"claude\".")
            String name,
            @ToolParam(description = "One line on what you are good at, so others know when to ask you.", required = false)
            String description) {
        return bus.register(name, description);
    }

    @Tool(name = "list_agents", description = """
            List every agent on the bus with when it was last active. Use this to find
            out who you can ask something before calling send_message.""")
    public List<Agent> listAgents() {
        return bus.agents();
    }

    @Tool(name = "send_message", description = """
            Send a question or task to another AI agent. This does not wait for an answer —
            follow it with wait_for_reply if you need one now, or check inbox later.
            Include everything the other agent needs in the text: it does not share your
            conversation or your files. Read the "note" in the result and pass it on to the
            user, because a message to an agent that is not connected yet is accepted and
            left waiting rather than rejected.""")
    public SendReceipt sendMessage(
            @ToolParam(description = "Your own short name.")
            String me,
            @ToolParam(description = "Name of the agent to send to, as shown by list_agents.")
            String to,
            @ToolParam(description = "The full question or task. Be self-contained.")
            String text) {
        Message message = bus.send(me, to, text, null);
        boolean registered = bus.isRegistered(message.to());
        String note = registered
                ? "Delivered to %s's inbox. It arrives when %s next checks inbox."
                        .formatted(message.to(), message.to())
                : ("No agent named %s has connected to this bridge yet, so nothing will read this "
                        + "until one does. Check list_agents for who is actually here, and tell the "
                        + "user to start %s and ask it to check its inbox.")
                        .formatted(message.to(), message.to());
        return new SendReceipt(message, registered, note);
    }

    @Tool(name = "inbox", description = """
            Collect the messages other agents have sent you and mark them read. Call this
            when you start a session and whenever you are asked to check for work. Answer
            each one with the reply tool.""")
    public List<Message> inbox(
            @ToolParam(description = "Your own short name.")
            String me) {
        return bus.drainInbox(me);
    }

    @Tool(name = "reply", description = """
            Answer a message you received. Pass the id of the message you are answering so
            the agent waiting on it gets your reply.""")
    public Message reply(
            @ToolParam(description = "Your own short name.")
            String me,
            @ToolParam(description = "The id field of the message you are answering.")
            String messageId,
            @ToolParam(description = "Your answer.")
            String text) {
        Message original = bus.message(messageId)
                .orElseThrow(() -> new IllegalArgumentException("no message with id " + messageId));
        return bus.send(me, original.from(), text, messageId);
    }

    @Tool(name = "wait_for_reply", description = """
            Wait for an answer to a message you sent, up to a timeout, and return it.
            Returns null if nothing arrived in time — that usually means the other agent is
            not running or has not checked its inbox, so tell the user to nudge it rather
            than retrying in a loop.""")
    public Message waitForReply(
            @ToolParam(description = "The id of the message you sent and want an answer to.")
            String messageId,
            @ToolParam(description = "Seconds to wait. Keep it modest; capped by the server.", required = false)
            Integer timeoutSeconds) {
        int requested = timeoutSeconds == null ? 30 : timeoutSeconds;
        long deadline = System.currentTimeMillis()
                + Math.max(1, Math.min(requested, properties.maxWaitSeconds())) * 1000L;
        while (System.currentTimeMillis() < deadline) {
            Optional<Message> reply = bus.replyTo(messageId);
            if (reply.isPresent()) {
                return reply.get();
            }
            try {
                Thread.sleep(POLL_INTERVAL_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return null;
            }
        }
        return null;
    }

    @Tool(name = "conversation_history", description = """
            Return the messages exchanged between you and another agent, oldest first, so
            you can pick up a thread you did not start.""")
    public List<Message> conversationHistory(
            @ToolParam(description = "Your own short name.")
            String me,
            @ToolParam(description = "The other agent's name.")
            String other,
            @ToolParam(description = "How many of the most recent messages to return.", required = false)
            Integer limit) {
        int effective = limit == null ? 50 : Math.min(limit, properties.historyLimit());
        return bus.conversation(me, other, effective);
    }

    @Tool(name = "create_room", description = """
            Create a named room where several agents can discuss one topic together, as an
            alternative to one-to-one messages. Safe to call if it already exists.""")
    public Room createRoom(
            @ToolParam(description = "Short room name, e.g. \"api-design\".")
            String name,
            @ToolParam(description = "What this room is for.", required = false)
            String topic) {
        return bus.createRoom(name, topic);
    }

    @Tool(name = "list_rooms", description = "List the rooms that exist on the bus.")
    public List<Room> listRooms() {
        return bus.rooms();
    }

    @Tool(name = "post_to_room", description = """
            Post to a room so every agent reading it sees your message. Read the room first
            so you answer what was actually said instead of repeating it.""")
    public Message postToRoom(
            @ToolParam(description = "Your own short name.")
            String me,
            @ToolParam(description = "The room name.")
            String room,
            @ToolParam(description = "What you want to say.")
            String text) {
        return bus.post(me, room, text);
    }

    @Tool(name = "read_room", description = """
            Read the most recent posts in a room, oldest first.""")
    public List<Message> readRoom(
            @ToolParam(description = "The room name.")
            String room,
            @ToolParam(description = "How many of the most recent posts to return.", required = false)
            Integer limit) {
        int effective = limit == null ? 50 : Math.min(limit, properties.historyLimit());
        return bus.readRoom(room, effective);
    }
}
