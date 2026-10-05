import { createJiraClient } from './jira-api.mjs';

/** Enrich a successful regex result; integration outages must not block a PR. */
export async function applyJira(result, event, {
  secret, url, remoteLinks = '', fetchImpl = globalThis.fetch, signal, log = console.log,
} = {}) {
  if (!result.references.length || !secret?.trim()) return result;
  const merged = event.action === 'closed' && event.pull_request.merged === true;
  if (event.action === 'closed' && !merged) return result;
  let jira;
  let linksEnabled;
  try {
    if (!['', 'true', 'false'].includes(remoteLinks.trim())) throw new Error();
    linksEnabled = remoteLinks.trim() === 'true';
    if (merged && !linksEnabled) return result;
    jira = createJiraClient({ secret, url, fetchImpl, signal, log });
  } catch {
    return { ...result, reason: `${result.reason}; Jira configuration unavailable, using regex only` };
  }

  const rejected = [];
  const verified = [];
  let unavailable = false;
  if (!merged) {
    for (const reference of result.references) {
      try {
        const issue = await jira.getIssue(reference);
        if (!issue) {
          rejected.push(`${reference}: not found or inaccessible`);
          continue;
        }
        if (issue.fields.status.statusCategory.key === 'done') rejected.push(`${reference}: Done`);
        const parent = issue.fields.parent;
        if (parent != null) {
          const parentReference = parent.key ?? parent.id;
          if (typeof parentReference !== 'string' || !parentReference.trim()) throw new Error('Invalid Jira parent reference');
          const parentIssue = await jira.getIssue(parentReference);
          // Jira supplied the parent reference; an unreadable status is an integration failure.
          if (!parentIssue) throw new Error('Jira parent status unavailable');
          if (parentIssue.fields.status.statusCategory.key === 'done') rejected.push(`${reference}: parent ${parentReference} is Done`);
        }
        verified.push(reference);
      } catch {
        unavailable = true;
      }
    }
    if (rejected.length) {
      throw new Error(`Referenced Jira issues must exist, and issues and parents must be outside the Done status category (${rejected.join('; ')})`);
    }
  }

  const reasons = [merged ? 'PR merged' : unavailable
    ? 'Jira validation unavailable; passed regex-only check'
    : 'Referenced Jira issues exist; issues and parents are outside Done'];
  if (linksEnabled) {
    let failed = false;
    const references = merged ? result.references : verified;
    for (const reference of references) {
      try {
        await jira.upsertPullRequestLink(reference, event.pull_request);
      } catch {
        failed = true;
      }
    }
    reasons.push(failed || references.length !== result.references.length
      ? 'Some Jira remote links could not be updated'
      : 'Jira PR remote links updated');
  }
  return { ...result, reason: reasons.join('; ') };
}
