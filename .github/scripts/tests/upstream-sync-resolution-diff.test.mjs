import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Fixture } from './upstream-sync-fixture.mjs';
import { computeResolutionDiff } from '../upstream-sync/commands/resolution-diff.mjs';
import { LIMITS, buildResolutionDiff as buildResolutionDiffDirect } from '../upstream-sync/lib/resolutiondiff.mjs';
import { submit, judgeVerdict, NOTES_REF } from '../upstream-sync/commands/submit.mjs';

const CLI = fileURLToPath(new URL('../upstream-sync/cli.mjs', import.meta.url));

/** A sync branch: one real conflict resolved by hand, a lockfile conflict settled by script, then one fix commit. */
function syncBranch() {
  const s = Fixture.scenario({
    base: { 'server/real.ts': 'one\ntwo\nthree\n', 'pnpm-lock.yaml': 'lock base\n', 'x.txt': 'x\n' },
    fork: [[{ 'server/real.ts': 'one\nFORK\nthree\n', 'pnpm-lock.yaml': 'lock fork\n' }, 'fork']],
    upstream: [[{ 'server/real.ts': 'one\nUP\nthree\n', 'pnpm-lock.yaml': 'lock up\n', 'x.txt': 'x2\n' }, 'up (#1)']],
  });
  const { fx } = s;
  fx.git('checkout', '-q', '-b', 'sync', 'master');
  try {
    fx.git('merge', '--no-commit', '--no-ff', 'upstream');
  } catch {
    /* conflicts expected */
  }
  fx.write('server/real.ts', 'one\nFORK AND UP\nthree\n');
  fx.write('pnpm-lock.yaml', 'lock fork\n');
  fx.git('add', '-A');
  fx.git('commit', '-q', '-m', 'Merge upstream');
  fx.commit({ 'server/fix.ts': 'export const fix = 1;\n' }, 'fix: follow-up');
  return s;
}

test('the resolution diff holds our hand resolution and fix commit, and only a mechanical line for the lockfile', () => {
  const { fx } = syncBranch();
  try {
    const r = computeResolutionDiff(fx.dir, {});
    assert.equal(r.commits, 2);
    assert.match(r.document, /^format: upstream-sync-resolution-diff v1\nbase: [0-9a-f]{40}\nhead: [0-9a-f]{40}\n== commit [0-9a-f]{40} merge upstream [0-9a-f]{40} ==\n/);
    assert.match(r.document, /== commit [0-9a-f]{40} own ==/);
    assert.match(r.document, /\nmechanical lockfile pnpm-lock\.yaml [0-9a-f]{40}\n/);
    assert.ok(!r.document.includes('lock up'), 'lockfile content is not in the document');
    assert.match(r.document, /\n-<<<<<<< /); // the marker block we removed
    assert.match(r.document, /\n\+FORK AND UP\n/);
    assert.match(r.document, /\n\+export const fix = 1;\n/);
    assert.ok(!r.document.includes('x2'), 'clean upstream code is not part of our work');
    assert.equal(r.mechanical_files, 1);
    assert.match(r.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(r.within_limits, true);
  } finally {
    fx.cleanup();
  }
});

test('a clean merge contributes an empty section', () => {
  const { fx } = Fixture.scenario({ base: { 'a.txt': 'a\n' }, upstream: [[{ 'b.txt': 'b\n' }, 'b (#1)']] });
  try {
    fx.git('checkout', '-q', '-b', 'sync');
    fx.git('merge', '-q', '--no-ff', '-m', 'Merge upstream', 'upstream');
    const r = computeResolutionDiff(fx.dir, {});
    assert.equal(r.changed_lines, 0);
    assert.equal(r.files, 0);
    assert.ok(!r.document.includes('diff --git'));
  } finally {
    fx.cleanup();
  }
});

test('the digest is the same for the builder and for the gate running the script from another clone', () => {
  const { fx } = syncBranch();
  const dir = mkdtempSync(join(tmpdir(), 'upstream-sync-gate-'));
  try {
    const builder = computeResolutionDiff(fx.dir, {}).digest;
    execFileSync('git', ['clone', '-q', '--no-local', '--branch', 'sync', fx.dir, dir], { stdio: 'ignore' });
    const gate = execFileSync('node', [CLI, 'resolution-diff', '--digest'], { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: '' } }).trim();
    assert.equal(gate, builder);
    // and it changes when anything we wrote changes
    fx.commit({ 'server/fix.ts': 'export const fix = 2;\n' }, 'change the fix');
    assert.notEqual(computeResolutionDiff(fx.dir, {}).digest, builder);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    fx.cleanup();
  }
});

test('the --json output carries the numbers without the document', () => {
  const { fx } = syncBranch();
  try {
    const out = execFileSync('node', [CLI, 'resolution-diff', '--json'], { cwd: fx.dir, encoding: 'utf8' });
    const json = JSON.parse(out);
    assert.equal(json.format, 'upstream-sync-resolution-diff v1');
    assert.equal(json.document, undefined);
    assert.ok(json.changed_lines > 0 && json.chars > 0);
  } finally {
    fx.cleanup();
  }
});

const verdictFor = (r, over = {}) => ({
  review_id: 'r1', status: 'completed', verdict: 'APPROVE', head_sha: r.head, review_kind: 'supplied_diff', diff_digest: r.digest, findings: [], ...over,
});

test('judgeVerdict accepts only a verdict bound to this head, kind and digest', () => {
  const ctx = { head: 'h'.repeat(40), digest: 'sha256:abc' };
  const ok = { status: 'completed', verdict: 'APPROVE', head_sha: ctx.head, review_kind: 'supplied_diff', diff_digest: ctx.digest };
  assert.equal(judgeVerdict(ok, ctx).exit, 0);
  assert.equal(judgeVerdict({ ...ok, verdict: 'BLOCKING', findings: [{ severity: 'BLOCKING' }] }, ctx).exit, 1);
  assert.equal(judgeVerdict({ ...ok, head_sha: 'x' }, ctx).exit, 9);
  assert.equal(judgeVerdict({ ...ok, review_kind: undefined }, ctx).exit, 9);
  assert.equal(judgeVerdict({ ...ok, diff_digest: 'sha256:other' }, ctx).exit, 9);
  assert.equal(judgeVerdict({ ...ok, review_kind: undefined, diff_digest: undefined, status: 'halted', halt_reason: 'scope_split' }, ctx).exit, 7);
  assert.equal(judgeVerdict({ ...ok, review_kind: undefined, diff_digest: undefined, status: 'failed', error_class: 'timeout' }, ctx).exit, 8);
  assert.equal(judgeVerdict({ ...ok, status: 'halted', halt_reason: 'patch_apply_error' }, ctx).exit, 8);
  assert.equal(judgeVerdict({ ...ok, status: 'halted', halt_reason: 'budget' }, ctx).exit, 8);
  assert.equal(judgeVerdict({ ...ok, status: 'failed', error_class: 'timeout' }, ctx).exit, 8);
});

const writeVerdict = (fx, r, over = {}) => {
  const path = join(fx.dir, '..', `verdict-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(verdictFor(r, over)));
  return path;
};

test('submit writes the payload and awaits the review without using a round', async () => {
  const { fx } = syncBranch();
  try {
    const r = await submit(fx.dir, { repo: 'redesignhealth/paperclip', pr: 7 });
    assert.equal(r.exit, 10);
    assert.equal(r.round, 1);
    const payload = JSON.parse(execFileSync('cat', [r.payload], { encoding: 'utf8' }));
    assert.equal(payload.review_kind, 'supplied_diff');
    assert.equal(payload.head_sha, r.head);
    assert.equal(payload.diff_digest, r.digest);
    assert.equal(payload.pr, 7);
    assert.match(payload.diff, /^format: upstream-sync-resolution-diff v1/);
    assert.equal(fx.git('notes', `--ref=${NOTES_REF}`, 'list'), ''); // no verdict yet, so no round used
    // judging a verdict does not overwrite the payload that was sent
    const approve = writeVerdict(fx, r);
    const done = await submit(fx.dir, { verdict: approve });
    assert.equal(done.exit, 0);
    assert.equal(JSON.parse(execFileSync('cat', [r.payload], { encoding: 'utf8' })).pr, 7);
    assert.match(fx.git('notes', `--ref=${NOTES_REF}`, 'show', r.head), /"round":1/);
    // the same head and diff again is not a new round
    assert.equal((await submit(fx.dir, { verdict: approve })).round, 1);
    rmSync(approve, { force: true });
  } finally {
    fx.cleanup();
  }
});

test('submit counts a round only when a verdict arrives, and stops at the round cap', async () => {
  const { fx } = syncBranch();
  try {
    const first = await submit(fx.dir, { maxRounds: 2 });
    const v1 = writeVerdict(fx, first, { verdict: 'BLOCKING', findings: [{ severity: 'BLOCKING', summary: 'x' }] });
    assert.equal((await submit(fx.dir, { maxRounds: 2, verdict: v1 })).exit, 1);

    fx.commit({ 'server/fix.ts': 'export const fix = 2;\n' }, 'round two');
    const second = await submit(fx.dir, { maxRounds: 2 });
    assert.equal(second.round, 2);
    // a failed review does not use the round
    const failed = writeVerdict(fx, second, { status: 'failed', verdict: null, error_class: 'timeout', review_kind: undefined, diff_digest: undefined });
    assert.equal((await submit(fx.dir, { maxRounds: 2, verdict: failed })).exit, 8);
    assert.equal((await submit(fx.dir, { maxRounds: 2 })).round, 2);
    const v2 = writeVerdict(fx, second);
    assert.equal((await submit(fx.dir, { maxRounds: 2, verdict: v2 })).exit, 0);

    fx.commit({ 'server/fix.ts': 'export const fix = 3;\n' }, 'round three');
    const capped = await submit(fx.dir, { maxRounds: 2 });
    assert.equal(capped.exit, 4);
    assert.equal(capped.status, 'round-cap');
    [v1, failed, v2].forEach((f) => rmSync(f, { force: true }));
  } finally {
    fx.cleanup();
  }
});

test('submit runs --review-cmd with the payload path and judges its output', async () => {
  const { fx } = syncBranch();
  try {
    const r0 = computeResolutionDiff(fx.dir, {});
    const verdict = JSON.stringify(verdictFor(r0, { verdict: 'BLOCKING', findings: [{ severity: 'BLOCKING', file: 'a.ts', line: 3, summary: 'bad' }] }));
    const approvedCmd = `test -f "$UPSTREAM_SYNC_PAYLOAD" && printf '%s\\n' '${verdict}'`;
    const r = await submit(fx.dir, { reviewCmd: approvedCmd });
    assert.equal(r.exit, 1);
    assert.equal(r.findings.length, 1);
    const mismatch = await submit(fx.dir, { reviewCmd: `printf '%s\\n' '${JSON.stringify(verdictFor(r0, { diff_digest: 'sha256:zzz' }))}'` });
    assert.equal(mismatch.exit, 9);
  } finally {
    fx.cleanup();
  }
});

test('submit reports a split request when the diff is over the Argus limits, without sending anything', async () => {
  const { fx } = syncBranch();
  try {
    fx.commit({ 'server/huge.ts': Array.from({ length: LIMITS.changedLines + 10 }, (_, i) => `line ${i}`).join('\n') + '\n' }, 'huge');
    const r = await submit(fx.dir, {});
    assert.equal(r.exit, 7);
    assert.equal(r.split_request, true);
    assert.equal(fx.git('notes', `--ref=${NOTES_REF}`, 'list'), '');
  } finally {
    fx.cleanup();
  }
});

test('a failing git call stops the build instead of yielding a digest of a partial diff', () => {
  const { fx } = syncBranch();
  try {
    assert.throws(() => computeResolutionDiff(fx.dir, { base: 'does-not-exist' }), /cannot resolve --base/);
    assert.throws(() => buildResolutionDiffDirect(fx.dir, { head: 'f'.repeat(40), base: 'e'.repeat(40) }));
    const out = (() => {
      try {
        execFileSync('node', [CLI, 'resolution-diff', '--digest', '--base', 'nope'], { cwd: fx.dir, stdio: 'pipe' });
        return 0;
      } catch (e) {
        return e.status;
      }
    })();
    assert.equal(out, 2); // an error, not the 1 that means blocking findings
  } finally {
    fx.cleanup();
  }
});

test('the digest does not change with the machine\'s diff or merge configuration', () => {
  const { fx } = syncBranch();
  try {
    const before = computeResolutionDiff(fx.dir, {}).digest;
    fx.git('config', 'merge.conflictStyle', 'diff3');
    fx.git('config', 'diff.algorithm', 'patience');
    fx.git('config', 'diff.renames', 'copies');
    fx.git('config', 'diff.context', '9');
    fx.git('config', 'diff.noprefix', 'true');
    assert.equal(computeResolutionDiff(fx.dir, {}).digest, before);
  } finally {
    fx.cleanup();
  }
});

test('a fix commit is shown in full, even for paths a script would settle in a merge', () => {
  const { fx } = syncBranch();
  try {
    fx.commit({ 'pnpm-lock.yaml': 'hand edited lock\n', 'packages/db/src/migrations/0009_hand_written.sql': 'create table mine();\n' }, 'fix: by hand');
    const r = computeResolutionDiff(fx.dir, {});
    assert.match(r.document, /\n\+hand edited lock\n/);
    assert.match(r.document, /\n\+create table mine\(\);\n/);
  } finally {
    fx.cleanup();
  }
});

test('an unregistered generated file in a merge is shown in full, not summarized', () => {
  const { fx } = Fixture.scenario({
    base: { 'a.txt': 'a\n' },
    upstream: [[{ 'packages/x/src/thing.generated.ts': 'export const x = 1;\n' }, 'adds generated (#1)']],
  });
  try {
    fx.git('checkout', '-q', '-b', 'sync');
    fx.git('merge', '--no-commit', '--no-ff', 'upstream');
    fx.write('packages/x/src/thing.generated.ts', 'export const x = 2; // edited by hand\n');
    fx.git('add', '-A');
    fx.git('commit', '-q', '-m', 'Merge upstream');
    const r = computeResolutionDiff(fx.dir, {});
    assert.match(r.document, /\+export const x = 2; \/\/ edited by hand/);
    assert.ok(!/^mechanical generated:unregistered/m.test(r.document));
  } finally {
    fx.cleanup();
  }
});
