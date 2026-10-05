import { appendFile, readFile } from 'node:fs/promises';
import { findReferences } from './jira.mjs';
import { createJiraLookup } from './jira-api.mjs';

/** Check the PR author and metadata before making any API requests. */
export async function check(event, {
  jiraSecret,
  fetchImpl = globalThis.fetch,
  signal = AbortSignal.timeout(5 * 60_000),
} = {}) {
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
  if (/\bINC[0-9]+\b/.test(pr.title ?? '')) {
    return { status: 'passed', reason: 'PR title contains an incident reference', references: [] };
  }
  // Exemptions above deliberately do not require Jira credentials or availability.
  const references = findReferences(`${pr.title ?? ''}\n${pr.head?.ref ?? ''}`);
  if (!references.length) {
    throw new Error('No issue reference found: add a Jira key (e.g. PROJ-123) to the PR title or source branch; add an incident reference (e.g. INC123456) to the PR title; or apply the "no issue reference" label');
  }
  let fallback = false;
  if (jiraSecret) {
    let lookup;
    try {
      lookup = createJiraLookup(jiraSecret, { fetchImpl, signal });
    } catch {
      fallback = true;
    }
    const rejected = [];
    if (lookup) {
      for (const reference of references) {
        try {
          const status = await lookup(reference);
          if (status !== 'active') rejected.push(`${reference}: ${status}`);
        } catch {
          // An integration failure must not erase another issue's real rejection.
          fallback = true;
        }
      }
    }
    if (rejected.length) {
      throw new Error(`Every referenced Jira issue must exist outside the Done status category (${rejected.join('; ')})`);
    }
    if (!fallback) {
      return { status: 'passed', reason: 'All referenced issues exist in Jira and are outside Done', references };
    }
  }
  return {
    status: 'passed',
    reason: fallback ? 'Jira validation unavailable; passed regex-only check' : 'Jira reference found in PR title or source branch',
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
  const signal = AbortSignal.timeout(5 * 60_000);
  const result = await check(event, { jiraSecret: env['INPUT_JIRA-SECRET'], fetchImpl, signal });
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
