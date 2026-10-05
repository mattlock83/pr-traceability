import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJiraLookup } from '../src/jira-api.mjs';
import { jiraNotFound } from './helpers.mjs';

const config = { baseUrl: 'https://example.atlassian.net/', email: 'ci@example.com', apiToken: 'secret-token' };
const secret = JSON.stringify(config);
const issue = (key) => ({ fields: { status: { name: 'Custom status', statusCategory: { key } } } });

for (const [category, expected] of [['new', 'active'], ['indeterminate', 'active'], ['done', 'Done']]) {
  test(`Jira API: ${category} uses category key and caches references`, async () => {
    let calls = 0;
    const lookup = createJiraLookup(secret, {
      fetchImpl: async (url, options) => {
        calls++;
        assert.equal(url, 'https://example.atlassian.net/rest/api/3/issue/TEAM-123?fields=status');
        assert.equal(options.method, 'GET');
        assert.equal(options.redirect, 'manual');
        assert.equal(options.headers.Authorization, `Basic ${Buffer.from('ci@example.com:secret-token').toString('base64')}`);
        assert.equal(options.headers.Accept, 'application/json');
        assert.equal(options.headers['Accept-Language'], 'en-US');
        assert.equal(options.headers['X-Force-Accept-Language'], 'true');
        assert.ok(options.signal instanceof AbortSignal);
        return Response.json(issue(category));
      },
    });
    assert.equal(await lookup('TEAM-123'), expected);
    assert.equal(await lookup('TEAM-123'), expected);
    assert.equal(calls, 1);
  });
}

test('Jira API: supports scoped token gateway base paths', async () => {
  const lookup = createJiraLookup(JSON.stringify({ ...config, baseUrl: 'https://api.atlassian.com/ex/jira/cloud-id/' }), {
    fetchImpl: async (url) => {
      assert.equal(url, 'https://api.atlassian.com/ex/jira/cloud-id/rest/api/3/issue/TEAM-1?fields=status');
      return Response.json(issue('new'));
    },
  });
  assert.equal(await lookup('TEAM-1'), 'active');
});

test('Jira API: recognized issue 404 is not found or inaccessible, and is cached', async () => {
  let calls = 0;
  const lookup = createJiraLookup(secret, {
    fetchImpl: async () => { calls++; return jiraNotFound(); },
  });
  assert.equal(await lookup('TEAM-1'), 'not found or inaccessible');
  assert.equal(await lookup('TEAM-1'), 'not found or inaccessible');
  assert.equal(calls, 1);
});

for (const body of [
  '', '<html>secret-token: route not found</html>', '{secret-token', 'null', '{}', '"secret-token"',
  JSON.stringify({ message: 'secret-token: Not Found' }),
  JSON.stringify({ errorMessages: 'Issue does not exist or you do not have permission to see it.' }),
  JSON.stringify({ errorMessages: [], errors: {} }),
  JSON.stringify({ errorMessages: [null, 404, 'secret-token: route not found'], errors: {} }),
]) {
  test(`Jira API: unrecognized 404 is an integration error (${body})`, async () => {
    let calls = 0;
    const lookup = createJiraLookup(secret, {
      fetchImpl: async () => {
        calls++;
        return calls === 1 ? new Response(body, { status: 404 }) : jiraNotFound();
      },
    });
    await assert.rejects(lookup('TEAM-1'), (error) =>
      /invalid response|unrecognized HTTP 404/.test(error.message) && !error.message.includes('secret-token'));
    assert.equal(await lookup('TEAM-1'), 'not found or inaccessible');
    assert.equal(calls, 2, 'unrecognized 404 must not be cached as a missing issue');
  });
}

test('Jira API: recognized issue message on HTTP 500 remains an integration error', async () => {
  const lookup = createJiraLookup(secret, {
    fetchImpl: async () => Response.json(await jiraNotFound().json(), { status: 500 }),
  });
  await assert.rejects(lookup('TEAM-1'), /Jira returned HTTP 500/);
});

for (const status of [301, 302, 401, 403, 429, 500]) {
  test(`Jira API: HTTP ${status} fails without exposing response contents`, async () => {
    const lookup = createJiraLookup(secret, { fetchImpl: async () => new Response('secret-token', { status }) });
    await assert.rejects(lookup('TEAM-1'), (error) => error.message.includes(`HTTP ${status}`) && !error.message.includes('secret-token'));
  });
}

for (const body of [null, {}, { fields: { status: { name: 'In Progress' } } }, issue('unexpected'), issue('')]) {
  test(`Jira API: missing or unknown category fails (${JSON.stringify(body)})`, async () => {
    const lookup = createJiraLookup(secret, { fetchImpl: async () => Response.json(body) });
    await assert.rejects(lookup('TEAM-1'), /missing a recognized issue status category/);
  });
}

test('Jira API: invalid JSON and transport failures are sanitized', async () => {
  await assert.rejects(createJiraLookup(secret, {
    fetchImpl: async () => new Response('secret-token'),
  })('TEAM-1'), /^Error: Jira returned an invalid response$/);
  await assert.rejects(createJiraLookup(secret, {
    fetchImpl: async () => { throw new Error('secret-token'); },
  })('TEAM-1'), /^Error: Jira request failed; check connectivity and the job timeout$/);
});

test('Jira API: shares cancellation with the action', async () => {
  const lookup = createJiraLookup(secret, {
    signal: AbortSignal.abort(),
    fetchImpl: async (url, { signal }) => { assert.equal(signal.aborted, true); signal.throwIfAborted(); },
  });
  await assert.rejects(lookup('TEAM-1'), /Jira request failed/);
});

for (const invalid of [
  'secret-token', 'null', '{}', JSON.stringify({ ...config, apiToken: ' ' }),
  JSON.stringify({ ...config, email: 1 }), JSON.stringify({ ...config, email: 'bad:email' }),
  ...['http://example.com', 'not a URL', 'https://user:secret-token@example.com', 'https://example.com?token=secret-token', 'https://example.com#fragment']
    .map((baseUrl) => JSON.stringify({ ...config, baseUrl })),
]) {
  test(`Jira API: invalid secret ${invalid.length} chars is rejected safely`, () => {
    assert.throws(() => createJiraLookup(invalid), (error) =>
      error.message.startsWith('Invalid jira-secret:') && !error.message.includes('secret-token'));
  });
}
