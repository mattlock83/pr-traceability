import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { check, escapeAnnotation, run } from '../src/action.mjs';
import { event, jiraNotFound } from './helpers.mjs';

const jiraSecret = JSON.stringify({
  baseUrl: 'https://example.atlassian.net', email: 'ci@example.com', apiToken: 'secret-token',
});
const jiraIssue = (category) => Response.json({
  fields: { status: { name: 'Custom status', statusCategory: { key: category } } },
});

for (const [name, fields, status, references = []] of [
  ['bot type', { user: { type: 'Bot', login: 'automation' } }, 'skipped'],
  ['bot suffix', { user: { type: 'User', login: 'dependabot[bot]' } }, 'skipped'],
  ['label', { labels: [{ name: 'other' }, { name: 'no issue reference' }] }, 'passed'],
  ['label casing', { labels: [{ name: 'No Issue Reference' }] }, 'passed'],
  ['incident title', { title: 'Fix outage (INC123456)' }, 'passed'],
  ['long incident', { title: 'INC0012345: repair' }, 'passed'],
  ['title keys', { title: 'TEAM-123 and OPS-4' }, 'passed', ['TEAM-123', 'OPS-4']],
  ['branch key', { head: { ref: 'feature/TEAM-123-fix' } }, 'passed', ['TEAM-123']],
  ['deduplicate title and branch', { title: 'TEAM-123', head: { ref: 'TEAM-123-OPS-4' } }, 'passed', ['TEAM-123', 'OPS-4']],
]) {
  test(`check: ${name} requires no API call`, async () => {
    let calls = 0;
    const result = await check(event(fields), { fetchImpl: async () => { calls++; throw new Error('unexpected request'); } });
    assert.equal(calls, 0);
    assert.equal(result.status, status);
    assert.deepEqual(result.references, references);
  });
}

for (const [name, fields] of [
  ['human named bot', { user: { type: 'User', login: 'robot' } }],
  ['bot sender does not exempt human author', { user: { type: 'User', login: 'human' } }],
  ['label exact name', { labels: [{ name: 'no issue reference please' }] }],
  ['embedded incident', { title: 'XINC123456 INC123456x' }],
  ['lowercase incident', { title: 'inc123456' }],
  ['incident in source branch', { head: { ref: 'fix/INC123456' } }],
  ['PR body ignored', { body: 'TEAM-123 INC123456 no issue reference' }],
  ['base branch ignored', { base: { ref: 'TEAM-123' } }],
  ['no match', { title: 'Fix' }],
]) {
  test(`check: ${name} fails`, async () => {
    await assert.rejects(check(event(fields)), /No issue reference found/);
  });
}

test('check: missing or invalid PR fails', async () => {
  for (const invalid of [null, {}, event({ number: 0 }), event({ number: '1' }), event({ number: -1 })]) {
    await assert.rejects(check(invalid), /must contain a pull request/);
  }
});

async function environment(t, body = event({ title: 'TEAM-1 and OPS-2' })) {
  const directory = await mkdtemp(join(tmpdir(), 'pr-traceability-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventPath = join(directory, 'event.json');
  const outputPath = join(directory, 'output');
  await writeFile(eventPath, JSON.stringify(body));
  await writeFile(outputPath, 'previous=value\n');
  return { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath };
}

test('run: appends action outputs and logs the result without a GitHub token', async (t) => {
  const env = await environment(t);
  const logs = [];
  await run({ env, log: (text) => logs.push(text) });
  assert.equal(await readFile(env.GITHUB_OUTPUT, 'utf8'), 'previous=value\nresult=passed\njira-references=["TEAM-1","OPS-2"]\n');
  assert.match(logs[0], /passed: Jira reference found/);
});

for (const secret of [undefined, jiraSecret, 'malformed secret']) {
  test(`run: commit-only references fail without any API lookup (secret=${Boolean(secret)})`, async (t) => {
    const body = event({ title: 'Fix login', head: { ref: 'feature/login' } });
    body.commits = [{ message: 'TEAM-123: fix INC123456' }];
    body.head_commit = { message: 'OPS-456' };
    const env = await environment(t, body);
    if (secret) env['INPUT_JIRA-SECRET'] = secret;
    let calls = 0;
    await assert.rejects(run({
      env, fetchImpl: async () => { calls++; return jiraIssue('new'); },
    }), /No issue reference found: add a Jira key \(e.g. PROJ-123\) to the PR title or source branch;/);
    assert.equal(calls, 0);
    assert.equal(await readFile(env.GITHUB_OUTPUT, 'utf8'), 'previous=value\n');
  });
}

test('run: supports pull_request_target and missing output file variable', async (t) => {
  const env = await environment(t, event({ title: 'INC123456' }));
  env.GITHUB_EVENT_NAME = 'pull_request_target';
  delete env.GITHUB_OUTPUT;
  assert.equal((await run({ env, log() {} })).status, 'passed');
});

test('run: input and output failures are actionable', async (t) => {
  const env = await environment(t);
  await assert.rejects(run({ env: { ...env, GITHUB_EVENT_NAME: 'push' } }), /requires a pull_request/);
  await assert.rejects(run({ env: { ...env, GITHUB_EVENT_PATH: `${env.GITHUB_EVENT_PATH}.missing` } }), /Cannot read GITHUB_EVENT_PATH/);
  await assert.rejects(run({ env: { ...env, GITHUB_OUTPUT: join(env.GITHUB_OUTPUT, 'missing', 'output') } }), /Cannot write GITHUB_OUTPUT/);
  await writeFile(env.GITHUB_EVENT_PATH, '{');
  await assert.rejects(run({ env }), /Cannot decode pull request event/);
});

test('annotation escaping prevents injected workflow commands', () => {
  assert.equal(escapeAnnotation('bad%\r\n::warning::injected'), 'bad%25%0D%0A::warning::injected');
});

for (const fields of [{ title: 'TEAM-1' }, { head: { ref: 'feature/TEAM-1-fix' } }]) {
  test(`Jira validation: title/branch passes with a non-Done issue (${JSON.stringify(fields)})`, async () => {
    const result = await check(event(fields), { jiraSecret, fetchImpl: async () => jiraIssue('new') });
    assert.equal(result.status, 'passed');
    assert.deepEqual(result.references, ['TEAM-1']);
    assert.match(result.reason, /All referenced issues exist in Jira and are outside Done/);
  });
}

test('Jira validation: active issues do not excuse Done or missing issues across title and branch', async () => {
  const calls = [];
  await assert.rejects(check(event({ title: 'TEAM-1 TEAM-2', head: { ref: 'TEAM-3-TEAM-4' } }), {
    jiraSecret,
    fetchImpl: async (url) => {
      const key = /issue\/([^?]+)/.exec(url)[1];
      calls.push(key);
      if (key === 'TEAM-2') return jiraIssue('done');
      if (key === 'TEAM-3') return jiraNotFound();
      return jiraIssue('indeterminate');
    },
  }), /Every referenced Jira issue must exist outside the Done status category \(TEAM-2: Done; TEAM-3: not found or inaccessible\)/);
  assert.deepEqual(calls, ['TEAM-1', 'TEAM-2', 'TEAM-3', 'TEAM-4']);
});

for (const fields of [{ user: { type: 'Bot' } }, { title: 'INC123456' }, { labels: [{ name: 'no issue reference' }] }]) {
  test(`Jira validation: exemption bypasses even malformed secrets (${JSON.stringify(fields)})`, async () => {
    const result = await check(event(fields), {
      jiraSecret: 'malformed secret', fetchImpl: async () => assert.fail('should not read Jira'),
    });
    assert.deepEqual(result.references, []);
  });
}

test('run: empty Jira secret keeps regex-only behavior', async (t) => {
  const env = await environment(t);
  env['INPUT_JIRA-SECRET'] = '';
  const result = await run({ env, log() {}, fetchImpl: async () => assert.fail('should not fetch') });
  assert.deepEqual(result.references, ['TEAM-1', 'OPS-2']);
});

test('run: Jira validates all distinct title/branch keys and ignores commit keys', async (t) => {
  const body = event({ title: 'TEAM-1 TEAM-2', head: { ref: 'feature/TEAM-1-TEAM-3' } });
  body.commits = [{ message: 'DONE-1' }];
  const env = await environment(t, body);
  env['INPUT_JIRA-SECRET'] = jiraSecret;
  const requests = [];
  const result = await run({
    env, log() {},
    fetchImpl: async (url, options) => {
      requests.push({ url, authorization: options.headers.Authorization });
      return jiraIssue(url.includes('TEAM-1') ? 'new' : 'indeterminate');
    },
  });
  assert.deepEqual(requests.map(({ url }) => url), ['TEAM-1', 'TEAM-2', 'TEAM-3'].map((key) =>
    `https://example.atlassian.net/rest/api/3/issue/${key}?fields=status`));
  for (const request of requests) assert.match(request.authorization, /^Basic /);
  assert.deepEqual(result.references, ['TEAM-1', 'TEAM-2', 'TEAM-3']);
  assert.match(result.reason, /All referenced issues.*outside Done/);
  assert.equal(await readFile(env.GITHUB_OUTPUT, 'utf8'), 'previous=value\nresult=passed\njira-references=["TEAM-1","TEAM-2","TEAM-3"]\n');
});

for (const invalid of ['done', 'missing']) {
  test(`run: ${invalid} branch issue fails despite an active title`, async (t) => {
    const env = await environment(t, event({ title: 'TEAM-1', head: { ref: 'TEAM-2' } }));
    env['INPUT_JIRA-SECRET'] = jiraSecret;
    await assert.rejects(run({
      env, log: () => assert.fail('must not report success'),
      fetchImpl: async (url) => {
        if (url.includes('TEAM-1')) return jiraIssue('new');
        return invalid === 'done' ? jiraIssue('done') : jiraNotFound();
      },
    }), /Every referenced Jira issue must exist outside the Done status category \(TEAM-2:/);
    assert.equal(await readFile(env.GITHUB_OUTPUT, 'utf8'), 'previous=value\n');
  });
}

test('run: Jira failure falls back without exposing the secret or claiming validation', async (t) => {
  const env = await environment(t);
  env['INPUT_JIRA-SECRET'] = jiraSecret;
  const logs = [];
  const result = await run({
    env, log: (text) => logs.push(text),
    fetchImpl: async () => new Response('secret-token', { status: 401 }),
  });
  assert.equal(result.status, 'passed');
  assert.match(logs.join('\n'), /regex-only/);
  assert.doesNotMatch(logs.join('\n'), /secret-token|401|All referenced issues/);
  assert.equal(await readFile(env.GITHUB_OUTPUT, 'utf8'), 'previous=value\nresult=passed\njira-references=["TEAM-1","OPS-2"]\n');
});

for (const [name, fetchImpl] of [
  ...[301, 401, 403, 429, 500].map((status) => [`HTTP ${status}`, async () => new Response('secret-token', { status })]),
  ['HTML 404', async () => new Response('<html>secret-token: route not found</html>', { status: 404 })],
  ['empty 404', async () => new Response(null, { status: 404 })],
  ['unrelated JSON 404', async () => Response.json({ message: 'secret-token: Not Found' }, { status: 404 })],
  ['Jira routing 404', async () => Response.json({ errorMessages: ['secret-token: route not found'], errors: {} }, { status: 404 })],
  ['network error', async () => { throw new Error('secret-token'); }],
  ['timeout', async () => { throw new DOMException('secret-token', 'TimeoutError'); }],
  ['malformed JSON', async () => new Response('secret-token')],
  ['missing status', async () => Response.json({})],
  ['unknown category', async () => jiraIssue('unknown')],
]) {
  test(`Jira fallback: ${name} uses the regex reference`, async () => {
    const result = await check(event({ title: 'TEAM-1' }), { jiraSecret, fetchImpl });
    assert.equal(result.status, 'passed');
    assert.match(result.reason, /regex-only/);
    assert.deepEqual(result.references, ['TEAM-1']);
  });
}

test('Jira fallback: invalid secret uses title/branch matches but cannot pass without a reference', async () => {
  const options = { jiraSecret: 'secret-token', fetchImpl: async () => assert.fail('should not fetch Jira') };
  for (const fields of [{ title: 'TEAM-1' }, { head: { ref: 'TEAM-1' } }]) {
    const result = await check(event(fields), options);
    assert.deepEqual(result.references, ['TEAM-1']);
    assert.match(result.reason, /regex-only/);
  }
  await assert.rejects(check(event(), options), /No issue reference found/);
});

for (const invalid of ['done', 'missing']) {
  for (const errorFirst of [true, false]) {
    test(`Jira fallback: ${invalid} still fails when another lookup errors, errorFirst=${errorFirst}`, async () => {
      await assert.rejects(check(event({ title: errorFirst ? 'ERR-1 TEAM-1' : 'TEAM-1 ERR-1' }), {
        jiraSecret,
        fetchImpl: async (url) => {
          if (url.includes('ERR-1')) throw new Error('secret-token');
          return invalid === 'done' ? jiraIssue('done') : jiraNotFound();
        },
      }), /Every referenced Jira issue must exist outside the Done status category \(TEAM-1:/);
    });
  }
}

for (const invalid of ['done', 'missing']) {
  for (const errorFirst of [true, false]) {
    test(`Jira fallback: unrecognized 404 cannot hide ${invalid}, errorFirst=${errorFirst}`, async () => {
      await assert.rejects(check(event({ title: errorFirst ? 'ERR-1 TEAM-1' : 'TEAM-1 ERR-1' }), {
        jiraSecret,
        fetchImpl: async (url) => {
          if (url.includes('ERR-1')) return new Response('<html>secret-token</html>', { status: 404 });
          return invalid === 'done' ? jiraIssue('done') : jiraNotFound();
        },
      }), new RegExp(`^Error: Every referenced Jira issue must exist outside the Done status category \\(TEAM-1: ${invalid === 'done' ? 'Done' : 'not found or inaccessible'}\\)$`));
    });
  }
}

for (const [name, body, eventName, status, text] of [
  ['pass', event({ title: 'TEAM-123' }), 'pull_request', 0, /passed:/],
  ['skip bot', event({ user: { type: 'Bot' } }), 'pull_request', 0, /skipped:/],
  ['missing reference', event(), 'pull_request', 1, /::error::No issue reference found/],
  ['unsupported event', {}, 'push', 1, /::error::.*requires a pull_request/],
]) {
  test(`entry point: ${name}`, async (t) => {
    const env = await environment(t, body);
    const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GITHUB_|INPUT_)/i.test(key)));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/index.mjs', import.meta.url))], {
      env: { ...baseEnv, ...env, GITHUB_EVENT_NAME: eventName },
      encoding: 'utf8', timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, status, result.stderr);
    assert.match(result.stdout, text);
    assert.equal(result.stderr, '');
    const output = await readFile(env.GITHUB_OUTPUT, 'utf8');
    if (status === 1) assert.equal(output, 'previous=value\n');
    if (name === 'skip bot') assert.match(output, /result=skipped\njira-references=\[\]/);
  });
}
