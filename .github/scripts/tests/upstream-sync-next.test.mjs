import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture, lines } from './upstream-sync-fixture.mjs';
import { computeNext, formatNext, branchName } from '../upstream-sync/commands/next.mjs';
import { classifyFile, splitConflicts, onlyLockfileConflicts } from '../upstream-sync/lib/mechanical.mjs';
import { countMarkerLines } from '../upstream-sync/lib/structural.mjs';
import { parseArgs } from '../upstream-sync/lib/args.mjs';
import { mergeTree } from '../upstream-sync/lib/git.mjs';

const NO_FETCH = { fetch: false };

test('next walks the clean stretch and names the commit that conflicts next', () => {
  const { fx, upstreamShas } = Fixture.scenario({
    base: { 'a.txt': 'one\ntwo\nthree\n', 'pnpm-lock.yaml': 'lock v1\n' },
    fork: [[{ 'a.txt': 'one\nFORK\nthree\n' }, 'fork edit']],
    upstream: [
      [{ 'new.txt': 'hello\n' }, 'add new file (#1)'],
      [{ 'b.txt': 'b\n' }, 'add b (#2)'],
      [{ 'a.txt': 'one\nUPSTREAM\nthree\n' }, 'edit a (#3)'],
      [{ 'c.txt': 'c\n' }, 'add c (#4)'],
    ],
  });
  try {
    const report = computeNext(fx.dir, NO_FETCH);
    assert.equal(report.kind, 'clean-stretch');
    assert.equal(report.behind, 4);
    assert.equal(report.stretch.count, 2);
    assert.equal(report.stretch.limitedBy, 'conflict');
    assert.deepEqual(report.stretch.steps.map((s) => s.pr), [1, 2]);
    assert.equal(report.branch, branchName(upstreamShas[1]));
    assert.equal(report.next.sha, upstreamShas[2]);
    assert.equal(report.next.pr, 3);
    assert.equal(report.next.action, 'start-conflict');
    assert.equal(report.next.structural.structural, false);
    assert.deepEqual(report.next.files.map((f) => [f.path, f.kind]), [['a.txt', 'real']]);
    assert.match(formatNext(report), /merge-clean/);
    assert.match(formatNext(report), /conflict at/);
  } finally {
    fx.cleanup();
  }
});

test('next reports a conflict with no clean stretch when the first commit conflicts', () => {
  const { fx, upstreamShas } = Fixture.scenario({
    base: { 'a.txt': 'one\ntwo\nthree\n' },
    fork: [[{ 'a.txt': 'one\nFORK\nthree\n' }, 'fork edit']],
    upstream: [[{ 'a.txt': 'one\nUP\nthree\n' }, 'edit a (#7)']],
  });
  try {
    const report = computeNext(fx.dir, NO_FETCH);
    assert.equal(report.kind, 'conflict');
    assert.equal(report.stretch, null);
    assert.equal(report.branch, branchName(upstreamShas[0]));
  } finally {
    fx.cleanup();
  }
});

test('a step whose only conflict is a lockfile counts as clean and keeps the fork lockfile', () => {
  const { fx, upstreamShas } = Fixture.scenario({
    base: { 'pnpm-lock.yaml': 'lock base\n', 'x.txt': 'x\n' },
    fork: [[{ 'pnpm-lock.yaml': 'lock fork\n' }, 'fork lock']],
    upstream: [
      [{ 'pnpm-lock.yaml': 'lock upstream\n', 'x.txt': 'x2\n' }, 'bump dep (#5)'],
      [{ 'y.txt': 'y\n' }, 'add y (#6)'],
    ],
  });
  try {
    const report = computeNext(fx.dir, NO_FETCH);
    assert.equal(report.kind, 'clean-stretch');
    assert.equal(report.stretch.count, 2);
    assert.equal(report.next, null);
    assert.equal(report.stretch.limitedBy, 'end');
    assert.equal(fx.git('show', `${report.stretch.result}:pnpm-lock.yaml`), 'lock fork');
    assert.equal(fx.git('show', `${report.stretch.result}:x.txt`), 'x2');
    assert.equal(report.branch, branchName(upstreamShas[1]));
  } finally {
    fx.cleanup();
  }
});

test('a lockfile change from upstream never reaches the merged tree', () => {
  const { fx } = Fixture.scenario({
    base: { 'pnpm-lock.yaml': 'lock base\n' },
    upstream: [[{ 'pnpm-lock.yaml': 'lock upstream\n', 'z.txt': 'z\n' }, 'bump (#8)']],
  });
  try {
    const report = computeNext(fx.dir, NO_FETCH);
    assert.equal(fx.git('show', `${report.stretch.result}:pnpm-lock.yaml`), 'lock base');
    assert.equal(fx.git('show', `${report.stretch.result}:z.txt`), 'z');
  } finally {
    fx.cleanup();
  }
});

test('next stops the stretch at --max-steps', () => {
  const { fx } = Fixture.scenario({
    base: { 'a.txt': 'a\n' },
    upstream: [[{ 'b.txt': '1\n' }, 'b (#1)'], [{ 'c.txt': '1\n' }, 'c (#2)'], [{ 'd.txt': '1\n' }, 'd (#3)']],
  });
  try {
    const report = computeNext(fx.dir, { ...NO_FETCH, maxSteps: 2 });
    assert.equal(report.stretch.count, 2);
    assert.equal(report.stretch.limitedBy, 'limit');
    assert.equal(report.behind, 3);
  } finally {
    fx.cleanup();
  }
});

test('next says up to date when upstream has nothing new', () => {
  const { fx } = Fixture.scenario({ base: { 'a.txt': 'a\n' }, fork: [[{ 'b.txt': 'b\n' }, 'fork only']] });
  try {
    const report = computeNext(fx.dir, NO_FETCH);
    assert.equal(report.kind, 'up-to-date');
    assert.match(formatNext(report), /up to date/);
  } finally {
    fx.cleanup();
  }
});

test('next flags a module extraction as a structural step', () => {
  const big = lines(400, 'code');
  const forked = big
    .split('\n')
    .map((l, i) => (i >= 20 && i < 170 ? `${l} // hardened by fork` : l))
    .join('\n');
  const remainder = lines(50, 'rest');
  const { fx, upstreamShas } = Fixture.scenario({
    base: { 'big.ts': big },
    fork: [[{ 'big.ts': forked }, 'fork hardening']],
    upstream: [[{ 'big.ts': remainder, 'extracted.ts': big.split('\n').slice(0, 350).join('\n') + '\n' }, 'refactor: extract module (#9)']],
  });
  try {
    const report = computeNext(fx.dir, NO_FETCH);
    assert.equal(report.kind, 'structural-conflict');
    assert.equal(report.next.sha, upstreamShas[0]);
    assert.equal(report.next.action, 'split-structural');
    assert.equal(report.next.structural.extractions[0].file, 'big.ts');
    assert.match(formatNext(report), /STRUCTURAL STEP/);
    assert.match(formatNext(report), /stacked, split PRs/);
  } finally {
    fx.cleanup();
  }
});

test('a small conflict is not structural', () => {
  const { fx } = Fixture.scenario({
    base: { 'a.ts': lines(30) },
    fork: [[{ 'a.ts': lines(30).replace('line 5', 'FORK 5') }, 'fork']],
    upstream: [[{ 'a.ts': lines(30).replace('line 5', 'UP 5') }, 'up (#1)']],
  });
  try {
    const report = computeNext(fx.dir, NO_FETCH);
    assert.equal(report.next.structural.structural, false);
    assert.equal(report.next.structural.markerLines, 5);
  } finally {
    fx.cleanup();
  }
});

test('mergeTree lists conflicted files and yields a marker tree', () => {
  const { fx, forkShas, upstreamShas } = Fixture.scenario({
    base: { 'a.txt': 'one\ntwo\n', 'b.txt': 'b\n' },
    fork: [[{ 'a.txt': 'one\nF\n' }, 'f']],
    upstream: [[{ 'a.txt': 'one\nU\n', 'b.txt': 'b2\n' }, 'u']],
  });
  try {
    const merged = mergeTree(fx.dir, forkShas[0], upstreamShas[0]);
    assert.equal(merged.clean, false);
    assert.deepEqual(merged.files, ['a.txt']);
    assert.match(fx.git('show', `${merged.tree}:a.txt`), /<<<<<<< /);
    assert.equal(fx.git('show', `${merged.tree}:b.txt`), 'b2');
  } finally {
    fx.cleanup();
  }
});

test('classifyFile separates mechanical files from real ones', () => {
  const cases = [
    ['pnpm-lock.yaml', 'lockfile'],
    ['tools/upstream-sync/package-lock.json', 'lockfile'],
    ['packages/db/src/migrations/0389_workflows.sql', 'migration-sql'],
    ['packages/db/src/migrations/meta/_journal.json', 'migration-journal'],
    ['packages/db/src/migrations/meta/0389_snapshot.json', 'migration-snapshot'],
    ['packages/shared/src/app-definitions.generated.ts', 'generated:app-definitions'],
    ['packages/paperclip-runner/src/drivers/acpx/generated-profiles.ts', 'generated:acpx-profiles'],
    ['packages/paperclip-runner/test/fixtures/copilot-profile-v56-identity.json', 'generated:copilot-profile-identity'],
    ['packages/paperclip-runner/generated/capability/capabilities.yaml', 'generated:capability-contract'],
    ['packages/paperclip-runner/generated/semantic-action-catalog.json', 'generated:semantic-action-catalog'],
    ['packages/somewhere/src/thing.generated.ts', 'generated:unregistered'],
  ];
  for (const [path, rule] of cases) {
    const c = classifyFile(path);
    assert.equal(c.kind, 'mechanical', path);
    assert.equal(c.rule, rule, path);
  }
  for (const path of ['server/src/services/tool-access.ts', 'packages/paperclip-runner/acpx-profiles.json', 'README.md']) {
    assert.equal(classifyFile(path).kind, 'real', path);
  }
  const split = splitConflicts(['pnpm-lock.yaml', 'a.ts']);
  assert.equal(split.mechanical.length, 1);
  assert.equal(split.real.length, 1);
  assert.equal(onlyLockfileConflicts(['pnpm-lock.yaml']), true);
  assert.equal(onlyLockfileConflicts(['pnpm-lock.yaml', 'a.ts']), false);
  assert.equal(onlyLockfileConflicts([]), false);
});

test('countMarkerLines counts every line from <<<<<<< to >>>>>>>', () => {
  const text = 'x\n<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\ny\n';
  assert.equal(countMarkerLines(text), 5);
  assert.equal(countMarkerLines('no markers\n'), 0);
});

test('parseArgs handles flags, values and --no- forms', () => {
  const { opts, rest } = parseArgs(['--json', '--no-fetch', '--max-steps', '3', '--master=origin/x', 'pos'], {
    boolean: ['json', 'fetch'],
    number: ['maxSteps'],
  });
  assert.deepEqual(opts, { json: true, fetch: false, maxSteps: 3, master: 'origin/x' });
  assert.deepEqual(rest, ['pos']);
  assert.throws(() => parseArgs(['--max-steps', 'x'], { number: ['maxSteps'] }), /number/);
});
