import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyJira } from '../src/jira-integration.mjs';

const secret = JSON.stringify({ email: 'ci@example.com', apiToken: 'secret-token' });
const url = 'https://jira.example.com';
const event = (action = 'opened', merged = false) => ({ action, repository: { full_name: 'OpenAI/codex' }, pull_request: {
  number: 42, title: 'TEAM-1: Fix', html_url: 'https://github.com/org/repo/pull/42', merged,
} });
const result = (references = ['TEAM-1']) => ({ status: 'passed', reason: 'Jira reference found', references });
const issue = (category = 'new', parent) => ({ fields: { status: { statusCategory: { key: category } }, project: { key: 'TEAM' }, components: [], parent } });
const missing = () => Response.json({ errorMessages: ['Issue does not exist or you do not have permission to see it.'] }, { status: 404 });

function jira(issues = { 'TEAM-1': issue() }, { write } = {}) {
  const reads = [];
  const writes = [];
  const componentRequests = [];
  const fetchImpl = async (requestUrl, options) => {
    const path = new URL(requestUrl).pathname;
    if (path.endsWith('/components')) {
      componentRequests.push({ method: options.method, path });
      return Response.json([{ id: '100', name: 'OpenAI/codex' }]);
    }
    if (options.method === 'PUT') {
      componentRequests.push({ method: options.method, path, body: JSON.parse(options.body) });
      return new Response(null, { status: 204 });
    }
    const key = /\/issue\/([^/]+)/.exec(path)[1];
    if (options.method === 'POST') {
      writes.push({ key, body: JSON.parse(options.body) });
      return write ? write(key) : Response.json({ id: 1 });
    }
    reads.push(key);
    const value = issues[key];
    if (typeof value === 'function') return value();
    if (value === undefined) throw new Error('Unexpected request');
    return Response.json(value);
  };
  return { fetchImpl, reads, writes, componentRequests };
}

for (const options of [{}, { secret: '' }, { secret: ' ' }, { remoteLinks: 'true' }]) {
  test(`Jira integration: no secret makes no requests (${JSON.stringify(options)})`, async () => {
    const original = result();
    assert.equal(await applyJira(original, event(), { ...options, fetchImpl: () => assert.fail('unexpected request') }), original);
  });
}

test('Jira integration: exemptions bypass credentials and remote links', async () => {
  const original = { status: 'skipped', references: [], reason: 'PR author is a bot' };
  assert.equal(await applyJira(original, event(), {
    secret: 'invalid', remoteLinks: 'true', fetchImpl: () => assert.fail('unexpected request'),
  }), original);
});

test('Jira integration: only issues referenced in the PR title or branch are checked', async () => {
  const mock = jira({
    'TEAM-1': issue('new', { key: 'EPIC-1' }),
    'OPS-2': issue('indeterminate', { key: 'EPIC-1' }),
    'EPIC-1': issue('done'),
  });
  const checked = await applyJira(result(['TEAM-1', 'OPS-2']), event(), { secret, url, ...mock });
  assert.equal(checked.status, 'passed');
  assert.match(checked.reason, /Referenced Jira issues exist and are outside Done/);
  assert.deepEqual(mock.reads, ['TEAM-1', 'OPS-2']);
  assert.equal(mock.writes.length, 0);
});

test('Jira integration: an active referenced issue passes', async () => {
  const checked = await applyJira(result(), event(), { secret, url, ...jira() });
  assert.match(checked.reason, /Referenced Jira issues exist and are outside Done/);
});

for (const [name, issues, message] of [
  ['missing issue', { 'TEAM-1': missing }, /TEAM-1: not found or inaccessible/],
  ['Done issue', { 'TEAM-1': issue('done') }, /TEAM-1: Done/],
]) {
  test(`Jira integration: ${name} fails and writes no links`, async () => {
    const mock = jira(issues);
    await assert.rejects(applyJira(result(), event(), { secret, url, remoteLinks: 'true', ...mock }), message);
    assert.equal(mock.writes.length, 0);
  });
}

test('Jira integration: an active issue does not excuse another Done or missing issue', async () => {
  const mock = jira({ 'TEAM-1': issue(), 'TEAM-2': issue('done'), 'TEAM-3': missing });
  await assert.rejects(applyJira(result(['TEAM-1', 'TEAM-2', 'TEAM-3']), event(), { secret, url, ...mock }), /TEAM-2: Done; TEAM-3: not found or inaccessible/);
});

for (const [name, response] of [
  ['network', () => { throw new Error('secret-token'); }],
  ['authentication', () => new Response('secret-token', { status: 401 })],
  ['permission', () => new Response('secret-token', { status: 403 })],
  ['rate limit', () => new Response('secret-token', { status: 429 })],
  ['timeout', () => { throw new DOMException('secret-token', 'TimeoutError'); }],
  ['HTML 404', () => new Response('<html>secret-token</html>', { status: 404 })],
  ['empty 404', () => new Response(null, { status: 404 })],
  ['routing 404', () => Response.json({ errorMessages: ['route not found'] }, { status: 404 })],
  ['malformed response', () => new Response('secret-token')],
  ['unknown category', () => Response.json(issue('unexpected'))],
]) {
  test(`Jira integration: ${name} falls back without linking unverified issues`, async () => {
    const mock = jira({ 'TEAM-1': response });
    const checked = await applyJira(result(), event(), { secret, url, remoteLinks: 'true', ...mock });
    assert.equal(checked.status, 'passed');
    assert.deepEqual(checked.references, ['TEAM-1']);
    assert.match(checked.reason, /regex-only/);
    assert.doesNotMatch(checked.reason, /secret-token/);
    assert.equal(mock.writes.length, 0);
  });
}

for (const errorFirst of [true, false]) {
  for (const known of ['missing', 'done']) {
    test(`Jira integration: ${known} rejection survives other errors, errorFirst=${errorFirst}`, async () => {
      const mock = jira({
        'ERR-1': () => { throw new Error('secret-token'); },
        'TEAM-1': known === 'missing' ? missing : issue('done'),
      });
      await assert.rejects(applyJira(result(errorFirst ? ['ERR-1', 'TEAM-1'] : ['TEAM-1', 'ERR-1']), event(), { secret, url, ...mock }), /Referenced Jira issues must exist/);
    });
  }
}

test('Jira integration: partial validation falls back and writes only to verified issues after all reads', async () => {
  const references = ['TEAM-1', 'ERR-1', 'TEAM-2'];
  const mock = jira({
    'TEAM-1': issue(),
    'ERR-1': () => new Response('Temporarily unavailable', { status: 503 }),
    'TEAM-2': issue('indeterminate'),
  });
  const requests = [];
  const checked = await applyJira(result(references), event(), {
    secret, url, remoteLinks: 'true', log() {},
    fetchImpl: (requestUrl, options) => {
      requests.push(`${options.method} ${new URL(requestUrl).pathname}`);
      return mock.fetchImpl(requestUrl, options);
    },
  });

  assert.equal(checked.status, 'passed');
  assert.deepEqual(checked.references, references);
  assert.match(checked.reason, /passed regex-only check/);
  assert.match(checked.reason, /Some Jira repository components could not be assigned/);
  assert.match(checked.reason, /Some Jira remote links could not be created/);
  assert.deepEqual(requests, [
    'GET /rest/api/3/issue/TEAM-1',
    'GET /rest/api/3/issue/ERR-1',
    'GET /rest/api/3/issue/TEAM-2',
    'PUT /rest/api/3/issue/TEAM-1',
    'PUT /rest/api/3/issue/TEAM-2',
    'POST /rest/api/3/issue/TEAM-1/remotelink',
    'POST /rest/api/3/issue/TEAM-2/remotelink',
  ]);
});

for (const [name, parent] of [
  ['Done', { key: 'EPIC-1', fields: { status: { statusCategory: { key: 'done' } } } }],
  ['inaccessible', { key: 'EPIC-1' }],
  ['malformed', {}],
]) {
  test(`Jira integration: ${name} parent is ignored and referenced-issue links are still created`, async () => {
    const mock = jira({ 'TEAM-1': issue('new', parent), 'EPIC-1': () => assert.fail('must not fetch parent') });
    const checked = await applyJira(result(), event(), { secret, url, remoteLinks: 'true', ...mock });
    assert.equal(checked.status, 'passed');
    assert.doesNotMatch(checked.reason, /regex-only/);
    assert.deepEqual(mock.reads, ['TEAM-1']);
    assert.deepEqual(mock.writes.map(({ key }) => key), ['TEAM-1']);
  });
}

test('Jira integration: a parent is validated when it is separately referenced in the PR', async () => {
  const mock = jira({ 'TEAM-1': issue('new', { key: 'EPIC-1' }), 'EPIC-1': issue('done') });
  await assert.rejects(applyJira(result(['TEAM-1', 'EPIC-1']), event(), { secret, url, remoteLinks: 'true', ...mock }), /EPIC-1: Done/);
  assert.deepEqual(mock.reads, ['TEAM-1', 'EPIC-1']);
  assert.equal(mock.writes.length, 0);
});

for (const options of [{ secret: 'invalid' }, { url: 'invalid' }, { remoteLinks: 'yes' }]) {
  test(`Jira integration: invalid config falls back (${JSON.stringify(options)})`, async () => {
    const checked = await applyJira(result(), event(), { secret, url, ...options, fetchImpl: () => assert.fail('unexpected request') });
    assert.equal(checked.status, 'passed');
    assert.match(checked.reason, /configuration unavailable/);
  });
}

for (const remoteLinks of ['true', ' true ']) {
  test(`Jira integration: opened links are created only for validated references (links=${JSON.stringify(remoteLinks)})`, async () => {
    const mock = jira({ 'TEAM-1': issue('new', { key: 'EPIC-1' }), 'EPIC-1': issue() });
    const checked = await applyJira(result(), event(), { secret, url, remoteLinks, ...mock });
    assert.match(checked.reason, /PR remote links created/);
    assert.deepEqual(mock.reads, ['TEAM-1']);
    assert.deepEqual(mock.writes.map(({ key }) => key), ['TEAM-1']);
    assert.deepEqual(mock.writes[0].body.object, {
      url: 'https://github.com/org/repo/pull/42', title: 'PR #42: TEAM-1: Fix',
    });
  });
}

test('Jira integration: write failure is nonblocking and other links are still created', async () => {
  const mock = jira({ 'TEAM-1': issue(), 'TEAM-2': issue() }, { write: (key) => key === 'TEAM-1' ? new Response(null, { status: 403 }) : Response.json({ id: 2 }) });
  const checked = await applyJira(result(['TEAM-1', 'TEAM-2']), event(), { secret, url, remoteLinks: 'true', ...mock });
  assert.equal(checked.status, 'passed');
  assert.match(checked.reason, /Some Jira remote links could not be created/);
  assert.equal(mock.writes.length, 2);
});

for (const action of ['edited', 'synchronize', 'reopened', 'labeled', 'unlabeled', 'ready_for_review', 'converted_to_draft']) {
  test(`Jira integration: ${action} validates issues without writing components or links`, async () => {
    const mock = jira();
    const checked = await applyJira(result(), event(action), { secret, url, remoteLinks: 'true', ...mock });
    assert.match(checked.reason, /Referenced Jira issues exist and are outside Done/);
    assert.deepEqual(mock.reads, ['TEAM-1']);
    assert.deepEqual(mock.componentRequests, []);
    assert.deepEqual(mock.writes, []);
    await assert.rejects(applyJira(result(), event(action), {
      secret, url, remoteLinks: 'true', ...jira({ 'TEAM-1': issue('done') }),
    }), /TEAM-1: Done/);
  });
}

for (const merged of [true, false]) {
  for (const remoteLinks of ['true', 'false']) {
    test(`Jira integration: closed event does no work (merged=${merged}, links=${remoteLinks})`, async () => {
      const original = result();
      assert.equal(await applyJira(original, event('closed', merged), {
        secret, url, remoteLinks, fetchImpl: () => assert.fail('unexpected request'),
      }), original);
    });
  }
}
