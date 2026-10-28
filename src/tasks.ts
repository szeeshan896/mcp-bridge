import { randomUUID } from 'node:crypto';

import type { Agent, AgentResult, RunOptions } from './agents/types.js';
import { stripAnsi } from './agents/types.js';
import type { ConcurrencyLimit } from './limit.js';

/**
 * What get_task shows. Not the prompt: the caller wrote it and has it, and handing it back
 * on every poll spends the caller's context for nothing.
 */
export interface Task {
  id: string;
  agent: string;
  /**
   * "queued" while it waits for one of the concurrent slots -- its timeout has not started
   * yet -- then "running", then "finished". A queued task was reported as running before,
   * which made one waiting behind others look like an agent hung for fifteen minutes.
   */
  status: 'queued' | 'running' | 'finished';
  /** how many tasks are ahead of it while queued */
  queuePosition?: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** the most recent output, while it runs: proof of life, and often most of an answer */
  outputSoFar?: string;
  lastOutputAt?: string;
  /** a caveat known when the task was accepted, e.g. a workingDirectory the agent cannot use */
  notes?: string;
  result?: AgentResult;
}

const KEEP_FINISHED_MS = 60 * 60 * 1000;
const MAX_TASKS = 200;
const PROGRESS_CHARS = 2_000;

/**
 * Tasks for work that outlives a single tool call. ask_agent is the normal path; this
 * exists because a long delegation otherwise dies on the caller's request timeout, which
 * is a property of the client and not something the bridge can raise.
 */
export class TaskStore {
  private readonly tasks = new Map<string, Task>();
  /** queued task ids in the order the limit will release them */
  private readonly queue: string[] = [];

  constructor(private readonly limit: ConcurrencyLimit) {}

  start(agent: Agent, prompt: string, options: RunOptions, notes?: string): Task {
    this.prune();
    const task: Task = {
      id: randomUUID(),
      agent: agent.name,
      status: 'queued',
      createdAt: new Date().toISOString(),
      ...(notes ? { notes } : {}),
    };
    this.tasks.set(task.id, task);
    this.queue.push(task.id);

    const onOutput = (chunk: string) => {
      const text = `${task.outputSoFar ?? ''}${stripAnsi(chunk)}`;
      task.outputSoFar = text.length > PROGRESS_CHARS ? `…${text.slice(-PROGRESS_CHARS)}` : text;
      task.lastOutputAt = new Date().toISOString();
    };

    // deliberately not awaited: the point is to return an id now
    void this.limit
      .run(() => {
        this.dequeue(task.id);
        task.status = 'running';
        task.startedAt = new Date().toISOString();
        return agent.run(prompt, { ...options, onOutput });
      })
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

    return this.view(task);
  }

  get(id: string): Task | undefined {
    const task = this.tasks.get(id);
    return task ? this.view(task) : undefined;
  }

  list(): Task[] {
    return [...this.tasks.values()].map((t) => this.view(t)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** A copy with the queue position filled in, so callers never hold the live object. */
  private view(task: Task): Task {
    const copy: Task = { ...task };
    if (task.status === 'queued') copy.queuePosition = this.queue.indexOf(task.id);
    if (task.status === 'finished') delete copy.outputSoFar;
    return copy;
  }

  private dequeue(id: string): void {
    const index = this.queue.indexOf(id);
    if (index !== -1) this.queue.splice(index, 1);
  }

  private finish(id: string, result: AgentResult): void {
    const task = this.tasks.get(id);
    if (!task) return;
    this.dequeue(id);
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
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!oldestFinished) break;
      this.tasks.delete(oldestFinished.id);
    }
  }
}
