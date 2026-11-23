import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './upstream-sync-fixture.mjs';
import { startConflict, regenerate } from '../upstream-sync/commands/start-conflict.mjs';
import { gatherContext, oursBlocks, locateOurs, formatContext } from '../upstream-sync/commands/context.mjs';
import { planRenumber, mergeJournal } from '../upstream-sync/lib/migrations.mjs';
import { conflictLogFor } from '../upstream-sync/lib/conflictlog.mjs';

const MIG = 'packages/db/src/migrations';
const journal = (...tags) =>
  JSON.stringify({ version: '7', dialect: 'postgresql', entries: tags.map((tag, idx) => ({ idx, version: '7', when: 1000 + idx, tag, breakpoints: true })) }, null, 2) + '\n';
const NO_NET = { fetch: false, gh: false };

function migrationScenario() {
  return Fixture.scenario({
    base: {
      [`${MIG}/0000_init.sql`]: 'create table a();\n',
      [`${MIG}/meta/_journal.json`]: journal('0000_init'),
      [`${MIG}/meta/0000_snapshot.json`]: '{"id":"base"}\n',
      'pnpm-lock.yaml': 'lock base\n',
      'server/real.ts': 'one\ntwo\nthree\n',
    },
    fork: [
      [
        {
          [`${MIG}/0001_fork_table.sql`]: 'create table fork();\n',
          [`${MIG}/meta/_journal.json`]: journal('0000_init', '0001_fork_table'),
          [`${MIG}/meta/0001_snapshot.json`]: '{"id":"fork"}\n',
          'pnpm-lock.yaml': 'lock fork\n',
          'server/real.ts': 'one\nFORK TWO (TECH-1234)\nthree\n',
        },
        'fork: add table and harden real.ts (TECH-1234)',
      ],
    ],
    upstream: [
      [
        {
          [`${MIG}/0001_up_table.sql`]: 'create table up();\n',
          [`${MIG}/meta/_journal.json`]: journal('0000_init', '0001_up_table'),
          [`${MIG}/meta/0001_snapshot.json`]: '{"id":"up"}\n',
          'pnpm-lock.yaml': 'lock upstream\n',
          'server/real.ts': 'one\nUP TWO\nthree\n',
        },
        'feat: up table (#42)',
      ],
    ],
  });
}

test('start-conflict settles lockfile and migrations and leaves only the real conflict', async () => {
  const { fx, upstreamShas } = migrationScenario();
  try {
    const result = await startConflict(fx.dir, { ...NO_NET, commit: false }, undefined);
    assert.equal(result.kind, 'real-conflicts');
    assert.deepEqual(result.real, ['server/real.ts']);
    assert.equal(result.branch, `factory/upstream-sync/${upstreamShas[0]}`);
    assert.equal(fx.git('diff', '--name-only', '--diff-filter=U'), 'server/real.ts');
    // lockfile: the fork's copy
    assert.equal(fx.read('pnpm-lock.yaml'), 'lock fork\n');
    // migrations: the fork's 0001 stays, upstream's is renumbered to 0002
    assert.ok(fx.exists(`${MIG}/0001_fork_table.sql`));
    assert.ok(fx.exists(`${MIG}/0002_up_table.sql`));
    assert.ok(!fx.exists(`${MIG}/0001_up_table.sql`));
    const j = JSON.parse(fx.read(`${MIG}/meta/_journal.json`));
    assert.deepEqual(j.entries.map((e) => [e.idx, e.tag]), [[0, '0000_init'], [1, '0001_fork_table'], [2, '0002_up_table']]);
    assert.ok(j.entries[2].when > j.entries[1].when);
    // snapshots: the fork's stay, upstream's newest moves to the new number
    assert.equal(fx.read(`${MIG}/meta/0001_snapshot.json`), '{"id":"fork"}\n');
    assert.equal(fx.read(`${MIG}/meta/0002_snapshot.json`), '{"id":"up"}\n');
    assert.ok(result.settled.some((s) => s.action.startsWith('renumbered 0001_up_table.sql -> 0002_up_table.sql')));
  } finally {
    fx.cleanup();
  }
});

test('start-conflict commits the merge when every conflict is mechanical', async () => {
  const { fx, upstreamShas } = Fixture.scenario({
    base: { 'pnpm-lock.yaml': 'lock base\n', 'a.txt': 'a\n' },
    fork: [[{ 'pnpm-lock.yaml': 'lock fork\n' }, 'fork lock']],
    upstream: [[{ 'pnpm-lock.yaml': 'lock upstream\n', 'new.txt': 'n\n' }, 'bump (#7)']],
  });
  try {
    const result = await startConflict(fx.dir, NO_NET, upstreamShas[0]);
    assert.equal(result.kind, 'committed');
    assert.deepEqual(result.real, []);
    assert.equal(fx.git('show', 'HEAD:pnpm-lock.yaml'), 'lock fork');
    assert.equal(fx.git('show', 'HEAD:new.txt'), 'n');
    assert.equal(fx.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3); // a merge commit
  } finally {
    fx.cleanup();
  }
});

test('start-conflict refuses a commit that is not the next one, and a clean one without --allow-clean', async () => {
  const { fx, upstreamShas } = Fixture.scenario({
    base: { 'a.txt': 'a\n' },
    upstream: [[{ 'b.txt': 'b\n' }, 'b (#1)'], [{ 'c.txt': 'c\n' }, 'c (#2)']],
  });
  try {
    await assert.rejects(startConflict(fx.dir, NO_NET, upstreamShas[1]), /not the next upstream commit/);
    await assert.rejects(startConflict(fx.dir, NO_NET, upstreamShas[0]), /merges cleanly/);
    assert.equal(fx.git('rev-parse', '--abbrev-ref', 'HEAD'), 'master'); // the failed start left the checkout alone
    const forced = await startConflict(fx.dir, { ...NO_NET, allowClean: true }, upstreamShas[0]);
    assert.equal(forced.kind, 'committed');
  } finally {
    fx.cleanup();
  }
});

test('regenerate writes the generated file with its generator and stages it, and not untracked scratch files', () => {
  const gen = 'scripts/ingest-app-definitions.mjs';
  const out = 'packages/shared/src/app-definitions.generated.ts';
  const { fx } = Fixture.scenario({
    base: {
      [gen]: "import { writeFileSync } from 'node:fs';\nwriteFileSync('packages/shared/src/app-definitions.generated.ts', 'fresh\\n');\n",
      [out]: 'old\n',
      'packages/shared/src/app-definitions/a.json': '{}\n',
    },
    upstream: [[{ 'packages/shared/src/app-definitions/b.json': '{}\n', [out]: 'upstream hand edit\n' }, 'add app (#1)']],
  });
  try {
    fx.git('merge', '-q', '--no-commit', '--no-ff', 'upstream');
    fx.write('scratch.log', 'noise\n');
    const outcome = regenerate(fx.dir, { buildCmd: 'true' }, 'origin/master');
    assert.equal(outcome.ok, true, outcome.problems.join('\n'));
    assert.deepEqual(outcome.generators, ['app-definitions']);
    assert.equal(fx.read(out), 'fresh\n');
    assert.match(fx.git('diff', '--cached', '--name-only'), /app-definitions\.generated\.ts/);
    assert.ok(!fx.git('diff', '--cached', '--name-only').includes('scratch.log'));
  } finally {
    fx.cleanup();
  }
});

test('planRenumber and mergeJournal', () => {
  assert.deepEqual(planRenumber(['0000_a.sql', '0001_b.sql'], ['0001_c.sql', '0002_d.sql']), [
    { from: '0001_c.sql', to: '0002_c.sql' },
    { from: '0002_d.sql', to: '0003_d.sql' },
  ]);
  assert.deepEqual(planRenumber(['0000_a.sql'], ['0005_x.sql']), [{ from: '0005_x.sql', to: '0005_x.sql' }]);
  const merged = JSON.parse(mergeJournal(journal('0000_a', '0001_b'), journal('0000_a', '0001_c'), [{ from: '0001_c.sql', to: '0002_c.sql' }]));
  assert.deepEqual(merged.entries.map((e) => e.tag), ['0000_a', '0001_b', '0002_c']);
  assert.equal(merged.entries[2].idx, 2);
  // the real journal skips numbers: the new idx continues from the highest idx, not from the entry count
  const gapped = JSON.stringify({ version: '7', dialect: 'postgresql', entries: [{ idx: 0, tag: '0000_a', when: 1 }, { idx: 5, tag: '0005_b', when: 2 }, { idx: 6, tag: '0006_c', when: 3 }] });
  const withGap = JSON.parse(mergeJournal(gapped, journal('0000_a', '0001_x'), [{ from: '0001_x.sql', to: '0007_x.sql' }]));
  assert.deepEqual(withGap.entries.map((e) => e.idx), [0, 5, 6, 7]);
});

test('context lists the upstream commit, our commits and tickets on the conflicting lines, and settled files', () => {
  const { fx, upstreamShas } = migrationScenario();
  try {
    const c = gatherContext(fx.dir, NO_NET, undefined);
    assert.equal(c.sha, upstreamShas[0]);
    assert.equal(c.prNumber, 42);
    assert.deepEqual(c.files.map((f) => f.path), ['server/real.ts']);
    const ours = c.files[0].ours;
    assert.equal(ours.length, 1);
    assert.deepEqual(ours[0].ids, ['TECH-1234']);
    assert.ok(c.mechanical.some((m) => m.path === 'pnpm-lock.yaml'));
    const text = formatContext(c);
    assert.match(text, /TECH-1234/);
    assert.match(text, /settled by script/);
  } finally {
    fx.cleanup();
  }
});

test('oursBlocks reads the fork side of each conflict block, and locateOurs finds it in the fork file', () => {
  const text = 'a\n<<<<<<< ours\nx1\nx2\n=======\ny\n>>>>>>> theirs\nb\n<<<<<<< ours\nz\n||||||| base\nq\n=======\nw\n>>>>>>> theirs\n';
  assert.deepEqual(oursBlocks(text), [['x1', 'x2'], ['z']]);
  // the merged file has two extra upstream lines at the top, so its line numbers drift from the fork file's
  assert.deepEqual(locateOurs('a\nx1\nx2\nb\nz\n', oursBlocks(text)), [[2, 3], [5, 5]]);
  assert.deepEqual(locateOurs('a\n', [[]]), []);
});

test('context attributes the right fork commits even when upstream edits earlier lines cleanly', () => {
  const head = Array.from({ length: 5 }, (_, i) => `h${i}`).join('\n');
  const { fx } = Fixture.scenario({
    base: { 'f.ts': `${head}\nmid\ntail\n` },
    fork: [[{ 'f.ts': `${head}\nmid FORK\ntail\n` }, 'fork edits mid (TECH-777)']],
    upstream: [[{ 'f.ts': `new1\nnew2\nnew3\n${head}\nmid UP\ntail\n` }, 'up (#5)']],
  });
  try {
    const c = gatherContext(fx.dir, NO_NET, undefined);
    assert.deepEqual(c.files[0].ours.map((o) => o.ids), [['TECH-777']]);
  } finally {
    fx.cleanup();
  }
});

test('the conflict log is recomputed from git for a committed sync merge', async () => {
  const { fx } = migrationScenario();
  try {
    await startConflict(fx.dir, { ...NO_NET, commit: false }, undefined);
    fx.write('server/real.ts', 'one\nBOTH\nthree\n');
    fx.git('add', 'server/real.ts');
    fx.git('commit', '-q', '-m', 'Merge upstream');
    const log = conflictLogFor(fx.dir, 'origin/master', 'HEAD');
    const byPath = Object.fromEntries(log.map((e) => [e.path, e]));
    assert.equal(byPath['server/real.ts'].kind, 'real');
    assert.equal(byPath[`${MIG}/meta/_journal.json`].kind, 'mechanical');
    assert.equal(byPath['pnpm-lock.yaml'].rule, 'lockfile');
  } finally {
    fx.cleanup();
  }
});
