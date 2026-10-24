// command_exit grader: the link definitions form one block at the bottom of CHANGELOG.md and are exactly the
// house compare links for 1.4.0, in heading order. Exit 0 on pass, 1 on fail.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const base = 'https://example.invalid/acme-widgets';
const required = [
  `[Unreleased]: ${base}/compare/v1.4.0...HEAD`,
  `[1.4.0]: ${base}/compare/v1.3.0...v1.4.0`,
  `[1.3.0]: ${base}/compare/v1.2.0...v1.3.0`,
  `[1.2.0]: ${base}/compare/v1.1.0...v1.2.0`,
];

function fail(reason) {
  process.stderr.write(`check-links: ${reason}\n`);
  process.exit(1);
}

let text;
try {
  text = readFileSync(join(process.argv[2], 'CHANGELOG.md'), 'utf8');
} catch {
  fail('CHANGELOG.md is missing');
}

const lines = text.split(/\r?\n/);
const isDefinition = (line) => /^\[[^\]]+\]: /.test(line);
const first = lines.findIndex(isDefinition);
if (first === -1) {
  fail('no link reference definitions');
}

const tail = lines.slice(first);
if (tail.some((line) => line !== '' && !isDefinition(line))) {
  fail('link reference definitions are not collected at the bottom');
}

const definitions = tail.filter(isDefinition);
if (definitions.join('\n') !== required.join('\n')) {
  fail('link reference definitions do not match the expected compare links');
}

process.exit(0);
