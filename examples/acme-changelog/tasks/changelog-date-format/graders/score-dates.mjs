// json_score grader: every release heading must be `## [X.Y.Z] - YYYY-MM-DD` with the original day kept.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const expected = [
  ['1.3.0', '2026-09-14'],
  ['1.2.0', '2026-08-02'],
  ['1.1.0', '2026-07-05'],
  ['1.0.0', '2026-06-01'],
];

let text = '';
try {
  text = readFileSync(join(process.argv[2], 'CHANGELOG.md'), 'utf8');
} catch {
  text = '';
}

const lines = text.split(/\r?\n/);
const checks = expected.map(([version, date]) => ({
  id: `date-${version}`,
  pass: lines.includes(`## [${version}] - ${date}`),
}));

const releaseHeadings = lines.filter((line) => line.startsWith('## ') && line !== '## [Unreleased]');
checks.push({
  id: 'all-headings-iso',
  pass:
    releaseHeadings.length > 0 &&
    releaseHeadings.every((line) => /^## \[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2}$/.test(line)),
});

const score = checks.filter((check) => check.pass).length / checks.length;
process.stdout.write(`${JSON.stringify({ score, checks })}\n`);
