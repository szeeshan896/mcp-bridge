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
} else if (mode.startsWith('env:')) {
  process.stdout.write(process.env[mode.slice(4)] ?? '(unset)');
} else {
  process.stderr.write(`unknown mode: ${mode}`);
  process.exit(2);
}
