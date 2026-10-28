import { stripAnsi } from './types.js';

/**
 * Reading what an agent's run actually amounted to, beyond its exit code.
 *
 * <p>A field report from a real session found the gap: an agent whose every tool call was
 * blocked by a broken hook exited 0 after 75 seconds with a polite paragraph explaining
 * that it had read nothing, and the bridge reported `succeeded: true`. A caller that
 * branches on that field -- which is what it is for -- would have recorded a non-answer
 * as an answer. The same report found a failed call returning ~350 words of the caller's
 * own prompt in `diagnostics`, plus the CLI banner, plus the error twice. These helpers
 * address both, without pretending to understand the agent's reasoning.
 */

export type FailureKind = 'quota' | 'auth' | 'trust' | 'other';

const QUOTA = /usage limit|rate[ -]?limit|quota|insufficient[ _]balance|balance (is )?exhausted|payment required|\b402\b|\b429\b|too many requests|out of credits|credits? (are )?exhausted/i;
const AUTH = /not (logged|signed) in|please (log|sign) ?in|authenticat|unauthori[sz]ed|\b401\b|ineligible|invalid api key|api key (was )?rejected|login required|session expired|re-?authenticate/i;
const TRUST = /trusted (directory|folder|workspace)|skip-trust|TRUST_WORKSPACE/i;

/** What kind of failure this was, so a durable one can be remembered and shown up front. */
export function classifyFailure(text: string): { kind: FailureKind; retryAt?: string } {
  const retry = /try again (?:at|in|after) ([^.\n"]{1,40})/i.exec(text)?.[1]?.trim();
  // quota first: "you've hit your usage limit, log in to upgrade" is a quota problem
  const kind: FailureKind = QUOTA.test(text) ? 'quota' : TRUST.test(text) ? 'trust' : AUTH.test(text) ? 'auth' : 'other';
  return retry ? { kind, retryAt: retry } : { kind };
}

/**
 * stderr as worth reading: the caller's own prompt removed (some CLIs echo it back),
 * repeated lines dropped, and -- when it is long -- the lines that look like errors kept
 * ahead of the banner, within a hard cap.
 */
export function cleanDiagnostics(stderr: string, prompt: string, maxChars = 1_500): string {
  const promptLines = new Set(
    prompt.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= 12),
  );
  const flatPrompt = prompt.trim();
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of stripAnsi(stderr).split(/\r?\n/)) {
    let line = raw.trimEnd();
    if (flatPrompt.length >= 12 && line.includes(flatPrompt)) line = line.replace(flatPrompt, '[your prompt]');
    const key = line.trim();
    if (!key || promptLines.has(key) || seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }

  const joined = lines.join('\n');
  if (joined.length <= maxChars) return joined;

  const important = lines.filter((l) => /error|fail|denied|refus|limit|quota|cannot|can't|not (found|logged|signed|trusted)|invalid|unauthori|forbidden|expired|exhausted/i.test(l));
  const tail = lines.slice(-5).filter((l) => !important.includes(l));
  const picked = [...important, ...tail].join('\n');
  const body = picked.length > 0 ? picked : joined;
  return body.length <= maxChars ? body : `${body.slice(0, maxChars)}\n...[trimmed]`;
}

/**
 * The agent saying, in its own words, that it could not do the work. Deliberately narrow
 * -- first person, about reading or running things -- so an answer that merely discusses
 * a permissions error in someone's code is not mistaken for one.
 */
const SELF_REPORTED = [
  /\bI(?:'m| am| was)? (?:currently |still )?(?:unable|not able|blocked|prevented|not permitted) (?:from |to )?(?:read|access|inspect|open|view|run|use|execute|see)\w*/i,
  /\bI (?:cannot|can't|could not|couldn't) (?:read|access|inspect|open|view|run|use|execute|see) (?:any|the|your|these|those|this)\b/i,
  /\bevery tool (?:call|execution|invocation)s? (?:is |are |was |were )?(?:failing|blocked|failed)/i,
  /\b(?:all|my) tool (?:calls|executions) (?:are|were|keep) (?:failing|blocked|failed)/i,
];

export function selfReportedFailure(output: string): string | null {
  const head = output.slice(0, 4_000);
  for (const pattern of SELF_REPORTED) {
    const match = pattern.exec(head);
    if (!match) continue;
    // quote the sentence it sits in, so the caller sees the agent's own reason
    const start = Math.max(head.lastIndexOf('.', match.index) + 1, head.lastIndexOf('\n', match.index) + 1, 0);
    const endDot = head.indexOf('.', match.index + match[0].length);
    const end = endDot === -1 ? Math.min(head.length, match.index + 240) : endDot + 1;
    return head.slice(start, end).trim().slice(0, 400);
  }
  return null;
}

/**
 * An answer that is nothing but an announcement -- "I'll read payment.ts and report only
 * what the file actually does." -- with nothing after it. That is what an agent leaves
 * when it stops at its first tool step, typically one it was not allowed to take, and it
 * read as `succeeded: true` with no answer in it. Short, opening with an intention, and
 * without a single line that looks like a finding.
 */
export function onlyAnnounced(output: string): boolean {
  const text = output.trim();
  if (!text || text.length > 500) return false;
  // an intention to go and look at something, not "I'll be brief: ..." followed by an answer
  if (!PREAMBLE_OPENING.test(text)) return false;
  // anything with structure or code is an answer, however it opens
  if (/```|^\s*[-*•]\s|^\s*\d+[.)]\s|\w\.\w+:\d+|\n\s*\n/m.test(text)) return false;
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
  return sentences.every((s) => INTENTION.test(s) || s.length < 60);
}

const STEP = '(?:read|check|look|inspect|review|confirm|examine|open|run|analy[sz]e|go through|explore|search|scan|start|begin|investigate|verify|find|trace|walk through|take a look)';
const PREAMBLE_OPENING = new RegExp(
  `^(?:(?:okay|ok|sure|alright|first|now|great),?\\s+)?(?:I'll|I will|I'm going to|I am going to|Let me|I need to|I'm about to)\\s+(?:first\\s+|now\\s+|start by\\s+|begin by\\s+)?${STEP}`, 'i');
const INTENTION = new RegExp(`\\b(?:I'll|I will|I'm going to|I am going to|Let me|I need to)\\s+(?:\\w+\\s+){0,3}?${STEP}`, 'i');

/** Errors a CLI printed while still exiting 0 -- a failing hook is the case that prompted this. */
export function troubleOnSuccess(stderr: string): string | null {
  const lines = stripAnsi(stderr).split(/\r?\n/).filter((l) =>
    /PreToolUse|PostToolUse|hook.*(fail|error)|(fail|error).*hook|Cannot find module|MODULE_NOT_FOUND|tool (call|execution) failed/i.test(l));
  if (lines.length === 0) return null;
  return [...new Set(lines.map((l) => l.trim()))].slice(0, 5).join('\n').slice(0, 800);
}
