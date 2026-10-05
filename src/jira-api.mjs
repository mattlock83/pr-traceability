/** Create a Jira Cloud lookup from a single JSON secret, without exposing it. */
export function createJiraLookup(secret, {
  fetchImpl = globalThis.fetch,
  signal = AbortSignal.timeout(5 * 60_000),
} = {}) {
  let config;
  let baseUrl;
  try {
    config = JSON.parse(secret);
    if (!['baseUrl', 'email', 'apiToken'].every((key) =>
      typeof config?.[key] === 'string' && config[key].trim())) throw new Error();
    baseUrl = new URL(config.baseUrl);
    if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password ||
        baseUrl.search || baseUrl.hash || config.email.includes(':')) throw new Error();
  } catch {
    throw new Error('Invalid jira-secret: expected JSON with an HTTPS baseUrl, email, and apiToken');
  }
  const endpoint = baseUrl.href.replace(/\/+$/, '');
  const authorization = `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}`;
  const cache = new Map();

  // Cache repeated lookups of the same issue.
  return async function lookup(reference) {
    if (cache.has(reference)) return cache.get(reference);
    let response;
    try {
      response = await fetchImpl(`${endpoint}/rest/api/3/issue/${encodeURIComponent(reference)}?fields=status`, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Authorization: authorization,
          Accept: 'application/json',
          // Jira otherwise uses the account's language for error messages.
          'Accept-Language': 'en-US',
          'X-Force-Accept-Language': 'true',
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
    } catch {
      throw new Error('Jira request failed; check connectivity and the job timeout');
    }
    if (response.status !== 200 && response.status !== 404) {
      await response.body?.cancel();
      throw new Error(`Jira returned HTTP ${response.status}; check jira-secret, issue access, and API rate limits`);
    }
    let issue;
    try {
      issue = await response.json();
    } catch {
      throw new Error('Jira returned an invalid response');
    }
    if (response.status === 404) {
      // Routing/proxy 404s are integration failures, not missing issues.
      if (!Array.isArray(issue?.errorMessages) ||
          !issue.errorMessages.includes('Issue does not exist or you do not have permission to see it.')) {
        throw new Error('Jira returned an unrecognized HTTP 404 response');
      }
      cache.set(reference, 'not found or inaccessible');
      return cache.get(reference);
    }
    const category = issue?.fields?.status?.statusCategory?.key;
    if (!['new', 'indeterminate', 'done'].includes(category)) {
      throw new Error('Jira response is missing a recognized issue status category');
    }
    const status = category === 'done' ? 'Done' : 'active';
    cache.set(reference, status);
    return status;
  };
}
