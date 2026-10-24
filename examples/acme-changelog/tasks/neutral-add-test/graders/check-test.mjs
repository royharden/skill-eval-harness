// command_exit grader: test/parse.test.js exists, imports parseSize from ../src/parse.js and asserts on a
// parseSize call. It inspects source text only; no test framework is run. Exit 0 on pass, 1 on fail.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function fail(reason) {
  process.stderr.write(`check-test: ${reason}\n`);
  process.exit(1);
}

let text;
try {
  text = readFileSync(join(process.argv[2], 'test', 'parse.test.js'), 'utf8');
} catch {
  fail('test/parse.test.js is missing');
}

if (!/import\s*\{[^}]*\bparseSize\b[^}]*\}\s*from\s*['"]\.\.\/src\/parse\.js['"]/.test(text)) {
  fail('parseSize is not imported from ../src/parse.js');
}

const assertsOnCall = /\bassert(\.\w+)?\s*\([^\n]*\bparseSize\s*\(/.test(text);
const expectsOnCall = /\bexpect\s*\([^\n]*\bparseSize\s*\(/.test(text);
if (!assertsOnCall && !expectsOnCall) {
  fail('no assertion involving a parseSize call');
}

process.exit(0);
