import test from 'node:test';
import assert from 'node:assert/strict';
import { activeIssuesForRevision, feedbackRevision } from '../lib/review-round.mjs';

test('completed review revision scopes follow-up work to that round', () => {
  const manifest = { base_revision: 'R33' };
  assert.equal(feedbackRevision(manifest, null), 'R33');
  assert.equal(feedbackRevision(manifest, { mode: 'result', result_revision: 'R35', completed_revision: 'R34' }), 'R34');
  assert.deepEqual(activeIssuesForRevision([
    { issue_id: 'old', base_revision: 'R33', status: 'submitted' },
    { issue_id: 'current', base_revision: 'R34', status: 'returned' },
    { issue_id: 'draft', base_revision: 'R34', status: 'draft' },
    { issue_id: 'deleted', base_revision: 'R34', status: 'submitted', deleted_at: '2026-01-01' },
  ], 'R34', 'R33').map((issue) => issue.issue_id), ['current']);
});
