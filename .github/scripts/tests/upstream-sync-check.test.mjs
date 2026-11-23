import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './upstream-sync-fixture.mjs';
import { runCheck, formatCheck } from '../upstream-sync/commands/check.mjs';
import { convergentNumericEdits, parseHunks, isNumericBump } from '../upstream-sync/lib/convergent.mjs';
import { selectTests, siblingTests, vitestGroups } from '../upstream-sync/lib/testselect.mjs';

const nodeTest = (name, expr) =>
  `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('${name}', () => { assert.ok(${expr}); });\n`;

const OK = { typecheckCmd: 'true', buildCmd: 'true' };

function mergeUpstream(fx) {
  fx.git('checkout', '-q', 'master');
  fx.git('merge', '-q', '--no-ff', '-m', 'merge upstream', 'upstream');
}

test('check passes a clean step whose changed tests pass', () => {
  const { fx } = Fixture.scenario({
    base: { 'a.txt': 'a\n' },
    upstream: [[{ 'ok.test.mjs': nodeTest('ok', 'true') }, 'add passing test']],
  });
  try {
    mergeUpstream(fx);
    const result = runCheck(fx.dir, OK);
    assert.equal(result.ok, true, formatCheck(result));
    assert.deepEqual(result.tests.nodeTest, ['ok.test.mjs']);
  } finally {
    fx.cleanup();
  }
});

test('check fails a clean step whose changed test fails', () => {
  const { fx } = Fixture.scenario({
    base: { 'a.txt': 'a\n' },
    upstream: [[{ 'bad.test.mjs': nodeTest('bad', 'false') }, 'add failing test']],
  });
  try {
    mergeUpstream(fx);
    const result = runCheck(fx.dir, OK);
    assert.equal(result.ok, false);
    assert.equal(result.steps.find((s) => s.name === 'tests').status, 'fail');
  } finally {
    fx.cleanup();
  }
});

test('check catches the trial failure: both sides bump the same count, git merges clean, the answer is one higher', () => {
  const base = {
    'count.mjs': 'export const COUNT = 4;\n',
    'count.test.mjs':
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { COUNT } from './count.mjs';\ntest('count', () => { assert.equal(COUNT, 6); });\n",
  };
  const { fx } = Fixture.scenario({
    base,
    fork: [[{ 'count.mjs': 'export const COUNT = 5;\n' }, 'fork adds an app']],
    upstream: [[{ 'count.mjs': 'export const COUNT = 5;\n' }, 'upstream adds an app']],
  });
  try {
    mergeUpstream(fx);
    assert.equal(fx.read('count.mjs'), 'export const COUNT = 5;\n'); // git merged it clean, and wrong
    const result = runCheck(fx.dir, OK);
    assert.equal(result.risks.length, 1);
    assert.match(result.risks[0], /count\.mjs:1.*"export const COUNT = 4;" -> "export const COUNT = 5;"/);
    assert.deepEqual(result.tests.nodeTest, ['count.test.mjs']); // the sibling test was forced in
    assert.equal(result.ok, false, formatCheck(result));
  } finally {
    fx.cleanup();
  }
});

test('different numeric edits on the two sides are not flagged as convergent', () => {
  const { fx, forkShas, upstreamShas } = Fixture.scenario({
    base: { 'n.txt': 'one\nlimit 3\ntwo\nthree\nfour\nfive\nsix\nlimit 9\n' },
    fork: [[{ 'n.txt': 'one\nlimit 4\ntwo\nthree\nfour\nfive\nsix\nlimit 9\n' }, 'fork']],
    upstream: [[{ 'n.txt': 'one\nlimit 3\ntwo\nthree\nfour\nfive\nsix\nlimit 10\n' }, 'up']],
  });
  try {
    mergeUpstream(fx);
    assert.deepEqual(convergentNumericEdits(fx.dir, 'HEAD'), []);
    assert.ok(forkShas.length && upstreamShas.length);
  } finally {
    fx.cleanup();
  }
});

test('check fails when the lockfile differs from master', () => {
  const { fx } = Fixture.scenario({
    base: { 'pnpm-lock.yaml': 'lock\n', 'a.txt': 'a\n' },
    upstream: [[{ 'b.txt': 'b\n' }, 'add b']],
  });
  try {
    mergeUpstream(fx);
    fx.commit({ 'pnpm-lock.yaml': 'edited\n' }, 'edit lockfile');
    const result = runCheck(fx.dir, { ...OK, since: 'origin/master' });
    assert.equal(result.steps.find((s) => s.name === 'lockfile').status, 'fail');
    assert.equal(result.ok, false);
  } finally {
    fx.cleanup();
  }
});

test('check refuses a dirty work tree', () => {
  const { fx } = Fixture.scenario({ base: { 'a.txt': 'a\n' }, fork: [[{ 'b.txt': 'b\n' }, 'b']] });
  try {
    fx.write('a.txt', 'changed\n');
    const result = runCheck(fx.dir, OK);
    assert.equal(result.ok, false);
    assert.equal(result.steps[0].name, 'worktree');
  } finally {
    fx.cleanup();
  }
});

test('check fails when an affected generator output differs from the committed file, and leaves the tree as found', () => {
  const gen = 'packages/paperclip-runner/scripts/generate-acpx-profiles.mjs';
  const out = 'packages/paperclip-runner/src/drivers/acpx/generated-profiles.ts';
  const { fx } = Fixture.scenario({
    base: { [gen]: "import { writeFileSync } from 'node:fs';\nwriteFileSync('src/drivers/acpx/generated-profiles.ts', 'fresh\\n');\n", [out]: 'hand edited\n', 'a.txt': 'a\n' },
    upstream: [[{ [out]: 'hand edited again\n' }, 'touch generated']],
  });
  try {
    mergeUpstream(fx);
    const result = runCheck(fx.dir, OK);
    const generated = result.steps.find((s) => s.name === 'generated');
    assert.equal(generated.status, 'fail');
    assert.match(generated.detail, /stale generated file packages\/paperclip-runner\/src\/drivers\/acpx\/generated-profiles\.ts/);
    assert.equal(fx.git('status', '--porcelain', '--untracked-files=no'), '');
  } finally {
    fx.cleanup();
  }
});

test('parseHunks and isNumericBump', () => {
  const hunks = parseHunks('@@ -3 +3 @@\n-  expect(n).toBe(4);\n+  expect(n).toBe(5);\n@@ -9 +9 @@\n-foo\n+bar\n');
  assert.equal(hunks.length, 2);
  assert.equal(isNumericBump(hunks[0]), true);
  assert.equal(isNumericBump(hunks[1]), false);
});

test('selectTests picks changed tests, sibling tests of changed sources, and splits node:test files', () => {
  const fx = new Fixture();
  try {
    fx.commit(
      {
        'src/a.ts': 'export const a = 1;\n',
        'src/a.test.ts': "import { it } from 'vitest';\n",
        'src/b.test.mjs': nodeTest('b', 'true'),
        'src/c.ts': 'x\n',
      },
      'files',
    );
    const picked = selectTests(fx.dir, ['src/a.ts', 'src/b.test.mjs', 'src/c.ts', 'README.md']);
    assert.deepEqual(picked.vitest, ['src/a.test.ts']);
    assert.deepEqual(picked.nodeTest, ['src/b.test.mjs']);
    assert.deepEqual(siblingTests('src/a.ts'), ['src/a.test.ts', 'src/a.spec.ts']);
    assert.deepEqual(siblingTests('src/a.test.ts'), []);
  } finally {
    fx.cleanup();
  }
});

test('check fails, never passes, when it cannot resolve what it must compare against', () => {
  const { fx } = Fixture.scenario({ base: { 'a.txt': 'a\n' }, fork: [[{ 'b.txt': 'b\n' }, 'b']] });
  try {
    const noMaster = runCheck(fx.dir, { ...OK, master: 'refs/remotes/nowhere/master' });
    assert.equal(noMaster.ok, false);
    assert.equal(noMaster.steps.find((s) => s.name === 'lockfile').status, 'fail');
    const noSince = runCheck(fx.dir, { ...OK, since: 'does-not-exist' });
    assert.equal(noSince.ok, false);
    assert.equal(noSince.steps[0].name, 'since');
  } finally {
    fx.cleanup();
  }
});

test('vitestGroups runs each file from the package that owns its vitest config', () => {
  const fx = new Fixture();
  try {
    fx.commit(
      {
        'vitest.config.ts': 'export default {};\n',
        'packages/runner/vitest.config.ts': 'export default {};\n',
        'packages/runner/src/a.test.ts': 'x\n',
        'packages/other/src/b.test.ts': 'x\n',
        'server/vitest.config.ts': 'export default {};\n',
        'server/src/c.test.ts': 'x\n',
      },
      'files',
    );
    const groups = vitestGroups(fx.dir, ['packages/runner/src/a.test.ts', 'packages/other/src/b.test.ts', 'server/src/c.test.ts']);
    assert.deepEqual([...groups.entries()].sort(), [
      ['.', ['packages/other/src/b.test.ts']],
      ['packages/runner', ['src/a.test.ts']],
      ['server', ['src/c.test.ts']],
    ]);
  } finally {
    fx.cleanup();
  }
});
