package com.szeeshan.mcpbridge.mcp;

import com.szeeshan.mcpbridge.bus.BusProperties;
import com.szeeshan.mcpbridge.bus.Message;
import com.szeeshan.mcpbridge.bus.MessageBus;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;
import static java.time.Duration.ofSeconds;

class BusToolsTest {

    private final MessageBus bus = new MessageBus();
    private final BusTools tools = new BusTools(bus, new BusProperties(90, 200));

    @Test
    void waitForReplyReturnsTheAnswerOnceItArrives() {
        Message question = tools.sendMessage("claude", "codex", "which index is missing?").message();

        Thread responder = new Thread(() -> {
            await().atMost(ofSeconds(5)).until(() -> !bus.peekInbox("codex").isEmpty());
            Message incoming = tools.inbox("codex").getFirst();
            tools.reply("codex", incoming.id(), "one on orders.created_at");
        });
        responder.start();

        Message answer = tools.waitForReply(question.id(), 10);

        assertThat(answer).isNotNull();
        assertThat(answer.text()).isEqualTo("one on orders.created_at");
        assertThat(answer.from()).isEqualTo("codex");
    }

    @Test
    void waitForReplyReturnsNullWhenNobodyAnswers() {
        Message question = tools.sendMessage("claude", "codex", "anyone awake?").message();

        assertThat(tools.waitForReply(question.id(), 1)).isNull();
    }

    @Test
    void waitForReplyIsCappedByConfiguredMaximum() {
        BusTools capped = new BusTools(bus, new BusProperties(1, 200));
        Message question = capped.sendMessage("claude", "codex", "takes too long").message();

        long start = System.currentTimeMillis();
        capped.waitForReply(question.id(), 3600);

        assertThat(System.currentTimeMillis() - start).isLessThan(5_000);
    }

    @Test
    void replyGoesBackToTheOriginalSender() {
        Message question = tools.sendMessage("claude", "codex", "question").message();

        Message answer = tools.reply("codex", question.id(), "answer");

        assertThat(answer.to()).isEqualTo("claude");
        assertThat(tools.inbox("claude")).extracting(Message::text).containsExactly("answer");
    }

    @Test
    void receiptWarnsWhenNobodyIsListening() {
        SendReceipt receipt = tools.sendMessage("claude", "codex", "hello?");

        assertThat(receipt.recipientRegistered()).isFalse();
        assertThat(receipt.note()).contains("has connected to this bridge yet");
    }

    @Test
    void receiptConfirmsDeliveryToARegisteredAgent() {
        tools.registerAgent("codex", "code review");

        SendReceipt receipt = tools.sendMessage("claude", "codex", "take a look");

        assertThat(receipt.recipientRegistered()).isTrue();
        assertThat(receipt.note()).contains("Delivered");
    }

    @Test
    void listAgentsShowsEveryoneWhoHasSpoken() {
        tools.registerAgent("claude", "refactoring");
        tools.sendMessage("codex", "claude", "hi");

        assertThat(tools.listAgents()).extracting(a -> a.name()).containsExactly("claude", "codex");
    }
}
