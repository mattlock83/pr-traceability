import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyJira } from '../src/jira-integration.mjs';

const secret = JSON.stringify({ email: 'ci@example.com', apiToken: 'secret-token' });
const url = 'https://jira.example.com';
const event = (action = 'opened', merged = false) => ({ action, pull_request: {
  number: 42, title: 'TEAM-1: Fix', html_url: 'https://github.com/org/repo/pull/42', merged,
} });
const result = (references = ['TEAM-1']) => ({ status: 'passed', reason: 'Jira reference found', references });
const issue = (category = 'new', parent) => ({ fields: { status: { statusCategory: { key: category } }, parent } });
const missing = () => Response.json({ errorMessages: ['Issue does not exist or you do not have permission to see it.'] }, { status: 404 });

function jira(issues = { 'TEAM-1': issue() }, { write } = {}) {
  const reads = [];
  const writes = [];
  const fetchImpl = async (requestUrl, options) => {
    const path = new URL(requestUrl).pathname;
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
  return { fetchImpl, reads, writes };
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

test('Jira integration: every referenced issue and its immediate parent are checked', async () => {
  const mock = jira({
    'TEAM-1': issue('new', { key: 'EPIC-1' }),
    'OPS-2': issue('indeterminate', { key: 'EPIC-1' }),
    'EPIC-1': issue('new', { key: 'GRANDPARENT-1' }),
  });
  const checked = await applyJira(result(['TEAM-1', 'OPS-2']), event(), { secret, url, ...mock });
  assert.equal(checked.status, 'passed');
  assert.match(checked.reason, /parents are outside Done/);
  assert.deepEqual(mock.reads, ['TEAM-1', 'EPIC-1', 'OPS-2']);
  assert.equal(mock.writes.length, 0);
});

test('Jira integration: no parent is valid', async () => {
  const checked = await applyJira(result(), event(), { secret, url, ...jira() });
  assert.match(checked.reason, /parents are outside Done/);
});

for (const [name, issues, message] of [
  ['missing issue', { 'TEAM-1': missing }, /TEAM-1: not found or inaccessible/],
  ['Done issue', { 'TEAM-1': issue('done') }, /TEAM-1: Done/],
  ['Done parent', { 'TEAM-1': issue('new', { key: 'EPIC-1' }), 'EPIC-1': issue('done') }, /parent EPIC-1 is Done/],
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
  for (const known of ['missing', 'done', 'parent']) {
    test(`Jira integration: ${known} rejection survives other errors, errorFirst=${errorFirst}`, async () => {
      const mock = jira({
        'ERR-1': () => { throw new Error('secret-token'); },
        'TEAM-1': known === 'missing' ? missing : issue(known === 'done' ? 'done' : 'new', { key: 'EPIC-1' }),
        'EPIC-1': known === 'parent' ? issue('done') : () => { throw new Error('secret-token'); },
      });
      await assert.rejects(applyJira(result(errorFirst ? ['ERR-1', 'TEAM-1'] : ['TEAM-1', 'ERR-1']), event(), { secret, url, ...mock }), /Referenced Jira issues must exist/);
    });
  }
}

test('Jira integration: parent outages fall back and suppress link writes for that issue', async () => {
  const mock = jira({ 'TEAM-1': issue('new', { key: 'EPIC-1' }), 'EPIC-1': () => new Response(null, { status: 503 }) });
  const checked = await applyJira(result(), event(), { secret, url, remoteLinks: 'true', ...mock });
  assert.match(checked.reason, /regex-only/);
  assert.equal(mock.writes.length, 0);
});

test('Jira integration: an inaccessible parent falls back instead of failing existence validation', async () => {
  const mock = jira({ 'TEAM-1': issue('new', { key: 'EPIC-1' }), 'EPIC-1': missing });
  const checked = await applyJira(result(), event(), { secret, url, remoteLinks: 'true', ...mock });
  assert.equal(checked.status, 'passed');
  assert.match(checked.reason, /regex-only/);
  assert.equal(mock.writes.length, 0);
});

test('Jira integration: an inaccessible parent cannot hide a Done referenced issue', async () => {
  const mock = jira({ 'TEAM-1': issue('done', { key: 'EPIC-1' }), 'EPIC-1': missing });
  await assert.rejects(applyJira(result(), event(), { secret, url, ...mock }), /TEAM-1: Done/);
});

test('Jira integration: malformed parent falls back without masking a Done issue', async () => {
  const checked = await applyJira(result(), event(), { secret, url, ...jira({ 'TEAM-1': issue('new', {}) }) });
  assert.match(checked.reason, /regex-only/);
  await assert.rejects(applyJira(result(), event(), { secret, url, ...jira({ 'TEAM-1': issue('done', {}) }) }), /TEAM-1: Done/);
});

test('Jira integration: a parent ID can be used when its key is absent', async () => {
  const mock = jira({ 'TEAM-1': issue('new', { id: '123' }), '123': issue('done') });
  await assert.rejects(applyJira(result(), event(), { secret, url, ...mock }), /TEAM-1: parent 123 is Done/);
});

for (const options of [{ secret: 'invalid' }, { url: 'invalid' }, { remoteLinks: 'yes' }]) {
  test(`Jira integration: invalid config falls back (${JSON.stringify(options)})`, async () => {
    const checked = await applyJira(result(), event(), { secret, url, ...options, fetchImpl: () => assert.fail('unexpected request') });
    assert.equal(checked.status, 'passed');
    assert.match(checked.reason, /configuration unavailable/);
  });
}

test('Jira integration: enabled links are written only to referenced issues after validation', async () => {
  const mock = jira({ 'TEAM-1': issue('new', { key: 'EPIC-1' }), 'EPIC-1': issue() });
  const checked = await applyJira(result(), event(), { secret, url, remoteLinks: 'true', ...mock });
  assert.match(checked.reason, /PR remote links updated/);
  assert.deepEqual(mock.writes.map(({ key }) => key), ['TEAM-1']);
  assert.equal(mock.writes[0].body.object.status.resolved, false);
});

test('Jira integration: write failure is nonblocking and other links still update', async () => {
  const mock = jira({ 'TEAM-1': issue(), 'TEAM-2': issue() }, { write: (key) => key === 'TEAM-1' ? new Response(null, { status: 403 }) : Response.json({ id: 2 }) });
  const checked = await applyJira(result(['TEAM-1', 'TEAM-2']), event(), { secret, url, remoteLinks: 'true', ...mock });
  assert.equal(checked.status, 'passed');
  assert.match(checked.reason, /Some Jira remote links could not be updated/);
  assert.equal(mock.writes.length, 2);
});

test('Jira integration: merged PR updates links without revalidating Done issues or parents', async () => {
  const mock = jira({ 'TEAM-1': issue('done') });
  const checked = await applyJira(result(), event('closed', true), { secret, url, remoteLinks: 'true', ...mock });
  assert.equal(checked.status, 'passed');
  assert.match(checked.reason, /PR merged/);
  assert.deepEqual(mock.reads, []);
  assert.equal(mock.writes[0].body.object.status.resolved, true);
  assert.equal(mock.writes[0].body.object.title, 'PR #42: TEAM-1: Fix [Merged]');
});

for (const [prEvent, remoteLinks] of [[event('closed', false), 'true'], [event('closed', true), 'false']]) {
  test(`Jira integration: closed event does no work (merged=${prEvent.pull_request.merged}, links=${remoteLinks})`, async () => {
    const original = result();
    assert.equal(await applyJira(original, prEvent, { secret, url, remoteLinks, fetchImpl: () => assert.fail('unexpected request') }), original);
  });
}
