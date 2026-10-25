package com.szeeshan.mcpbridge.bus;

import java.util.List;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MessageBusTest {

    private final MessageBus bus = new MessageBus();

    @Test
    void deliversMessageToRecipientInboxOnce() {
        Message sent = bus.send("claude", "codex", "Why does this test fail?", null);

        assertThat(bus.drainInbox("codex")).extracting(Message::id).containsExactly(sent.id());
        assertThat(bus.drainInbox("codex")).isEmpty();
    }

    @Test
    void doesNotDeliverToOtherAgents() {
        bus.send("claude", "codex", "for codex only", null);

        assertThat(bus.drainInbox("cursor")).isEmpty();
    }

    @Test
    void peekLeavesMessageUnread() {
        bus.send("claude", "codex", "still pending", null);

        assertThat(bus.peekInbox("codex")).hasSize(1);
        assertThat(bus.peekInbox("codex")).hasSize(1);
    }

    @Test
    void linksReplyToOriginalMessage() {
        Message question = bus.send("claude", "codex", "which index is missing?", null);

        Message answer = bus.send("codex", "claude", "add one on orders.created_at", question.id());

        assertThat(bus.replyTo(question.id())).contains(answer);
        assertThat(answer.replyTo()).isEqualTo(question.id());
    }

    @Test
    void reportsNoReplyUntilOneArrives() {
        Message question = bus.send("claude", "codex", "anyone there?", null);

        assertThat(bus.replyTo(question.id())).isEmpty();
    }

    @Test
    void autoRegistersTheSenderButNotTheRecipient() {
        bus.send("claude", "codex", "hello", null);

        // addressing a name must not conjure an agent, or a typo would look like a peer
        assertThat(bus.agents()).extracting(Agent::name).containsExactly("claude");
        assertThat(bus.isRegistered("codex")).isFalse();
    }

    @Test
    void holdsMailForAnAgentThatHasNotConnectedYet() {
        bus.send("claude", "codex", "waiting for you", null);

        bus.register("codex", "arrived late");

        assertThat(bus.drainInbox("codex")).extracting(Message::text).containsExactly("waiting for you");
    }

    @Test
    void treatsAgentNamesCaseInsensitively() {
        bus.register("Claude", null);

        bus.send("CLAUDE", "Codex", "mixed case", null);

        assertThat(bus.isRegistered("claude")).isTrue();
        assertThat(bus.drainInbox("CODEX")).extracting(Message::text).containsExactly("mixed case");
    }

    @Test
    void readingTheInboxMarksTheReaderPresent() {
        bus.send("claude", "codex", "hello", null);
        assertThat(bus.isRegistered("codex")).isFalse();

        bus.drainInbox("codex");

        assertThat(bus.isRegistered("codex")).isTrue();
    }

    @Test
    void registerKeepsOriginalTimestampAndUpdatesDescription() {
        Agent first = bus.register("claude", "good at refactoring");
        Agent second = bus.register("claude", "good at tests");

        assertThat(second.registeredAt()).isEqualTo(first.registeredAt());
        assertThat(second.description()).isEqualTo("good at tests");
    }

    @Test
    void rejectsSelfAddressedMessages() {
        assertThatThrownBy(() -> bus.send("claude", "claude", "talking to myself", null))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("yourself");
    }

    @Test
    void rejectsBlankTextAndNames() {
        assertThatThrownBy(() -> bus.send("claude", "codex", "  ", null))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> bus.send("", "codex", "hi", null))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void rejectsReplyToUnknownMessage() {
        assertThatThrownBy(() -> bus.send("codex", "claude", "answer", "no-such-id"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("no-such-id");
    }

    @Test
    void returnsConversationInOrderBothDirections() {
        bus.send("claude", "codex", "first", null);
        bus.send("codex", "claude", "second", null);
        bus.send("claude", "codex", "third", null);
        bus.send("claude", "cursor", "unrelated", null);

        List<Message> thread = bus.conversation("claude", "codex", 50);

        assertThat(thread).extracting(Message::text).containsExactly("first", "second", "third");
    }

    @Test
    void conversationReturnsMostRecentWhenLimited() {
        bus.send("claude", "codex", "first", null);
        bus.send("claude", "codex", "second", null);
        bus.send("claude", "codex", "third", null);

        assertThat(bus.conversation("claude", "codex", 2))
                .extracting(Message::text).containsExactly("second", "third");
    }

    @Test
    void roomPostsAreVisibleToEveryone() {
        bus.createRoom("api-design", "shape of the public API");
        bus.post("claude", "api-design", "I'd version it in the path");
        bus.post("codex", "api-design", "header-based is cleaner");

        assertThat(bus.readRoom("api-design", 50))
                .extracting(Message::from).containsExactly("claude", "codex");
    }

    @Test
    void roomPostsDoNotLandInAnyonesInbox() {
        bus.createRoom("api-design", null);
        bus.post("claude", "api-design", "thoughts?");

        assertThat(bus.peekInbox("codex")).isEmpty();
    }

    @Test
    void readRoomReturnsMostRecentWhenLimited() {
        bus.createRoom("r", null);
        bus.post("claude", "r", "one");
        bus.post("claude", "r", "two");
        bus.post("claude", "r", "three");

        assertThat(bus.readRoom("r", 2)).extracting(Message::text).containsExactly("two", "three");
    }

    @Test
    void createRoomIsIdempotent() {
        Room first = bus.createRoom("api-design", "original topic");

        assertThat(bus.createRoom("api-design", "different topic")).isEqualTo(first);
        assertThat(bus.rooms()).hasSize(1);
    }

    @Test
    void rejectsPostingToUnknownRoom() {
        assertThatThrownBy(() -> bus.post("claude", "ghost-room", "hello"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("create it first");
    }
}
