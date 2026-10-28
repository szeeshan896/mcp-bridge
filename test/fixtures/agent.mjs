// A stand-in agent for the CliAgent tests. Written in Node rather than shell so the same
// tests run on Linux, macOS and Windows, which is the only way Windows CI proves anything.
//
//   node agent.mjs <mode> <prompt>
//
// modes:
//   echo                  write the prompt to stdout
//   stdin                 echo back everything read from stdin
//   ansi                  write colour escape codes around the answer
//   env:<name>            write the value of that environment variable
//   fail                  write to stderr and exit 3
//   flood                 write ~130KB to stdout and stderr at once
//   big:<n>               write n characters to stdout
//   read:<file>           write the contents of <file>, resolved against cwd
//   grandchild:<marker>   spawn a detached grandchild that creates <marker> after 1s,
//                         then hang — so a timeout has a tree to kill, not just a child
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const [mode = '', prompt = ''] = process.argv.slice(2);

if (mode === 'echo') {
  process.stdout.write(prompt);
} else if (mode === 'fail') {
  process.stderr.write('bad');
  process.exit(3);
} else if (mode === 'flood') {
  for (let i = 1; i <= 20000; i += 1) {
    process.stdout.write(`${i}\n`);
    process.stderr.write(`${i}\n`);
  }
} else if (mode.startsWith('big:')) {
  process.stdout.write('x'.repeat(Number(mode.slice(4))));
} else if (mode.startsWith('read:')) {
  process.stdout.write(readFileSync(mode.slice(5), 'utf8'));
} else if (mode.startsWith('grandchild:')) {
  const marker = mode.slice('grandchild:'.length);
  spawn(process.execPath, ['-e', `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "x"), 1000)`],
    { detached: false, stdio: 'ignore' });
  setTimeout(() => writeFileSync(marker, 'parent'), 60_000);
} else if (mode === 'stdin') {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  process.stdout.write(Buffer.concat(chunks).toString('utf8'));
} else if (mode === 'ansi') {
  process.stdout.write('\u001B[31mred\u001B[0m answer \u001B[1mand bold\u001B[22m');
} else if (mode === 'quota') {
  // what codex did in the field report: banner, the prompt echoed back, the error twice
  process.stderr.write(`OpenAI Codex v0.0\n--------\nworkdir: ${process.cwd()}\nmodel: gpt-x\nsession id: 1234\n--------\nuser\n${prompt}\n`);
  process.stderr.write("ERROR: You've hit your usage limit. Upgrade to Pro or try again at 4:22 AM.\n");
  process.stderr.write("ERROR: You've hit your usage limit. Upgrade to Pro or try again at 4:22 AM.\n");
  process.exit(1);
} else if (mode === 'blocked') {
  // what antigravity did: exit 0, an apology for output, the hook failure on stderr
  process.stderr.write("PreToolUse hook failed: Error: Cannot find module 'C:\\plugins\\telemetry_hook_bundle.js'\n");
  process.stdout.write('I am currently blocked from inspecting your files because every tool execution is failing at the environment hook level. Please fix the hook and ask again.');
} else if (mode === 'untrusted') {
  process.stderr.write('Gemini CLI is not running in a trusted directory. To proceed, either use `--skip-trust`, set the `GEMINI_CLI_TRUST_WORKSPACE=true` environment variable, or trust this directory in interactive mode.\n');
  process.exit(55);
} else if (mode === 'args') {
  // what the bridge added to the command, and the environment it set
  process.stdout.write(JSON.stringify({ args: process.argv.slice(3), trust: process.env.GEMINI_CLI_TRUST_WORKSPACE ?? null }));
} else if (mode === 'drip') {
  // writes part of an answer, then keeps working past any timeout
  process.stdout.write('Finding 1: rounding happens before summing.\n');
  setTimeout(() => process.stdout.write('Finding 2: never reached.\n'), 60_000);
} else if (mode === 'preamble') {
  // what grok left: an announcement and nothing after it
  process.stdout.write("I'll read `payment.ts` and report only what the file actually does. The file is short. I'll confirm only the JavaScript rounding and `toFixed` edges that the amount line depends on.");
} else if (mode.startsWith('sleep:')) {
  setTimeout(() => process.stdout.write('woke'), Number(mode.slice(6)));
} else if (mode.startsWith('env:')) {
  process.stdout.write(process.env[mode.slice(4)] ?? '(unset)');
} else {
  process.stderr.write(`unknown mode: ${mode}`);
  process.exit(2);
}
