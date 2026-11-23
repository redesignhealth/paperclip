import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { Fixture } from './upstream-sync-fixture.mjs';
import { run } from '../upstream-sync/commands/merge-clean.mjs';
import { buildCleanStretchBody, buildCleanStretchTitle, formatConflictLog, parseConflictLog } from '../upstream-sync/lib/prbody.mjs';
import { checkTemplate } from '../check-pr-template.mjs';

const sink = () => {
  const chunks = [];
  const stream = new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } });
  return { stream, text: () => chunks.join('') };
};
const ARGS = ['--no-fetch', '--no-push', '--typecheck-cmd', 'true', '--build-cmd', 'true', '--json'];
const nodeTest = (ok) =>
  `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('t', () => { assert.ok(${ok}); });\n`;

test('merge-clean merges the clean stretch onto a factory/upstream-sync branch and restores the checkout', async () => {
  const { fx, upstreamShas, forkShas } = Fixture.scenario({
    base: { 'a.txt': 'a\n', 'pnpm-lock.yaml': 'lock fork\n' },
    fork: [[{ 'f.txt': 'f\n' }, 'fork work']],
    upstream: [
      [{ 'u1.txt': '1\n', 'pnpm-lock.yaml': 'lock upstream\n' }, 'one (#1)'],
      [{ 'u2.test.mjs': nodeTest('true') }, 'two (#2)'],
      [{ 'a.txt': 'conflict up\n' }, 'three (#3)'],
    ],
  });
  try {
    // make the third upstream commit conflict with a fork edit
    fx.commit({ 'a.txt': 'conflict fork\n' }, 'fork edits a');
    fx.git('update-ref', 'refs/remotes/origin/master', fx.git('rev-parse', 'master'));
    const out = sink();
    const code = await run(ARGS, { cwd: fx.dir, stdout: out.stream });
    assert.equal(code, 0);
    const result = JSON.parse(out.text());
    assert.equal(result.kind, 'merged');
    assert.deepEqual(result.merged.map((m) => m.pr), [1, 2]);
    assert.equal(result.branch, `factory/upstream-sync/${upstreamShas[1]}`);
    assert.equal(fx.git('rev-parse', '--abbrev-ref', 'HEAD'), 'master');
    assert.equal(fx.git('show', `${result.branch}:pnpm-lock.yaml`), 'lock fork');
    assert.equal(fx.git('show', `${result.branch}:u1.txt`), '1');
    assert.equal(fx.git('rev-list', '--count', '--merges', `master..${result.branch}`), '2');
    assert.ok(forkShas.length);
  } finally {
    fx.cleanup();
  }
});

test('merge-clean stops the stretch before a commit that merges clean but fails its checks', async () => {
  const { fx, upstreamShas } = Fixture.scenario({
    base: { 'a.txt': 'a\n' },
    upstream: [
      [{ 'good.test.mjs': nodeTest('true') }, 'good (#1)'],
      [{ 'bad.test.mjs': nodeTest('false') }, 'bad (#2)'],
    ],
  });
  try {
    const out = sink();
    const code = await run(ARGS, { cwd: fx.dir, stdout: out.stream });
    assert.equal(code, 0);
    const result = JSON.parse(out.text());
    assert.deepEqual(result.merged.map((m) => m.pr), [1]);
    assert.equal(result.failedStep.sha, upstreamShas[1]);
    assert.equal(result.branch, `factory/upstream-sync/${upstreamShas[0]}`);
  } finally {
    fx.cleanup();
  }
});

test('merge-clean reports blocked (exit 5) and makes no branch when the first commit fails its checks', async () => {
  const { fx } = Fixture.scenario({
    base: { 'a.txt': 'a\n' },
    upstream: [[{ 'bad.test.mjs': nodeTest('false') }, 'bad (#1)']],
  });
  try {
    const out = sink();
    const code = await run(ARGS, { cwd: fx.dir, stdout: out.stream });
    assert.equal(code, 5);
    assert.equal(JSON.parse(out.text()).kind, 'blocked');
    assert.equal(fx.git('branch', '--list', 'factory/*'), '');
  } finally {
    fx.cleanup();
  }
});

test('merge-clean has nothing to do when the first commit conflicts', async () => {
  const { fx } = Fixture.scenario({
    base: { 'a.txt': 'a\n' },
    fork: [[{ 'a.txt': 'fork\n' }, 'fork']],
    upstream: [[{ 'a.txt': 'up\n' }, 'up (#1)']],
  });
  try {
    const out = sink();
    assert.equal(await run(ARGS, { cwd: fx.dir, stdout: out.stream }), 0);
    assert.deepEqual(JSON.parse(out.text()).merged, []);
  } finally {
    fx.cleanup();
  }
});

test('merge-clean refuses a dirty work tree', async () => {
  const { fx } = Fixture.scenario({ base: { 'a.txt': 'a\n' }, upstream: [[{ 'b.txt': 'b\n' }, 'b (#1)']] });
  try {
    fx.write('a.txt', 'dirty\n');
    await assert.rejects(run(ARGS, { cwd: fx.dir, stdout: sink().stream }), /uncommitted/);
  } finally {
    fx.cleanup();
  }
});

test('the conflict log round-trips and the sync PR body satisfies the PR template check', () => {
  const entries = [
    { path: 'pnpm-lock.yaml', kind: 'mechanical', rule: 'lockfile', resolution: "kept the fork's copy" },
    { path: 'server/a.ts', kind: 'real', resolution: 'resolved' },
  ];
  assert.deepEqual(parseConflictLog(formatConflictLog(entries)), entries);
  assert.deepEqual(parseConflictLog(formatConflictLog([])), []);
  assert.equal(parseConflictLog('no log here'), null);

  const steps = [
    { sha: 'a'.repeat(40), pr: 1, subject: 'one (#1)' },
    { sha: 'b'.repeat(40), pr: 2, subject: 'two (#2)' },
  ];
  const body = buildCleanStretchBody({ steps, base: 'c'.repeat(40), conflictEntries: entries });
  const checked = checkTemplate(body);
  assert.equal(checked.passed, true, JSON.stringify(checked.failures));
  assert.deepEqual(parseConflictLog(body), entries);
  assert.match(buildCleanStretchTitle(steps), /^chore\(upstream-sync\): merge 2 upstream commit/);
});
