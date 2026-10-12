import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJiraClient } from '../src/jira-api.mjs';
import { applyJira } from '../src/jira-integration.mjs';

const secret = JSON.stringify({ email: 'ci@example.com', apiToken: 'secret-token' });
const url = 'https://jira.example.com';
const name = 'OpenAI/codex';
const issue = (project = 'TEAM', components = [], category = 'new') => ({ fields: {
  status: { statusCategory: { key: category } }, project: { key: project }, components,
} });
const event = (action = 'opened', merged = false) => ({ action, repository: { full_name: name }, pull_request: {
  number: 42, title: 'TEAM-1', html_url: 'https://github.com/OpenAI/codex/pull/42', merged,
  head: { repo: { full_name: 'contributor/fork' } },
} });
const result = (references = ['TEAM-1']) => ({ status: 'passed', reason: 'Jira reference found', references });

function mockJira({ issues = { 'TEAM-1': issue() }, projects = {}, intercept } = {}) {
  const requests = [];
  let nextId = 100;
  const fetchImpl = async (requestUrl, options) => {
    const path = new URL(requestUrl).pathname.replace('/rest/api/3', '');
    const body = options.body ? JSON.parse(options.body) : undefined;
    const request = { path, method: options.method, body };
    requests.push(request);
    const respond = (response) => { request.status = response.status; return response; };
    const override = await intercept?.(request);
    if (override) return respond(override);
    if (path.startsWith('/project/')) return respond(Response.json(projects[decodeURIComponent(path.split('/')[2])] ?? []));
    if (path === '/component') {
      const components = projects[body.project] ??= [];
      if (components.some((component) => component.name.toLowerCase() === body.name.toLowerCase())) {
        return respond(Response.json({ errors: { name: 'Component already exists' } }, { status: 400 }));
      }
      const component = { id: String(nextId++), name: body.name };
      components.push(component);
      return respond(Response.json(component, { status: 201 }));
    }
    const key = decodeURIComponent(path.split('/')[2]);
    const current = issues[key];
    assert.ok(current, `Unexpected issue: ${key}`);
    if (options.method === 'PUT') {
      assert.deepEqual(Object.keys(body), ['update']);
      const target = body.update.components[0].add;
      const component = (projects[current.fields.project.key] ?? []).find((component) =>
        target.id ? component.id === target.id : component.name === target.name);
      if (!component) return respond(Response.json({
        errorMessages: [], errors: { components: `Component name '${target.name}' is not valid` },
      }, { status: 400 }));
      assert.ok(!current.fields.components.some(({ id }) => id === component.id), 'must not assign duplicate component');
      current.fields.components.push(component);
      return respond(new Response(null, { status: 204 }));
    }
    if (path.endsWith('/remotelink')) return respond(Response.json({ id: 1 }));
    return respond(Response.json(current));
  };
  return { fetchImpl, requests, issues, projects };
}

function client(mock) {
  return createJiraClient({ secret, url, ...mock, log() {} });
}

for (const components of ['false', ' false ']) {
  for (const remoteLinks of ['false', 'true']) {
    test(`Jira components: disabled (${JSON.stringify(components)}) preserves validation and links=${remoteLinks}`, async () => {
      const mock = mockJira({ issues: { 'TEAM-1': issue(), 'OPS-2': issue('OPS') } });
      const checked = await applyJira(result(['TEAM-1', 'OPS-2']), event(), { secret, url, components, remoteLinks, ...mock, log() {} });
      assert.equal(checked.status, 'passed');
      assert.match(checked.reason, /Referenced Jira issues exist and are outside Done/);
      assert.doesNotMatch(checked.reason, /component/i);
      assert.deepEqual(mock.requests.map(({ method, path }) => ({ method, path })), [
        { method: 'GET', path: '/issue/TEAM-1' },
        { method: 'GET', path: '/issue/OPS-2' },
        ...(remoteLinks === 'true' ? [
          { method: 'POST', path: '/issue/TEAM-1/remotelink' },
          { method: 'POST', path: '/issue/OPS-2/remotelink' },
        ] : []),
      ]);
      assert.deepEqual(mock.projects, {});
      assert.deepEqual(mock.issues['TEAM-1'].fields.components, []);
      assert.deepEqual(mock.issues['OPS-2'].fields.components, []);
    });
  }
}

for (const components of [undefined, '', ' ', 'true', ' true ']) {
  test(`Jira components: enabled by default or explicit ${JSON.stringify(components)}`, async () => {
    const mock = mockJira({ projects: { TEAM: [{ id: '8', name }] } });
    const checked = await applyJira(result(), event(), { secret, url, components, ...mock, log() {} });
    assert.match(checked.reason, /Jira repository component assigned/);
    assert.deepEqual(mock.requests.map(({ method, path }) => ({ method, path })), [
      { method: 'GET', path: '/issue/TEAM-1' },
      { method: 'PUT', path: '/issue/TEAM-1' },
    ]);
    assert.deepEqual(mock.issues['TEAM-1'].fields.components, [{ id: '8', name }]);
  });
}

test('Jira components: disabling does not exempt Done issues from validation', async () => {
  const mock = mockJira({ issues: { 'TEAM-1': issue('TEAM', [], 'done') } });
  await assert.rejects(applyJira(result(), event(), { secret, url, components: 'false', remoteLinks: 'true', ...mock, log() {} }), /TEAM-1: Done/);
  assert.deepEqual(mock.requests.map(({ method, path }) => ({ method, path })), [{ method: 'GET', path: '/issue/TEAM-1' }]);
});

test('Jira components: disabling preserves regex fallback for Jira outages', async () => {
  const mock = mockJira({ intercept: () => new Response('Unavailable', { status: 503 }) });
  const checked = await applyJira(result(), event(), { secret, url, components: 'false', ...mock, log() {} });
  assert.equal(checked.status, 'passed');
  assert.match(checked.reason, /passed regex-only check/);
  assert.doesNotMatch(checked.reason, /component/i);
  assert.equal(mock.requests.length, 1);
});

test('Jira components: create and assign once while preserving existing issue components', async () => {
  const mock = mockJira({ issues: { 'TEAM-1': issue('TEAM', [{ id: '7' }]) } });
  const jira = client(mock);
  await jira.assignRepositoryComponent('TEAM-1', await jira.getIssue('TEAM-1'), name);
  const rerun = client(mock);
  await rerun.assignRepositoryComponent('TEAM-1', await rerun.getIssue('TEAM-1'), name);
  assert.deepEqual(mock.projects.TEAM, [{ id: '100', name }]);
  assert.deepEqual(mock.issues['TEAM-1'].fields.components, [{ id: '7' }, { id: '100', name }]);
  assert.equal(mock.requests.filter(({ path }) => path === '/component').length, 1);
  assert.equal(mock.requests.filter(({ method, status }) => method === 'PUT' && status === 204).length, 1);
  assert.equal(mock.requests.filter(({ path }) => path.endsWith('/components')).length, 0);
});

test('Jira components: reuse an existing name with different casing without renaming it', async () => {
  const mock = mockJira({ projects: { TEAM: [{ id: '8', name: 'openai/Codex' }] } });
  await client(mock).assignRepositoryComponent('TEAM-1', structuredClone(mock.issues['TEAM-1']), name);
  assert.equal(mock.requests.filter(({ path }) => path === '/component').length, 1);
  assert.deepEqual(mock.projects.TEAM, [{ id: '8', name: 'openai/Codex' }]);
  assert.deepEqual(mock.issues['TEAM-1'].fields.components, [{ id: '8', name: 'openai/Codex' }]);
});

test('Jira components: already assigned requires no component calls', async () => {
  const mock = mockJira({ issues: { 'TEAM-1': issue('TEAM', [{ id: '8', name }]) }, projects: { TEAM: [{ id: '8', name }] } });
  await client(mock).assignRepositoryComponent('TEAM-1', structuredClone(mock.issues['TEAM-1']), name);
  assert.deepEqual(mock.requests, []);
});

test('Jira components: existing unassigned component needs only one PUT by name', async () => {
  const mock = mockJira({ projects: { TEAM: [{ id: '8', name }] } });
  await client(mock).assignRepositoryComponent('TEAM-1', structuredClone(mock.issues['TEAM-1']), name);
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0].method, 'PUT');
  assert.deepEqual(mock.requests[0].body, { update: { components: [{ add: { name } }] } });
  assert.deepEqual(mock.issues['TEAM-1'].fields.components, [{ id: '8', name }]);
});

test('Jira components: missing component needs three calls without a preflight lookup', async () => {
  const mock = mockJira();
  await client(mock).assignRepositoryComponent('TEAM-1', structuredClone(mock.issues['TEAM-1']), name);
  assert.deepEqual(mock.requests.map(({ method, path, status }) => ({ method, path, status })), [
    { method: 'PUT', path: '/issue/TEAM-1', status: 400 },
    { method: 'POST', path: '/component', status: 201 },
    { method: 'PUT', path: '/issue/TEAM-1', status: 204 },
  ]);
});

test('Jira integration: component from a later validated reference eliminates project lookups', async () => {
  const component = { id: '8', name: 'openai/Codex' };
  const mock = mockJira({ issues: { 'TEAM-1': issue(), 'TEAM-2': issue('TEAM', [component]) }, projects: { TEAM: [component] } });
  const checked = await applyJira(result(['TEAM-1', 'TEAM-2']), event(), { secret, url, ...mock, log() {} });
  assert.equal(checked.status, 'passed');
  assert.deepEqual(mock.requests.map(({ method, path }) => ({ method, path })), [
    { method: 'GET', path: '/issue/TEAM-1' },
    { method: 'GET', path: '/issue/TEAM-2' },
    { method: 'PUT', path: '/issue/TEAM-1' },
  ]);
  assert.deepEqual(mock.requests[2].body, { update: { components: [{ add: { id: '8' } }] } });
});

test('Jira components: existing differently-cased name works without creation permission', async () => {
  const mock = mockJira({ projects: { TEAM: [{ id: '8', name: 'openai/Codex' }] }, intercept: ({ path }) =>
    path === '/component' ? Response.json({ errorMessages: ['No permission to create components'] }, { status: 403 }) : undefined });
  await client(mock).assignRepositoryComponent('TEAM-1', structuredClone(mock.issues['TEAM-1']), name);
  assert.deepEqual(mock.issues['TEAM-1'].fields.components, [{ id: '8', name: 'openai/Codex' }]);
});

test('Jira integration: existing project component needs only one update per unassigned issue', async () => {
  const mock = mockJira({ issues: { 'TEAM-1': issue(), 'TEAM-2': issue() }, projects: { TEAM: [{ id: '8', name }] } });
  await applyJira(result(['TEAM-1', 'TEAM-2']), event(), { secret, url, ...mock, log() {} });
  assert.deepEqual(mock.requests.map(({ method, path }) => ({ method, path })), [
    { method: 'GET', path: '/issue/TEAM-1' },
    { method: 'GET', path: '/issue/TEAM-2' },
    { method: 'PUT', path: '/issue/TEAM-1' },
    { method: 'PUT', path: '/issue/TEAM-2' },
  ]);
});

test('Jira components: recover when another PR creates the component between assignment and create', async () => {
  const projects = {};
  const mock = mockJira({ projects, intercept: ({ path }) => {
    if (path === '/component') {
      projects.TEAM = [{ id: '9', name }];
      return Response.json({ errors: { name: 'Component already exists' } }, { status: 400 });
    }
  } });
  await client(mock).assignRepositoryComponent('TEAM-1', structuredClone(mock.issues['TEAM-1']), name);
  assert.deepEqual(mock.issues['TEAM-1'].fields.components, [{ id: '9', name }]);
  assert.equal(mock.requests.filter(({ path }) => path.endsWith('/components')).length, 1);
});

for (const [label, intercept] of [
  ['list permission failure', ({ path }) => path === '/component' ? Response.json({}, { status: 400 }) : path.endsWith('/components') ? new Response(null, { status: 403 }) : undefined],
  ['malformed list', ({ path }) => path === '/component' ? Response.json({}, { status: 400 }) : path.endsWith('/components') ? Response.json({}) : undefined],
  ['invalid existing ID', ({ path }) => path === '/component' ? Response.json({}, { status: 400 }) : path.endsWith('/components') ? Response.json([{ name }]) : undefined],
  ['create permission failure', ({ path }) => path === '/component' ? new Response(null, { status: 403 }) : undefined],
  ['create rejected without a matching component', ({ path }) => path === '/component' ? Response.json({ errors: { name: 'Rejected' } }, { status: 400 }) : undefined],
  ['invalid created ID', ({ path }) => path === '/component' ? Response.json({ name }, { status: 201 }) : undefined],
]) {
  test(`Jira components: ${label} does not assign an unverified component`, async () => {
    const mock = mockJira({ intercept });
    await assert.rejects(client(mock).assignRepositoryComponent('TEAM-1', structuredClone(mock.issues['TEAM-1']), name));
    assert.deepEqual(mock.issues['TEAM-1'].fields.components, []);
  });
}

for (const fields of [{}, { project: { key: 'TEAM' } }, { project: { key: 'TEAM' }, components: [{}] }]) {
  test(`Jira components: missing metadata is safe (${JSON.stringify(fields)})`, async () => {
    const mock = mockJira();
    await assert.rejects(client(mock).assignRepositoryComponent('TEAM-1', { fields }, name), /missing project or component/);
    assert.equal(mock.requests.length, 0);
  });
}

test('Jira components: issue update failure logs its body and uses PUT without headers', async () => {
  const logs = [];
  const mock = mockJira({ intercept: ({ method }) => method === 'PUT'
    ? Response.json({ errors: { components: 'Field is not editable' } }, { status: 400 }) : undefined });
  const jira = createJiraClient({ secret, url, ...mock, log: (message) => logs.push(message) });
  await assert.rejects(jira.assignRepositoryComponent('TEAM-1', structuredClone(mock.issues['TEAM-1']), name));
  assert.match(logs[0], /PUT \/issue\/TEAM-1: 400.*Field is not editable/);
  assert.doesNotMatch(logs[0], /Authorization|secret-token/);
  assert.equal(mock.requests.length, 1, 'must not create a component for a field configuration error');
  assert.deepEqual(mock.projects, {});
});

for (const [label, response] of [
  ['unrelated field error', { errors: { summary: 'Summary is required' } }],
  ['unrecognized component error', { errors: { components: 'Invalid operation' } }],
  ['different component name', { errors: { components: "Component name 'Other/repo' is not valid" } }],
  ['another field also failed', { errors: { components: `Component name '${name}' is not valid`, summary: 'Summary is required' } }],
  ['global error also present', { errors: { components: `Component name '${name}' is not valid` }, errorMessages: ['Issue cannot be edited'] }],
  ['malformed error messages', { errors: { components: `Component name '${name}' is not valid` }, errorMessages: {} }],
  ['empty response', {}],
  ['null response', null],
]) {
  test(`Jira components: ${label} does not trigger creation or block traceability`, async () => {
    const mock = mockJira({ intercept: ({ method }) => method === 'PUT' ? Response.json(response, { status: 400 }) : undefined });
    const checked = await applyJira(result(), event(), { secret, url, remoteLinks: 'true', ...mock, log() {} });
    assert.equal(checked.status, 'passed');
    assert.match(checked.reason, /Some Jira repository components could not be assigned/);
    assert.match(checked.reason, /PR remote links created/);
    assert.deepEqual(mock.requests.map(({ method, path }) => ({ method, path })), [
      { method: 'GET', path: '/issue/TEAM-1' },
      { method: 'PUT', path: '/issue/TEAM-1' },
      { method: 'POST', path: '/issue/TEAM-1/remotelink' },
    ]);
    assert.deepEqual(mock.projects, {});
    assert.deepEqual(mock.issues['TEAM-1'].fields.components, []);
  });
}

test('Jira integration: create in each actual project and assign all references once', async () => {
  const mock = mockJira({ issues: { 'TEAM-1': issue(), 'TEAM-2': issue(), 'OLD-3': issue('OPS') } });
  const checked = await applyJira(result(['TEAM-1', 'TEAM-2', 'OLD-3']), event(), { secret, url, ...mock, log() {} });
  assert.equal(checked.status, 'passed');
  assert.match(checked.reason, /repository component assigned/);
  assert.deepEqual(mock.requests.filter(({ path }) => path === '/component').map(({ body }) => body), [
    { name, project: 'TEAM' }, { name, project: 'OPS' },
  ]);
  assert.equal(mock.requests.filter(({ path }) => path.endsWith('/components')).length, 0);
  assert.deepEqual(mock.requests.filter(({ method, status }) => method === 'PUT' && status === 204).map(({ path }) => path), ['/issue/TEAM-1', '/issue/TEAM-2', '/issue/OLD-3']);
});

test('Jira integration: component failures do not block other projects or optional remote links', async () => {
  const mock = mockJira({ issues: { 'TEAM-1': issue(), 'OPS-1': issue('OPS') }, intercept: ({ path, method }) =>
    path === '/issue/TEAM-1' && method === 'PUT' ? new Response(null, { status: 403 }) : undefined });
  const checked = await applyJira(result(['TEAM-1', 'OPS-1']), event(), { secret, url, remoteLinks: 'true', ...mock, log() {} });
  assert.equal(checked.status, 'passed');
  assert.match(checked.reason, /Some Jira repository components could not be assigned/);
  assert.match(checked.reason, /PR remote links created/);
  assert.deepEqual(mock.requests.filter(({ method, status }) => method === 'PUT' && status === 204).map(({ path }) => path), ['/issue/OPS-1']);
});

for (const action of ['edited', 'synchronize', 'reopened', 'labeled', 'unlabeled', 'closed']) {
  test(`Jira integration: components only run on opened, never ${action}`, async () => {
    const mock = mockJira();
    await applyJira(result(), event(action, action === 'closed'), { secret, url, remoteLinks: 'true', ...mock, log() {} });
    assert.ok(mock.requests.every(({ method }) => method === 'GET'));
  });
}

test('Jira integration: missing repository metadata does not create a component', async () => {
  const mock = mockJira();
  const prEvent = event();
  delete prEvent.repository;
  const checked = await applyJira(result(), prEvent, { secret, url, ...mock, log() {} });
  assert.match(checked.reason, /components could not be assigned/);
  assert.ok(mock.requests.every(({ method }) => method === 'GET'));
});

for (const repository of [undefined, 42, 'repo', 'owner/repo/extra']) {
  test(`Jira integration: invalid repository ${JSON.stringify(repository)} skips all component assignments but still creates links`, async () => {
    const mock = mockJira({ issues: { 'TEAM-1': issue(), 'TEAM-2': issue() } });
    const prEvent = event();
    prEvent.repository.full_name = repository;
    const checked = await applyJira(result(['TEAM-1', 'TEAM-2']), prEvent, { secret, url, remoteLinks: 'true', ...mock, log() {} });
    assert.match(checked.reason, /Some Jira repository components could not be assigned/);
    assert.match(checked.reason, /Jira PR remote links created/);
    assert.deepEqual(mock.requests.map(({ method, path }) => ({ method, path })), [
      { method: 'GET', path: '/issue/TEAM-1' },
      { method: 'GET', path: '/issue/TEAM-2' },
      { method: 'POST', path: '/issue/TEAM-1/remotelink' },
      { method: 'POST', path: '/issue/TEAM-2/remotelink' },
    ]);
  });
}

test('Jira integration: a Done reference prevents all component writes', async () => {
  const mock = mockJira({ issues: { 'TEAM-1': issue(), 'OPS-1': issue('OPS', [], 'done') } });
  await assert.rejects(applyJira(result(['TEAM-1', 'OPS-1']), event(), { secret, url, ...mock, log() {} }), /OPS-1: Done/);
  assert.ok(mock.requests.every(({ method }) => method === 'GET'));
});
