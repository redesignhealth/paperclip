import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateFactoryPr,
  gateChecksGreen,
  holdPaths,
  isFactoryOwned,
} from '../factory-merge-eligibility.mjs';

const REPO = 'redesignhealth/paperclip';
const SHA = 'a'.repeat(40);

const pr = (over = {}) => ({
  state: 'open',
  merged: false,
  draft: false,
  mergeable: true,
  mergeable_state: 'clean',
  user: { login: 'rh-code-factory[bot]', type: 'Bot' },
  head: { ref: 'factory/DAN-1', sha: SHA, repo: { full_name: REPO } },
  base: { ref: 'master' },
  ...over,
});
const check = (name, over = {}) => ({
  id: 1, name, status: 'completed', conclusion: 'success', app: { id: 5166579 }, ...over,
});
const green = () => [check('argus-gate', { id: 1 }), check('ci-aggregate', { id: 2 })];
const base = (over = {}) => ({
  pr: pr(), repo: REPO, files: ['packages/shared/src/x.ts'], checkRuns: green(), disabled: false, ...over,
});

test('a clean factory PR with both gate checks green is merged', () => {
  assert.equal(evaluateFactoryPr(base()).action, 'merge');
});

test("a person's PR is never touched", () => {
  const r = evaluateFactoryPr(base({ pr: pr({ user: { login: 'purpleCowOnWheels', type: 'User' }, head: { ref: 'fix/x', sha: SHA, repo: { full_name: REPO } } }) }));
  assert.equal(r.action, 'skip');
});

test("a person's PR on a factory/ branch is never touched", () => {
  const r = evaluateFactoryPr(base({ pr: pr({ user: { login: 'purpleCowOnWheels', type: 'User' } }) }));
  assert.equal(r.action, 'skip');
  assert.match(r.reason, /not a factory-owned/);
});

test('the factory bot on a non-factory branch is never touched', () => {
  const r = evaluateFactoryPr(base({ pr: pr({ head: { ref: 'bump/pin', sha: SHA, repo: { full_name: REPO } } }) }));
  assert.equal(r.action, 'skip');
});

test('a bot-named user that is not type Bot is not owned', () => {
  assert.equal(isFactoryOwned(pr({ user: { login: 'rh-code-factory[bot]', type: 'User' } }), REPO), false);
});

test('a factory PR from another repository or a non-master base is not owned', () => {
  assert.equal(isFactoryOwned(pr({ head: { ref: 'factory/x', sha: SHA, repo: { full_name: 'evil/paperclip' } } }), REPO), false);
  assert.equal(isFactoryOwned(pr({ base: { ref: 'release' } }), REPO), false);
});

test('argus-gate published by another app (forged check) does not count', () => {
  const runs = [check('argus-gate', { app: { id: 15368 } }), check('ci-aggregate')];
  assert.equal(gateChecksGreen(runs), false);
  assert.equal(evaluateFactoryPr(base({ checkRuns: runs })).action, 'skip');
});

test('a missing, pending or failed gate check blocks the merge', () => {
  assert.equal(evaluateFactoryPr(base({ checkRuns: [check('ci-aggregate')] })).action, 'skip');
  assert.equal(evaluateFactoryPr(base({ checkRuns: [check('argus-gate', { status: 'in_progress', conclusion: null }), check('ci-aggregate')] })).action, 'skip');
  assert.equal(evaluateFactoryPr(base({ checkRuns: [check('argus-gate', { conclusion: 'failure' }), check('ci-aggregate')] })).action, 'skip');
});

test('a newer revoking gate run beats an older success', () => {
  const runs = [check('argus-gate', { id: 5 }), check('argus-gate', { id: 9, conclusion: 'failure' }), check('ci-aggregate')];
  assert.equal(gateChecksGreen(runs), false);
});

test('hold-list paths are held for a person', () => {
  for (const f of ['.github/workflows/x.yml', 'packages/db/src/migrations/0400_x.sql', 'server/src/auth/x.ts', 'server/src/secrets/x.ts', 'docker/x', 'Dockerfile', 'pnpm-lock.yaml', 'docs/merge-policy.md']) {
    const r = evaluateFactoryPr(base({ files: ['ui/src/a.ts', f] }));
    assert.equal(r.action, 'hold', f);
    assert.deepEqual(r.paths, [f]);
  }
  assert.deepEqual(holdPaths(['ui/src/a.ts', 'packages/shared/src/b.ts']), []);
});

test('an upstream-sync branch is skipped (needs a merge commit)', () => {
  for (const ref of ['factory/sync-123', 'factory/upstream-sync/x']) {
    const r = evaluateFactoryPr(base({ pr: pr({ head: { ref, sha: SHA, repo: { full_name: REPO } } }) }));
    assert.equal(r.action, 'skip', ref);
  }
});

test('draft, closed and merged PRs are skipped', () => {
  assert.equal(evaluateFactoryPr(base({ pr: pr({ draft: true }) })).action, 'skip');
  assert.equal(evaluateFactoryPr(base({ pr: pr({ state: 'closed' }) })).action, 'skip');
  assert.equal(evaluateFactoryPr(base({ pr: pr({ merged: true }) })).action, 'skip');
});

test('merge state unknown retries; conflicts, behind and blocked skip', () => {
  assert.equal(evaluateFactoryPr(base({ pr: pr({ mergeable: null, mergeable_state: 'unknown' }) })).action, 'retry');
  assert.equal(evaluateFactoryPr(base({ pr: pr({ mergeable: false, mergeable_state: 'dirty' }) })).action, 'skip');
  assert.equal(evaluateFactoryPr(base({ pr: pr({ mergeable_state: 'behind' }) })).action, 'skip');
  assert.equal(evaluateFactoryPr(base({ pr: pr({ mergeable_state: 'blocked' }) })).action, 'skip');
});

test('the off switch stops everything', () => {
  assert.equal(evaluateFactoryPr(base({ disabled: true })).action, 'skip');
});
