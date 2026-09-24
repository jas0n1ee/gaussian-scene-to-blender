import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewScope } from '../src/review-scope.js';

test('R35 sidebar only includes R35 issues and camera views', () => {
  const state = {
    manifest: { base_revision: 'R33' }, reviewRevision: 'R35',
    issues: [
      { issue_id: 'R33_I1', base_revision: 'R33' },
      { issue_id: 'R34_I1', base_revision: 'R34' },
      { issue_id: 'R35_I1', base_revision: 'R35' },
      { issue_id: 'R35_I2', base_revision: 'R35', deleted_at: '2026-01-01' },
    ],
    views: [
      { view_id: 'V0001', camera: {} },
      { view_id: 'V0002', camera: { model_revision: 'R34' } },
      { view_id: 'V0003', camera: { model_revision: 'R35' } },
    ],
  };
  const scoped = reviewScope(state);
  assert.equal(scoped.revision, 'R35');
  assert.deepEqual(scoped.issues.map((item) => item.issue_id), ['R35_I1']);
  assert.deepEqual(scoped.views.map((item) => item.view_id), ['V0003']);
});
