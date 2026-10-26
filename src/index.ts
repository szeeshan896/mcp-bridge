#!/usr/bin/env node
import { createServer as createHttpServer } from 'node:http';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { AgentRegistry } from './agents/registry.js';
import { configPath, loadConfig } from './config.js';
import { ConcurrencyLimit } from './limit.js';
import { createServer } from './server.js';
import { TaskStore } from './tasks.js';

const USAGE = `mcpbridge - delegate work to another AI agent over MCP

  mcpbridge                  run as an MCP server over stdio (default)
  mcpbridge --http [port]    run as an HTTP server on 127.0.0.1 (default port 8808)
  mcpbridge --agents         print the configured agents and whether each is usable
  mcpbridge --example-config print a starter config; JSON on stdout, notes on stderr
  mcpbridge --help

Register it with a client once, e.g.

  claude mcp add mcpbridge -- npx -y mcpbridge

Agents come from ${configPath()} when it exists, otherwise from built-in defaults.
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }

  if (argv.includes('--example-config')) {
    printExampleConfig();
    return;
  }

  const { config, source } = loadConfig();
  const registry = new AgentRegistry(config);
  const limit = new ConcurrencyLimit(config.maxConcurrent);
  const tasks = new TaskStore(limit);

  if (argv.includes('--agents')) {
    process.stdout.write(`agents from ${source}\n\n`);
    for (const status of await registry.statuses()) {
      process.stdout.write(
        `${status.available ? '✓' : '✗'} ${status.name.padEnd(10)} ${status.detail}\n`,
      );
      // only meaningful for an agent that can actually be used
      if (status.available && !status.readsFiles) {
        process.stdout.write(`${''.padEnd(13)}cannot read files — inline context in the prompt\n`);
      }
    }
    return;
  }

  const httpIndex = argv.indexOf('--http');
  if (httpIndex === -1) {
    // stdio: the transport owns stdout, so every diagnostic must go to stderr or it
    // corrupts the protocol stream
    console.error(`mcpbridge on stdio, agents from ${source}`);
    await createServer(registry, tasks, limit).connect(new StdioServerTransport());
    return;
  }

  const port = Number(argv[httpIndex + 1] ?? 8808);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`not a usable port: ${argv[httpIndex + 1]}`);
    process.exitCode = 1;
    return;
  }

  // Stateless: sessionIdGenerator is omitted, so nothing is kept between requests and a
  // fresh server per request is correct.
  const http = createHttpServer((req, res) => {
    void (async () => {
      if (!req.url?.startsWith('/mcp')) {
        res.writeHead(404).end();
        return;
      }
      const transport = new StreamableHTTPServerTransport({
        // Loopback binding alone does not protect this server: a web page the user
        // visits can make their browser POST to 127.0.0.1, which would run ask_agent
        // on their machine. Rejecting unexpected Host headers is what stops that.
        enableDnsRebindingProtection: true,
        allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
      });
      res.on('close', () => void transport.close());
      await createServer(registry, tasks, limit).connect(transport);
      await transport.handleRequest(req, res);
    })().catch((error: unknown) => {
      console.error('request failed:', (error as Error).message);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  // Loopback only: reaching this server means running the configured commands, so a
  // socket on 0.0.0.0 would hand that to the whole network.
  http.listen(port, '127.0.0.1', () => {
    console.error(`mcpbridge on http://127.0.0.1:${port}/mcp, agents from ${source}`);
  });
}

/**
 * JSON on stdout, guidance on stderr, so `mcpbridge --example-config > config.json` writes
 * a usable file while the person still sees what to fill in.
 */
function printExampleConfig(): void {
  const example = {
    maxConcurrent: 2,
    maxOutputChars: 60_000,
    agents: {
      claude: { command: ['claude', '-p'], promptVia: 'stdin', timeoutMs: 300_000 },
      gemini: { command: ['gemini', '-p', '{prompt}'], timeoutMs: 300_000 },
      local: { type: 'ollama', description: 'A model running in Ollama' },
      grok: {
        type: 'openai',
        description: 'Grok, via the xAI API — no CLI exists, so this is the only route',
        baseUrl: 'https://api.x.ai/v1',
        apiKeyEnv: 'XAI_API_KEY',
      },
      openrouter: {
        type: 'openai',
        description: 'One key, many providers',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKeyEnv: 'OPENROUTER_API_KEY',
      },
    },
  };
  process.stdout.write(`${JSON.stringify(example, null, 2)}\n`);
  process.stderr.write(
    [
      '',
      `Save this to ${configPath()} and edit it.`,
      '',
      'The CLI agents need nothing but the tool installed and signed in.',
      'The "openai" agents need a key, exported under the name in apiKeyEnv — never put the',
      'key in this file, which is easy to copy into a repo or an issue by accident.',
      '',
      'The "openai" agents have no model set, so they report unavailable until you add one.',
      'With the key exported, `mcpbridge --agents` lists the ids that endpoint offers, where',
      'the provider exposes a listing; otherwise take one from its documentation.',
      '',
    ].join('\n'),
  );
}

main().catch((error: unknown) => {
  console.error(`mcpbridge failed to start: ${(error as Error).message}`);
  process.exitCode = 1;
});
