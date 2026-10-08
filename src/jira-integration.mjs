import { createJiraClient } from './jira-api.mjs';

/** Enrich a successful regex result; integration outages must not block a PR. */
export async function applyJira(result, event, {
  secret, url, remoteLinks = '', fetchImpl = globalThis.fetch, signal, log = console.log,
} = {}) {
  if (!result.references.length || !secret?.trim() || event.action === 'closed') return result;
  let jira;
  let linksEnabled;
  try {
    const links = remoteLinks.trim();
    if (!['', 'true', 'false'].includes(links)) throw new Error();
    linksEnabled = links === 'true';
    jira = createJiraClient({ secret, url, fetchImpl, signal, log });
  } catch {
    return { ...result, reason: `${result.reason}; Jira configuration unavailable, using regex only` };
  }

  const rejected = [];
  const verified = [];
  let unavailable = false;
  for (const reference of result.references) {
    try {
      const issue = await jira.getIssue(reference);
      if (!issue) {
        rejected.push(`${reference}: not found or inaccessible`);
        continue;
      }
      if (issue.fields.status.statusCategory.key === 'done') rejected.push(`${reference}: Done`);
      else verified.push({ reference, issue });
    } catch {
      unavailable = true;
    }
  }
  if (rejected.length) {
    throw new Error(`Referenced Jira issues must exist and be outside the Done status category (${rejected.join('; ')})`);
  }

  const reasons = [unavailable
    ? 'Jira validation unavailable; passed regex-only check'
    : 'Referenced Jira issues exist and are outside Done'];
  if (event.action === 'opened') {
    const repository = event.repository?.full_name;
    const validRepository = typeof repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository);
    let failed = unavailable || !validRepository;
    if (validRepository) {
      for (const { reference, issue } of verified) {
        try {
          await jira.assignRepositoryComponent(reference, issue, repository);
        } catch {
          failed = true;
        }
      }
    }
    reasons.push(failed ? 'Some Jira repository components could not be assigned' : 'Jira repository component assigned');
    if (linksEnabled) {
      let failed = unavailable;
      for (const { reference } of verified) {
        try {
          await jira.upsertPullRequestLink(reference, event.pull_request);
        } catch {
          failed = true;
        }
      }
      reasons.push(failed ? 'Some Jira remote links could not be created' : 'Jira PR remote links created');
    }
  }
  return { ...result, reason: reasons.join('; ') };
}
