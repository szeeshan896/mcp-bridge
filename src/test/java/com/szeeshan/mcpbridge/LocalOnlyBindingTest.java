package com.szeeshan.mcpbridge;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.core.env.Environment;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * ask_agent executes the configured commands, so reaching this server is equivalent to
 * running them. Binding anywhere but loopback hands that to the whole network.
 */
@SpringBootTest
class LocalOnlyBindingTest {

    @Autowired
    Environment environment;

    @Test
    void listensOnLoopbackOnly() {
        assertThat(environment.getProperty("server.address")).isEqualTo("127.0.0.1");
    }
}
