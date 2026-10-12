import { appendFile, readFile } from 'node:fs/promises';
import { findReferences } from './jira.mjs';
import { applyJira } from './jira-integration.mjs';

/** Check traceability using only the PR event and optional project allowlist. */
export function check(event, { projectKeys = '' } = {}) {
  const pr = event?.pull_request;
  if (!Number.isSafeInteger(pr?.number) || pr.number <= 0) {
    throw new Error('The event must contain a pull request');
  }
  // The PR author matters, not the event sender or the workflow actor.
  if (pr.user?.type === 'Bot' || /\[bot\]$/i.test(pr.user?.login ?? '')) {
    return { status: 'skipped', reason: 'PR author is a bot', references: [] };
  }
  if (pr.labels?.some((label) => label.name?.toLowerCase() === 'no issue reference')) {
    return { status: 'passed', reason: 'PR has the "no issue reference" label', references: [] };
  }
  if (/\b(?:INC|REQ)[0-9]+\b/.test(pr.title ?? '')) {
    return { status: 'passed', reason: 'PR title contains a ServiceNow incident or request reference', references: [] };
  }
  const projects = new Set(projectKeys.trim() ? projectKeys.split(',').map((key) => key.trim()) : []);
  if ([...projects].some((key) => !/^[A-Z][A-Z0-9]{1,254}$/.test(key))) {
    throw new Error('Invalid project-keys: use comma-separated uppercase Jira project keys, each 2–255 letters or digits starting with a letter (e.g. TEAM,OPS)');
  }
  const references = findReferences(`${pr.title ?? ''}\n${pr.head?.ref ?? ''}`)
    .filter((reference) => !projects.size || projects.has(reference.slice(0, reference.indexOf('-'))));
  if (!references.length) {
    const requiredKey = projects.size
      ? `a Jira key from an allowed project (${[...projects].join(', ')})`
      : 'a Jira key (e.g. PROJ-123)';
    throw new Error(`No issue reference found: add ${requiredKey} to the PR title or source branch; add a ServiceNow incident or request reference (e.g. INC123456 or REQ123456) to the PR title; or apply the "no issue reference" label`);
  }
  return {
    status: 'passed',
    reason: 'Jira reference found in PR title or source branch',
    references,
  };
}

export async function run({ env = process.env, log = console.log, fetchImpl = globalThis.fetch } = {}) {
  if (!['pull_request', 'pull_request_target'].includes(env.GITHUB_EVENT_NAME)) {
    throw new Error('This action requires a pull_request or pull_request_target event');
  }
  let data;
  try {
    data = await readFile(env.GITHUB_EVENT_PATH, 'utf8');
  } catch {
    throw new Error('Cannot read GITHUB_EVENT_PATH');
  }
  let event;
  try {
    event = JSON.parse(data);
  } catch {
    throw new Error('Cannot decode pull request event');
  }
  const result = await applyJira(check(event, { projectKeys: env['INPUT_PROJECT-KEYS'] }), event, {
    secret: env['INPUT_JIRA-SECRET'], url: env['INPUT_JIRA-URL'],
    remoteLinks: env['INPUT_JIRA-REMOTE-LINKS'], components: env['INPUT_JIRA-COMPONENTS'], fetchImpl, log,
  });
  const references = JSON.stringify(result.references);
  if (env.GITHUB_OUTPUT) {
    try {
      await appendFile(env.GITHUB_OUTPUT, `result=${result.status}\njira-references=${references}\n`, 'utf8');
    } catch {
      throw new Error('Cannot write GITHUB_OUTPUT');
    }
  }
  log(`${result.status}: ${result.reason}\nJira references: ${references}`);
  return result;
}

export function escapeAnnotation(message) {
  return message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}
