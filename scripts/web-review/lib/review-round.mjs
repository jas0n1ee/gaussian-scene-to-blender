export function feedbackRevision(manifest, session) {
  return session?.completed_revision || (session?.mode === 'result' ? session.result_revision : manifest.base_revision);
}

export function activeIssuesForRevision(issues, revision, baseRevision) {
  return issues.filter((issue) =>
    !issue.deleted_at &&
    ['submitted', 'returned'].includes(issue.status) &&
    (issue.base_revision || baseRevision) === revision
  );
}
