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
  const components = new Map();

  async function request(path, { body, method = body ? 'POST' : 'GET', statuses = [200] } = {}) {
    let status;
    let responseBody;
    let logged = false;
    function logFailure() {
      let detail = responseBody ?? 'Response body unavailable';
      for (const value of redactions) detail = detail.replaceAll(value, '[REDACTED]');
      // A single quoted line prevents response text from becoming workflow commands.
      log(`Jira ${method} ${path}: ${status ?? 'request failed'}; body: ${JSON.stringify(detail)}`);
      logged = true;
    }
    try {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      requestSignal.throwIfAborted();
      const response = await fetchImpl(`${endpoint}${path}`, {
        method,
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
      return { status, data: status === 204 ? null : JSON.parse(responseBody) };
    } catch {
      if (!logged) logFailure();
      // Keep thrown errors generic; diagnostics above contain no request/response headers.
      throw new Error('Jira request failed or returned an invalid response');
    }
  }

  async function getIssue(reference) {
    const { status, data } = await request(`/issue/${encodeURIComponent(reference)}?fields=status,project,components`, { statuses: [200, 404] });
    if (status === 404) {
      if (Array.isArray(data?.errorMessages) && data.errorMessages.includes(missingIssueMessage)) return null;
      throw new Error('Unrecognized Jira issue-not-found response');
    }
    if (!['new', 'indeterminate', 'done'].includes(data?.fields?.status?.statusCategory?.key)) {
      throw new Error('Jira response is missing a recognized status category');
    }
    // Issue validation already returns components; reuse their IDs across the project.
    if (nonempty(data.fields.project?.key) && Array.isArray(data.fields.components)) {
      for (const component of data.fields.components) {
        if (nonempty(component?.id) && nonempty(component.name)) {
          components.set(`${data.fields.project.key}/${component.name.toLowerCase()}`, Promise.resolve(component));
        }
      }
    }
    return data;
  }

  async function findComponent(project, name) {
    const { data } = await request(`/project/${encodeURIComponent(project)}/components`);
    if (!Array.isArray(data)) throw new Error('Invalid Jira project components response');
    return data.find((component) => typeof component?.name === 'string' && component.name.toLowerCase() === name.toLowerCase());
  }

  async function ensureComponent(project, name) {
    const { status, data } = await request('/component', { body: { name, project }, statuses: [201, 400, 403] });
    // Reuse a component created concurrently or with different casing, even without create permission.
    const component = status === 201 ? data : await findComponent(project, name);
    if (!nonempty(component?.id) || typeof component.name !== 'string' || component.name.toLowerCase() !== name.toLowerCase()) {
      throw new Error('Invalid Jira component response');
    }
    return component;
  }

  async function assignRepositoryComponent(reference, issue, name) {
    const project = issue.fields.project?.key;
    const assigned = issue.fields.components;
    if (!nonempty(project) || !Array.isArray(assigned) || assigned.some((component) => !nonempty(component?.id) && !nonempty(component?.name))) {
      throw new Error('Jira issue is missing project or component information');
    }
    const cacheKey = `${project}/${name.toLowerCase()}`;
    const existing = assigned.find((component) => typeof component.name === 'string' && component.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      components.set(cacheKey, Promise.resolve(existing));
      return;
    }
    let component = components.has(cacheKey) ? await components.get(cacheKey) : { name };
    const update = (component, statuses = [204]) => {
      const value = component.id ? { id: component.id } : { name: component.name };
      return request(`/issue/${encodeURIComponent(reference)}`, {
        method: 'PUT', statuses, body: { update: { components: [{ add: value }] } },
      });
    };
    if (!components.has(cacheKey)) {
      // Existing components can be assigned by name in one call, without a lookup.
      const { status, data } = await update(component, [204, 400]);
      if (status === 204) {
        components.set(cacheKey, Promise.resolve(component));
        assigned.push(component);
        return;
      }
      // A 400 can also mean the field is not editable. Only create for a missing name.
      const errors = data?.errors ?? {};
      const messages = data?.errorMessages ?? [];
      if (errors.components !== `Component name '${name}' is not valid` ||
          Object.keys(errors).length !== 1 || !Array.isArray(messages) || messages.length) {
        throw new Error('Jira rejected the component assignment');
      }
      components.set(cacheKey, ensureComponent(project, name));
      component = await components.get(cacheKey);
    }
    if (component.id && assigned.some(({ id }) => id === component.id)) return;
    await update(component);
    assigned.push(component);
  }

  async function upsertPullRequestLink(reference, pr) {
    const url = new URL(pr.html_url);
    const pullRequest = /^\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)\/?$/.exec(url.pathname);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
        !Number.isSafeInteger(pr.number) || pr.number <= 0 || typeof pr.title !== 'string' ||
        !pullRequest || pullRequest[3] !== String(pr.number)) throw new Error('Invalid pull request link');
    const { data } = await request(`/issue/${encodeURIComponent(reference)}/remotelink`, {
      statuses: [200, 201],
      body: {
        globalId: `${pullRequest[1]}/${pullRequest[2]}/${pr.number}`,
        application: { type: 'net.phrond.pr-traceability', name: 'GitHub' },
        relationship: 'implemented by',
        object: {
          url: url.href,
          title: `PR #${pr.number}: ${pr.title}`,
        },
      },
    });
    if (!/^[1-9][0-9]*$/.test(String(data?.id))) throw new Error('Invalid Jira remote link response');
  }

  return { getIssue, assignRepositoryComponent, upsertPullRequestLink };
}
