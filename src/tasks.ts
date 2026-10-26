import { randomUUID } from 'node:crypto';

import type { Agent, AgentResult, RunOptions } from './agents/types.js';
import type { ConcurrencyLimit } from './limit.js';

export interface Task {
  id: string;
  agent: string;
  status: 'running' | 'finished';
  prompt: string;
  startedAt: string;
  finishedAt?: string;
  result?: AgentResult;
}

const KEEP_FINISHED_MS = 60 * 60 * 1000;
const MAX_TASKS = 200;

/**
 * Tasks for work that outlives a single tool call. ask_agent is the normal path; this
 * exists because a long delegation otherwise dies on the caller's request timeout, which
 * is a property of the client and not something the bridge can raise.
 */
export class TaskStore {
  private readonly tasks = new Map<string, Task>();

  constructor(private readonly limit: ConcurrencyLimit) {}

  start(agent: Agent, prompt: string, options: RunOptions): Task {
    this.prune();
    const task: Task = {
      id: randomUUID(),
      agent: agent.name,
      status: 'running',
      prompt,
      startedAt: new Date().toISOString(),
    };
    this.tasks.set(task.id, task);

    // deliberately not awaited: the point is to return an id now
    void this.limit
      .run(() => agent.run(prompt, options))
      .then((result) => this.finish(task.id, result))
      .catch((error: unknown) =>
        this.finish(task.id, {
          agent: agent.name,
          succeeded: false,
          output: '',
          diagnostics: `the task threw: ${(error as Error).message}`,
          notes: '',
          durationMs: 0,
          timedOut: false,
          outputTruncated: false,
        }),
      );

    return task;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  list(): Task[] {
    return [...this.tasks.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  private finish(id: string, result: AgentResult): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.status = 'finished';
    task.result = result;
    task.finishedAt = new Date().toISOString();
  }

  /** Keeps the store from growing without bound in a long-lived process. */
  private prune(): void {
    const cutoff = Date.now() - KEEP_FINISHED_MS;
    for (const [id, task] of this.tasks) {
      if (task.finishedAt && Date.parse(task.finishedAt) < cutoff) this.tasks.delete(id);
    }
    while (this.tasks.size >= MAX_TASKS) {
      const oldestFinished = [...this.tasks.values()]
        .filter((t) => t.status === 'finished')
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
      if (!oldestFinished) break;
      this.tasks.delete(oldestFinished.id);
    }
  }
}
