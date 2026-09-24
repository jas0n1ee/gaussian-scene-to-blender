export function reviewScope(state) {
  const revision = state.reviewRevision || state.manifest.base_revision;
  return {
    revision,
    issues: state.issues.filter((item) => !item.deleted_at && (item.base_revision || state.manifest.base_revision) === revision),
    views: state.views.filter((item) => (item.camera.model_revision || state.manifest.base_revision) === revision),
  };
}
