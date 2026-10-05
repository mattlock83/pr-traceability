import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { check, escapeAnnotation, run } from '../src/action.mjs';
import { event } from './helpers.mjs';

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
  test(`check: ${name}`, () => {
    const result = check(event(fields));
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
  test(`check: ${name} fails`, () => {
    assert.throws(() => check(event(fields)), /No issue reference found/);
  });
}

test('check: missing or invalid PR fails', () => {
  for (const invalid of [null, {}, event({ number: 0 }), event({ number: '1' }), event({ number: -1 })]) {
    assert.throws(() => check(invalid), /must contain a pull request/);
  }
});

for (const projectKeys of ['', ' \t\n', 'TEAM', 'TEAM,OPS', ' TEAM , OPS , TEAM ']) {
  test(`project-keys: allowed title reference (${JSON.stringify(projectKeys)})`, () => {
    assert.deepEqual(check(event({ title: 'TEAM-123' }), { projectKeys }).references, ['TEAM-123']);
  });
}

test('project-keys: combines title and branch, filters other projects, and deduplicates', () => {
  const result = check(event({ title: 'OTHER-1 OPS-2 TEAM-3', head: { ref: 'feature/TEAM-3-OPS-4-OTHER-5' } }), {
    projectKeys: 'TEAM,OPS',
  });
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.references, ['OPS-2', 'TEAM-3', 'OPS-4']);
});

test('project-keys: allowed branch reference passes despite an unrelated title reference', () => {
  const result = check(event({ title: 'OTHER-1', head: { ref: 'feature/TEAM-2-fix' } }), { projectKeys: 'TEAM' });
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.references, ['TEAM-2']);
});

for (const title of ['OTHER-1', 'TE-1', 'TEAM2-1', 'XTEAM-1', 'team-1', 'TEAM-01', 'No reference']) {
  test(`project-keys: ${title} cannot satisfy TEAM`, () => {
    assert.throws(() => check(event({ title }), { projectKeys: 'TEAM' }), /allowed project \(TEAM\)/);
  });
}

for (const projectKeys of ['A2', 'AB', 'A'.repeat(255)]) {
  test(`project-keys: accepts valid ${projectKeys.length}-character project`, () => {
    const reference = `${projectKeys}-1`;
    assert.deepEqual(check(event({ title: reference }), { projectKeys }).references, [reference]);
  });
}

for (const projectKeys of [
  'A', 'A'.repeat(256), 'team', '2TEAM', 'MY_TEAM', 'TEAM-1', 'TÉAM',
  'TEAM.*', 'TEAM|OPS', '*', 'TEAM OPS', 'TEAM\nOPS',
  ',', ',TEAM', 'TEAM,', 'TEAM,,OPS', 'TEAM, ,OPS', 'TEAM,ops',
]) {
  test(`project-keys: rejects invalid configuration ${JSON.stringify(projectKeys)}`, () => {
    assert.throws(() => check(event({ title: 'TEAM-1' }), { projectKeys }), /Invalid project-keys/);
  });
}

for (const [fields, status] of [
  [{ user: { type: 'Bot' } }, 'skipped'],
  [{ title: 'INC123456' }, 'passed'],
  [{ labels: [{ name: 'no issue reference' }] }, 'passed'],
]) {
  test(`project-keys: exemption takes precedence (${JSON.stringify(fields)})`, () => {
    for (const projectKeys of ['TEAM', 'invalid']) {
      const result = check(event({ title: 'OTHER-1', ...fields }), { projectKeys });
      assert.equal(result.status, status);
      assert.deepEqual(result.references, []);
    }
  });
}

async function environment(t, body = event({ title: 'TEAM-1 and OPS-2' })) {
  const directory = await mkdtemp(join(tmpdir(), 'pr-traceability-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventPath = join(directory, 'event.json');
  const outputPath = join(directory, 'output');
  await writeFile(eventPath, JSON.stringify(body));
  await writeFile(outputPath, 'previous=value\n');
  return { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath };
}

test('run: appends action outputs and logs the result without network access', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('unexpected network request'));
  const env = await environment(t);
  const logs = [];
  await run({ env, log: (text) => logs.push(text) });
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(await readFile(env.GITHUB_OUTPUT, 'utf8'), 'previous=value\nresult=passed\njira-references=["TEAM-1","OPS-2"]\n');
  assert.match(logs[0], /passed: Jira reference found/);
});

test('run: project-keys input filters action outputs', async (t) => {
  const env = await environment(t);
  env['INPUT_PROJECT-KEYS'] = 'OPS';
  const result = await run({ env, log() {} });
  assert.deepEqual(result.references, ['OPS-2']);
  assert.equal(await readFile(env.GITHUB_OUTPUT, 'utf8'), 'previous=value\nresult=passed\njira-references=["OPS-2"]\n');
});

for (const [projectKeys, error] of [['OTHER', /allowed project \(OTHER\)/], ['TEAM,', /Invalid project-keys/]]) {
  test(`run: failure writes no outputs (${projectKeys})`, async (t) => {
    const env = await environment(t);
    env['INPUT_PROJECT-KEYS'] = projectKeys;
    await assert.rejects(run({ env, log: () => assert.fail('must not report success') }), error);
    assert.equal(await readFile(env.GITHUB_OUTPUT, 'utf8'), 'previous=value\n');
  });
}

test('run: commit-only references fail', async (t) => {
  const body = event({ title: 'Fix login', head: { ref: 'feature/login' } });
  body.commits = [{ message: 'TEAM-123: fix INC123456' }];
  body.head_commit = { message: 'OPS-456' };
  const env = await environment(t, body);
  await assert.rejects(run({ env }), /No issue reference found/);
  assert.equal(await readFile(env.GITHUB_OUTPUT, 'utf8'), 'previous=value\n');
});

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

for (const [name, body, eventName, status, text, projectKeys = ''] of [
  ['pass', event({ title: 'TEAM-123' }), 'pull_request', 0, /passed:/],
  ['skip bot', event({ user: { type: 'Bot' } }), 'pull_request', 0, /skipped:/],
  ['missing reference', event(), 'pull_request', 1, /::error::No issue reference found/],
  ['unsupported event', {}, 'push', 1, /::error::.*requires a pull_request/],
  ['allowed project', event({ title: 'TEAM-123' }), 'pull_request', 0, /passed:/, 'TEAM'],
  ['unlisted project', event({ title: 'OTHER-123' }), 'pull_request', 1, /::error::.*allowed project \(TEAM\)/, 'TEAM'],
  ['invalid projects', event({ title: 'TEAM-123' }), 'pull_request', 1, /::error::Invalid project-keys/, 'TEAM,'],
]) {
  test(`entry point: ${name}`, async (t) => {
    const env = await environment(t, body);
    const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GITHUB_|INPUT_)/i.test(key)));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/index.mjs', import.meta.url))], {
      env: { ...baseEnv, ...env, GITHUB_EVENT_NAME: eventName, 'INPUT_PROJECT-KEYS': projectKeys },
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
