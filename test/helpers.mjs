export function event(fields = {}) {
  return {
    repository: { name: 'repo', owner: { login: 'base-owner' } },
    sender: { type: 'Bot' },
    pull_request: { number: 42, head: { sha: 'abc' }, ...fields },
  };
}

export function jiraNotFound() {
  return Response.json({
    errorMessages: ['Issue does not exist or you do not have permission to see it.'],
    errors: {},
  }, { status: 404 });
}
