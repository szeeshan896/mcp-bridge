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

  mcpbridge                 run as an MCP server over stdio (default)
  mcpbridge --http [port]   run as an HTTP server on 127.0.0.1 (default port 8808)
  mcpbridge --agents        print the configured agents and whether each is usable
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
      if (!status.readsFiles) {
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

main().catch((error: unknown) => {
  console.error(`mcpbridge failed to start: ${(error as Error).message}`);
  process.exitCode = 1;
});
