# PR traceability

A GitHub Action written in plain JavaScript, with no dependencies or build step. Requires a Jira issue reference in a pull request's **title** or **source branch name**. It works without configuration using regex matching. Optionally restrict matching to specific project keys, validate issues and their parents against Jira, or create PR remote links in Jira.

The check also succeeds when:

- The **PR author** is a bot (validation is skipped).
- The **PR title** contains an incident reference such as `INC123456`.
- The PR has the **`no issue reference`** label.

Without Jira credentials, the action checks syntax only and makes no network requests. GitHub runs the source directly using its provided Node 24 runtime; no checkout or runtime setup is needed in the consuming workflow. No GitHub token or API permissions are required. The action supports Linux, macOS, and Windows runners. No Docker, npm install, bundler, compiled binaries, or external packages are required.

## Why PR titles and source branches?

The purpose of this action is to help GitHub pull requests appear against the relevant issues in **Jira's development panel**. For that panel, connect your repository through the [GitHub for Jira integration](https://support.atlassian.com/jira-cloud-administration/docs/use-the-github-for-jira-app/). This action enforces reference placement; the integration handles synchronization with Jira. If you do not use that integration, the optional remote-link feature below provides ordinary issue links to PRs; it does not populate the development panel.

Atlassian documents different linking rules for each kind of development information:

| Where the issue key appears | What it links in Jira | Satisfies this action? |
| --- | --- | --- |
| PR title, such as `TEAM-123: Fix login` | The PR | Yes |
| Source branch, such as `feature/TEAM-123-fix-login` | The branch and its PR | Yes |
| Commit message only, such as `TEAM-123 Fix login` | That commit; it does not establish the GitHub PR link | No |

A commit-only reference could therefore pass a broader check while leaving the PR absent from the issue's PR list. Atlassian supports linking a PR through its commits for **Bitbucket Cloud only**, so this action deliberately checks the PR title and source branch. See [Atlassian's development-reference rules](https://support.atlassian.com/jira-software-cloud/docs/reference-issues-in-your-development-work/).

If you also want individual commits listed in Jira, include the key in their commit messages. A branch or PR reference does not replace those commit references. Bot, incident, and label exemptions allow the check to pass without establishing a Jira issue link.

## Usage

Add `.github/workflows/pr-traceability.yml` to a consuming repository:

```yaml
name: PR traceability

on:
  pull_request:
    types: [opened, reopened, synchronize, edited, labeled, unlabeled, closed]

permissions: {}

jobs:
  traceability:
    runs-on: ubuntu-latest
    steps:
      - uses: phrond/pr-traceability@main
```

Pin to a release tag or full commit SHA when publishing a stable version. The action has **no required inputs**. Make the `traceability` check required in your repository's branch protection or ruleset to enforce it before merging.

Title edits, new commits, and adding or removing labels rerun the check. Commit messages, PR descriptions, the base branch, the event sender, and the workflow actor do not count. Bot detection uses the PR author's GitHub `type: Bot` or a login ending in `[bot]`; ordinary user accounts used for automation are not automatically exempt.

The `closed` event runs when a PR is merged or closed without merging. Regex checks and exemptions still apply. Jira validation runs on open-PR events. On merge, optional remote links are marked resolved without rechecking Jira status, so issues completed during the merge can still receive the link update. Closing without merging makes no Jira requests.

Fork PRs work in regex-only mode, subject to GitHub's normal workflow approval settings. GitHub normally withholds repository secrets from fork PR workflows, so Jira checks and links are skipped when the secret is unavailable. `pull_request_target` is also supported if Jira access is required for forks; keep the action/workflow on trusted base-branch code, pin the action, and do not check out or execute PR code.

## Optional project restriction

Set `project-keys` to a comma-separated list of allowed Jira project keys:

```yaml
- uses: phrond/pr-traceability@main
  with:
    project-keys: 'TEAM,OPS'
```

With this configuration, at least one reference in the PR title or source branch must belong to `TEAM` or `OPS`. Matching is exact and case-sensitive: `TEAM-123` qualifies, while `TEAM2-123` does not. References to other projects are ignored; `TEAM-123 OTHER-456` passes and outputs only `TEAM-123`.

Omitting the input, or leaving it empty or whitespace-only, allows any valid project key. Spaces around comma-separated keys are trimmed, and duplicates are ignored. Each entry must be an uppercase Jira Cloud project key: 2–255 letters or digits, starting with a letter. Supply project keys such as `TEAM`, not issue references such as `TEAM-123`. Invalid entries, including empty comma-separated entries, fail with a configuration error. Wildcards and custom regular expressions are not supported.

Bot, incident, and label exemptions take precedence over project configuration.

## Optional Jira integration

The optional integration supports **Jira Cloud only**, using [REST API v3](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/). Set `jira-secret` to a JSON credential stored in GitHub Actions secrets, and set `jira-url` to the API base URL:

```yaml
- uses: phrond/pr-traceability@main
  with:
    project-keys: 'TEAM,OPS' # Optional
    jira-url: 'https://your-team.atlassian.net'
    jira-secret: ${{ secrets.JIRA_SECRET }}
    jira-remote-links: 'true' # Optional; defaults to false
```

### Credentials and URL

For **Jira Cloud**, the secret contains your account email and API token:

```json
{"email":"ci@example.com","apiToken":"your-api-token"}
```

Use your site URL with an unscoped token. For a scoped Cloud token, use `https://api.atlassian.com/ex/jira/<cloud-id>` as `jira-url`, following [Atlassian's token guidance](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account).

Use an HTTPS URL without `/rest/api/3` appended. Alternatively, put `baseUrl` in the JSON secret; an explicit `jira-url` takes precedence.

### Validation and fallback

With credentials supplied, **every matching reference** must exist and have a `statusCategory.key` other than `done`. Its immediate parent, if present, must also be outside Done. The parent reference comes from Jira, so parent existence is not a separate validation requirement; the parent is fetched to read its status. Checks use the status category rather than a status name such as Closed, Released, or Complete.

The client reads Cloud’s `fields.parent` directly, with no legacy custom-field discovery. Parent lookups are shared across references. Only the immediate parent is checked, not all ancestors, and the parent can belong to a project outside `project-keys`. Remote links are written only to the referenced issues, not automatically to their parents.

Malformed credentials or responses, authentication failures, rate limits, connection errors, and timeouts fall back to regex matching. A confirmed missing/inaccessible referenced issue or Done issue/parent still fails, even if another request errors. An unreadable parent status, including a parent lookup returning 404, falls back to regex matching. Only recognized Jira issue-not-found 404 bodies count as missing issues; HTML, empty, and unrelated JSON 404s fall back. Jira can return the same recognized 404 for missing issues and permission/configuration problems, so those cannot always be distinguished. Failed HTTP responses log the status and response body for triage; invalid JSON responses are also logged. Request and response headers are never logged. Credential values are redacted if echoed in a response body, and bodies are quoted on one line so their contents cannot become workflow commands. Network errors without a response log that no body is available.

Requests have a 10-second timeout and share a 30-second total budget per action run. A fallback still requires a regex reference from an allowed project; API failure never excuses missing traceability. Bot, incident, and label exemptions bypass all Jira checks and writes. With no secret, all Jira features are skipped.

The Jira account needs permission to browse referenced issues and their parents. Enabling remote links additionally requires issue linking to be enabled and the relevant edit/link permissions. Use a token with the corresponding read/write scopes.

### PR remote links

Set `jira-remote-links: 'true'` to create a remote link on each validated referenced issue. Repeated runs update the same link using a stable `globalId` in the form `org/repo/PR-number` (for example, `phrond/pr-traceability/42`). The link includes the PR number and title, with a `[Merged]` suffix added when the PR merges. On `closed` with `merged: true`, the action upserts the link with `object.status.resolved: true`, even if the Jira issue or its parent is now Done. It can create the resolved link if no earlier run created it. It does not transition Jira issues or epics.

Jira uses the resolved flag for strikethrough rendering, but [Jira Cloud has a reported rendering limitation](https://jira.atlassian.com/browse/JRACLOUD-79720). The `[Merged]` title suffix keeps the merged state visible when strikethrough is absent; merge updates also set the resolved flag. See the [remote-link field documentation](https://developer.atlassian.com/server/jira/platform/using-fields-in-remote-issue-links/) and [v3 create/update API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-remote-links/).

Remote-link write errors do not fail the check; the result log reports incomplete updates. During validation fallback, links are written only for references whose issue and parent checks completed successfully. On merge, all current matching references are updated without Jira validation. References removed from the title/branch are not tracked or cleaned up, and closed-without-merge PRs leave their existing links unchanged. Rerun the merged event to retry a failed merge update.

When remote links are enabled, serialize runs for each PR to reduce overlapping updates:

```yaml
concurrency:
  group: pr-traceability-${{ github.event.pull_request.number }}
  cancel-in-progress: false
```

Use this workflow only for PR events. Avoid rerunning an old open-PR event after the PR has merged; runs use their original event snapshot, which could restore an unresolved link. The action does not query GitHub for live PR state.

## Matching rules

Jira Cloud references are case-sensitive and match `[A-Z][A-Z0-9]{1,254}-[1-9][0-9]*`, with no adjacent letter or number. Project keys contain 2–255 uppercase ASCII letters or digits, begin with a letter, and are followed by a positive issue number without leading zeroes. Jira's default maximum project-key length is 10, but [sites can configure it up to 255](https://support.atlassian.com/jira-cloud-administration/docs/configure-jira-application-options/); the action accepts that full range. Punctuation, underscores, and slashes may separate references.

| Text | Matches |
| --- | --- |
| `Fix TEAM-123 and OPS-456` | `TEAM-123`, `OPS-456` |
| `feature/TEAM2-123-fix` | `TEAM2-123` |
| `fix_TEAM-123_login` | `TEAM-123` |
| `https://example.atlassian.net/browse/TEAM-123` | `TEAM-123` |
| `team-123`, `A-1`, `TEAM-0`, `TEAM-012`, `prefixTEAM-123` | None |

Incident references match `\bINC[0-9]+\b` **in the PR title only**. Any number of digits is accepted, including leading zeroes, so both `INC123456` and `INC0012345` pass. The label name must be exactly `no issue reference`, ignoring case.

Custom on-premise project-key formats (for example, keys containing underscores) are not supported; the parser uses the Cloud-compatible syntax above.

Exemptions are checked first. References are extracted from the PR title and source branch, then filtered by `project-keys` when configured. Commit messages are ignored.

### Outputs

| Output | Meaning |
| --- | --- |
| `result` | `passed`, or `skipped` for a bot author. Both exit successfully. |
| `jira-references` | JSON array of distinct matching references, restricted to allowed projects when configured; `[]` for exemptions. |

The `jira-references` output contains matching references in first-seen order: title before branch, with duplicates removed. When `project-keys` is configured, only references from those projects are included. A failed check exits with status 1 and a GitHub error annotation explaining how to fix it. Outputs are written only on success. Bot skips appear as successful action steps with `result=skipped`.

References are regex matches, not a guarantee of successful Jira validation or link creation. The result log reports Jira validation fallback and incomplete link updates.

## Reuse the parser

The `src/jira.mjs` module is independent of GitHub Actions and has no dependencies. It can be imported by other JavaScript programs:

```js
import { findReferences } from './src/jira.mjs';

const refs = findReferences('Fix TEAM-123 and OPS-456; follow-up to TEAM-123');
console.log(refs); // ['TEAM-123', 'OPS-456']
```

`findReferences` returns all distinct matches in first-seen order, or `[]` when there are no matches.

## Development

Use Node 24 or newer. Run the built-in test runner directly; there is nothing to install or build:

```sh
node --test
node --test --experimental-test-coverage
```

CI runs the tests on Node 24 across Linux, macOS, and Windows. Tests cover matching, exemptions, project restrictions, action outputs, Jira Cloud v3 authentication, issue/parent checks, fallback, response logging, and remote-link updates. Jira tests use simulated responses and require no credentials or network access.

The regex parser (`src/jira.mjs`) and synchronous `check()` function in `src/action.mjs` remain separate from Jira behavior. `src/jira-api.mjs` owns credentials and REST requests; `src/jira-integration.mjs` owns validation, fallback, and link lifecycle decisions. The action runner connects them.

The action reads `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH`, and `GITHUB_OUTPUT` from the runner. GitHub supplies inputs as `INPUT_PROJECT-KEYS`, `INPUT_JIRA-SECRET`, `INPUT_JIRA-URL`, and `INPUT_JIRA-REMOTE-LINKS`. For a local manual run, set the event variables and run `node src/index.mjs`. No GitHub token is needed.
