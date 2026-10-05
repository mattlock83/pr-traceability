const missingIssueMessage = 'Issue does not exist or you do not have permission to see it.';
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;

/** Jira Cloud client using REST API v3 and email/API-token authentication. */
export function createJiraClient({ secret, url, fetchImpl = globalThis.fetch, signal = AbortSignal.timeout(30_000), log = console.log }) {
  let baseUrl;
  let authorization;
  let redactions;
  try {
    const config = JSON.parse(secret);
    baseUrl = new URL(url?.trim() || config.baseUrl);
    if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw new Error();
    if (!nonempty(config.email) || config.email.includes(':') || !nonempty(config.apiToken)) throw new Error();
    const encoded = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');
    authorization = `Basic ${encoded}`;
    redactions = [secret, encoded, config.apiToken, config.email];
  } catch {
    throw new Error('Invalid Jira URL or credentials');
  }
  const endpoint = `${baseUrl.href.replace(/\/+$/, '')}/rest/api/3`;
  const issues = new Map();

  async function request(path, { body, statuses = [200] } = {}) {
    let status;
    let responseBody;
    let logged = false;
    function logFailure() {
      let detail = responseBody ?? 'Response body unavailable';
      for (const value of redactions) detail = detail.replaceAll(value, '[REDACTED]');
      // A single quoted line prevents response text from becoming workflow commands.
      log(`Jira ${body ? 'POST' : 'GET'} ${path}: ${status ?? 'request failed'}; body: ${JSON.stringify(detail)}`);
      logged = true;
    }
    try {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      requestSignal.throwIfAborted();
      const response = await fetchImpl(`${endpoint}${path}`, {
        method: body ? 'POST' : 'GET',
        redirect: 'manual',
        headers: {
          Authorization: authorization,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Accept-Language': 'en-US',
          'X-Force-Accept-Language': 'true',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: requestSignal,
      });
      status = response.status;
      responseBody = await response.text();
      if (!response.ok || !statuses.includes(status)) logFailure();
      if (!statuses.includes(status)) throw new Error();
      return { status, data: JSON.parse(responseBody) };
    } catch {
      if (!logged) logFailure();
      // Keep thrown errors generic; diagnostics above contain no request/response headers.
      throw new Error('Jira request failed or returned an invalid response');
    }
  }

  async function readIssue(reference) {
    const { status, data } = await request(`/issue/${encodeURIComponent(reference)}?fields=status,parent`, { statuses: [200, 404] });
    if (status === 404) {
      if (Array.isArray(data?.errorMessages) && data.errorMessages.includes(missingIssueMessage)) return null;
      throw new Error('Unrecognized Jira issue-not-found response');
    }
    if (!['new', 'indeterminate', 'done'].includes(data?.fields?.status?.statusCategory?.key)) {
      throw new Error('Jira response is missing a recognized status category');
    }
    return data;
  }

  function getIssue(reference) {
    // Parents can be shared by references, or be references themselves.
    if (!issues.has(reference)) issues.set(reference, readIssue(reference));
    return issues.get(reference);
  }

  async function upsertPullRequestLink(reference, pr) {
    const url = new URL(pr.html_url);
    const pullRequest = /^\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)\/?$/.exec(url.pathname);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
        !Number.isSafeInteger(pr.number) || pr.number <= 0 || typeof pr.title !== 'string' ||
        !pullRequest || pullRequest[3] !== String(pr.number)) throw new Error('Invalid pull request link');
    const merged = pr.merged === true;
    const { data } = await request(`/issue/${encodeURIComponent(reference)}/remotelink`, {
      statuses: [200, 201],
      body: {
        globalId: `${pullRequest[1]}/${pullRequest[2]}/${pr.number}`,
        application: { type: 'net.phrond.pr-traceability', name: 'GitHub' },
        relationship: 'implemented by',
        object: {
          url: url.href,
          title: `PR #${pr.number}: ${pr.title}${merged ? ' [Merged]' : ''}`,
          status: { resolved: merged },
        },
      },
    });
    if (!/^[1-9][0-9]*$/.test(String(data?.id))) throw new Error('Invalid Jira remote link response');
  }

  return { getIssue, upsertPullRequestLink };
}
