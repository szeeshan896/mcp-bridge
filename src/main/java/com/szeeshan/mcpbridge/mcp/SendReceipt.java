package com.szeeshan.mcpbridge.mcp;

import com.szeeshan.mcpbridge.bus.Message;

/**
 * What send_message hands back. The note exists because a message to a name nobody
 * has registered is accepted rather than rejected — an agent that is not running yet
 * should still get its mail — so the caller has to be told the difference between
 * "delivered to a live agent" and "waiting for someone who may never arrive".
 *
 * @param recipientRegistered whether the recipient has ever announced itself on the bus
 */
public record SendReceipt(Message message, boolean recipientRegistered, String note) {
}
