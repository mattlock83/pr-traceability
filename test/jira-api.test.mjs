import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJiraClient } from '../src/jira-api.mjs';

const url = 'https://jira.example.com/jira/';
const secret = JSON.stringify({ email: 'ci@example.com', apiToken: 'secret-token' });
const issue = (key = 'new') => ({ fields: { status: { name: 'Custom status', statusCategory: { key } } } });
const missing = () => Response.json({ errorMessages: ['Issue does not exist or you do not have permission to see it.'], errors: {} }, { status: 404 });

test('Jira client: Cloud v3 email/API-token authentication', async () => {
  const client = createJiraClient({ url, secret, fetchImpl: async (requestUrl, options) => {
    assert.equal(requestUrl, 'https://jira.example.com/jira/rest/api/3/issue/TEAM-1?fields=status,project,components');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, `Basic ${Buffer.from('ci@example.com:secret-token').toString('base64')}`);
    assert.equal(options.headers['Accept-Language'], 'en-US');
    assert.equal(options.headers['X-Force-Accept-Language'], 'true');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json(issue());
  } });
  assert.equal((await client.getIssue('TEAM-1')).fields.status.statusCategory.key, 'new');
});

for (const baseUrl of ['https://example.atlassian.net', 'https://api.atlassian.com/ex/jira/cloud-id']) {
  test(`Jira client: configurable endpoint ${baseUrl}`, async () => {
    const client = createJiraClient({ secret: JSON.stringify({ baseUrl, ...JSON.parse(secret) }), fetchImpl: async (requestUrl) => {
      assert.equal(requestUrl, `${baseUrl}/rest/api/3/issue/TEAM-1?fields=status,project,components`);
      return Response.json(issue());
    } });
    await client.getIssue('TEAM-1');
  });
}

test('Jira client: explicit URL overrides secret baseUrl and issue paths are encoded', async () => {
  const client = createJiraClient({ url, secret: JSON.stringify({ baseUrl: 'https://unused.example', ...JSON.parse(secret) }), fetchImpl: async (requestUrl) => {
    assert.equal(requestUrl, 'https://jira.example.com/jira/rest/api/3/issue/TEAM%2F1%3Fsecret?fields=status,project,components');
    return Response.json(issue());
  } });
  await client.getIssue('TEAM/1?secret');
});

for (const invalid of [
  'not-json', 'null', '{}', JSON.stringify({ token: '' }),
  JSON.stringify({ username: 'bad:name', password: 'secret' }),
  JSON.stringify({ email: 'bad:name', apiToken: 'secret' }),
  JSON.stringify({ email: 'ci@example.com', apiToken: ' ' }),
  JSON.stringify({ token: 'secret-token' }),
  JSON.stringify({ username: 'ci', password: 'secret' }),
]) {
  test(`Jira client: invalid credentials sanitized (${invalid.length})`, () => {
    assert.throws(() => createJiraClient({ url, secret: invalid }), /^Error: Invalid Jira URL or credentials$/);
  });
}

for (const invalid of ['', 'not-a-url', 'http://jira.internal:8080/jira', 'file:///tmp/jira', 'https://user:secret@example.com', 'https://example.com?secret', 'https://example.com#secret']) {
  test(`Jira client: rejects invalid URL ${invalid}`, () => {
    assert.throws(() => createJiraClient({ url: invalid, secret }), /^Error: Invalid Jira URL or credentials$/);
  });
}

for (const category of ['new', 'indeterminate', 'done']) {
  test(`Jira client: reads ${category} status category`, async () => {
    const client = createJiraClient({ url, secret, fetchImpl: async () => Response.json(issue(category)) });
    assert.equal((await client.getIssue('TEAM-1')).fields.status.statusCategory.key, category);
  });
}

test('Jira client: recognized 404 reports missing', async () => {
  const client = createJiraClient({ url, secret, fetchImpl: async () => missing() });
  assert.equal(await client.getIssue('TEAM-1'), null);
});


for (const body of ['', '<html>secret-token</html>', '{', 'null', '{}', '{"errorMessages":"Issue does not exist or you do not have permission to see it."}', '{"errorMessages":["route not found"]}']) {
  test(`Jira client: unrecognized 404 is an integration error (${body})`, async () => {
    const client = createJiraClient({ url, secret, fetchImpl: async () => new Response(body, { status: 404 }) });
    await assert.rejects(client.getIssue('TEAM-1'), (error) => !error.message.includes('secret-token'));
  });
}

for (const status of [301, 302, 401, 403, 429, 500]) {
  test(`Jira client: HTTP ${status} is sanitized`, async () => {
    const client = createJiraClient({ url, secret, fetchImpl: async () => new Response('secret-token', { status }) });
    await assert.rejects(client.getIssue('TEAM-1'), /^Error: Jira request failed or returned an invalid response$/);
  });
}

for (const body of [null, {}, issue('unexpected')]) {
  test(`Jira client: malformed issue response ${JSON.stringify(body)}`, async () => {
    const client = createJiraClient({ url, secret, fetchImpl: async () => Response.json(body) });
    await assert.rejects(client.getIssue('TEAM-1'), /missing a recognized status category/);
  });
}

test('Jira client: transport and body read failures are sanitized', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('secret-token'); },
    async () => new Response('secret-token'),
    async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('secret-token')); } })),
  ]) {
    await assert.rejects(createJiraClient({ url, secret, fetchImpl }).getIssue('TEAM-1'), /^Error: Jira request failed or returned an invalid response$/);
  }
});

for (const status of [302, 401, 403, 404, 429, 500, 200]) {
  test(`Jira client: logs failed response bodies without headers (HTTP ${status})`, async () => {
    const logs = [];
    const client = createJiraClient({ url, secret, log: (message) => logs.push(message), fetchImpl: async () =>
      new Response('Upstream diagnostic\n::error::plain text', {
        status, headers: { 'X-Private-Header': 'must-not-appear' },
      }),
    });
    await assert.rejects(client.getIssue('TEAM-1'));
    assert.equal(logs.length, 1);
    assert.equal(logs[0], `Jira GET /issue/TEAM-1?fields=status,project,components: ${status}; body: ${JSON.stringify('Upstream diagnostic\n::error::plain text')}`);
    assert.doesNotMatch(logs[0], /Authorization|Accept|X-Private-Header|must-not-appear|[\r\n]/);
  });
}

test('Jira client: recognized 404 logs its body and still reports a missing issue', async () => {
  const logs = [];
  const client = createJiraClient({ url, secret, log: (message) => logs.push(message), fetchImpl: async () => missing() });
  assert.equal(await client.getIssue('TEAM-1'), null);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /404.*Issue does not exist/);
});

test('Jira client: redacts echoed credentials while preserving diagnostic text', async () => {
  const logs = [];
  const encoded = Buffer.from('ci@example.com:secret-token').toString('base64');
  const client = createJiraClient({ url, secret, log: (message) => logs.push(message), fetchImpl: async () =>
    new Response(`Denied: secret-token ci@example.com Basic ${encoded} ${secret}`, { status: 401 }),
  });
  await assert.rejects(client.getIssue('TEAM-1'));
  assert.match(logs[0], /Denied: \[REDACTED\]/);
  for (const value of [secret, encoded, 'secret-token', 'ci@example.com']) assert.ok(!logs[0].includes(value));
});

test('Jira client: transport errors log no raw exception or headers', async () => {
  const logs = [];
  const client = createJiraClient({ url, secret, log: (message) => logs.push(message), fetchImpl: async () => {
    throw new Error('Authorization: secret-token; X-Private: hidden');
  } });
  await assert.rejects(client.getIssue('TEAM-1'));
  assert.deepEqual(logs, ['Jira GET /issue/TEAM-1?fields=status,project,components: request failed; body: "Response body unavailable"']);
});

test('Jira client: successful responses are not logged', async () => {
  const logs = [];
  const client = createJiraClient({ url, secret, log: (message) => logs.push(message), fetchImpl: async () => Response.json(issue()) });
  await client.getIssue('TEAM-1');
  assert.deepEqual(logs, []);
});

test('Jira client: remote-link write failures include the response body', async () => {
  const logs = [];
  const client = createJiraClient({ url, secret, log: (message) => logs.push(message), fetchImpl: async () =>
    Response.json({ errorMessages: ['Issue linking is disabled'] }, { status: 403 }),
  });
  await assert.rejects(client.upsertPullRequestLink('TEAM-1', { html_url: 'https://github.com/org/repo/pull/42', number: 42, title: 'Fix' }));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /POST \/issue\/TEAM-1\/remotelink: 403.*Issue linking is disabled/);
});

test('Jira client: cancels an in-flight request using the shared deadline', async () => {
  const controller = new AbortController();
  const client = createJiraClient({ url, secret, signal: controller.signal, fetchImpl: async (_, { signal }) => {
    return new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      controller.abort(new Error('secret-token'));
    });
  } });
  await assert.rejects(client.getIssue('TEAM-1'), /^Error: Jira request failed or returned an invalid response$/);
});

test('Jira client: remote link creation has a stable identity and plain title across reruns', async () => {
  const requests = [];
  const client = createJiraClient({ url, secret, fetchImpl: async (requestUrl, options) => {
    assert.equal(requestUrl, 'https://jira.example.com/jira/rest/api/3/issue/TEAM-1/remotelink');
    assert.equal(options.method, 'POST');
    requests.push(JSON.parse(options.body));
    return Response.json({ id: 123 }, { status: requests.length === 1 ? 201 : 200 });
  } });
  const pr = { html_url: 'https://github.example.com/org/repo/pull/42', number: 42, title: 'TEAM-1: Fix login', merged: false };
  await client.upsertPullRequestLink('TEAM-1', pr);
  await client.upsertPullRequestLink('TEAM-1', pr);
  await client.upsertPullRequestLink('TEAM-1', { ...pr, merged: true });
  await client.upsertPullRequestLink('TEAM-1', { ...pr, title: 'Updated title', merged: true });
  assert.equal(new Set(requests.map((body) => body.globalId)).size, 1);
  assert.equal(requests[0].globalId, 'org/repo/42');
  assert.equal(requests[0].object.url, pr.html_url);
  assert.equal(requests[0].object.title, 'PR #42: TEAM-1: Fix login');
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(requests[2], requests[0]);
  assert.equal(requests[3].object.title, 'PR #42: Updated title');
  for (const request of requests) assert.ok(!Object.hasOwn(request.object, 'status'));
});

test('Jira client: invalid PR links and remote link responses are rejected', async () => {
  const client = createJiraClient({ url, secret, fetchImpl: async () => Response.json({}) });
  for (const pr of [{}, { html_url: 'file:///tmp/pr' }, { html_url: 'https://github.com/repo/pull/1', number: 1 }]) {
    await assert.rejects(client.upsertPullRequestLink('TEAM-1', pr));
  }
  for (const html_url of ['https://github.com/org/repo/issues/1', 'https://github.com/org/repo/pull/2']) {
    await assert.rejects(client.upsertPullRequestLink('TEAM-1', { html_url, number: 1, title: 'Fix' }), /Invalid pull request link/);
  }
  await assert.rejects(client.upsertPullRequestLink('TEAM-1', { html_url: 'https://github.com/org/repo/pull/1', number: 1, title: 'Fix' }), /Invalid Jira remote link response/);
});

test('Jira client: remote link identities distinguish organizations, repositories, and PR numbers', async () => {
  const identities = [];
  const client = createJiraClient({ url, secret, fetchImpl: async (_, options) => {
    identities.push(JSON.parse(options.body).globalId);
    return Response.json({ id: 1 });
  } });
  for (const [organization, repository, number] of [['org', 'repo', 42], ['other', 'repo', 42], ['org', 'other', 42], ['org', 'repo', 43]]) {
    await client.upsertPullRequestLink('TEAM-1', { html_url: `https://github.com/${organization}/${repository}/pull/${number}`, number, title: 'Fix' });
  }
  assert.deepEqual(identities, ['org/repo/42', 'other/repo/42', 'org/other/42', 'org/repo/43']);
});
