# PR traceability

A zero-configuration GitHub Action written in plain JavaScript, with no dependencies or build step. Requires a Jira issue reference in a pull request's **title** or **source branch name**. Without Jira validation, one matching reference is enough. With Jira validation, every referenced issue must exist and be outside Done; integration errors fall back to regex-only checking.

The check also succeeds when:

- The **PR author** is a bot (validation is skipped).
- The **PR title** contains an incident reference such as `INC123456`.
- The PR has the **`no issue reference`** label.

By default, no Jira URL, project list, credentials, checkout, or runtime setup is needed in the consuming workflow. Optionally supply one Jira secret to require every referenced issue to exist outside the Done status category. GitHub runs the source directly using its provided Node 24 runtime. No GitHub token or API permissions are required. The action supports Linux, macOS, and Windows runners. No Docker, npm install, bundler, compiled binaries, or external packages are required.

## Usage

After publishing this repository to `phrond/pr-traceability`, add `.github/workflows/pr-traceability.yml` to a consuming repository:

```yaml
name: PR traceability

on:
  pull_request:
    types: [opened, reopened, synchronize, edited, labeled, unlabeled]

permissions: {}

jobs:
  traceability:
    runs-on: ubuntu-latest
    steps:
      - uses: phrond/pr-traceability@main
```

Pin to a release tag or full commit SHA when publishing a stable version. The action has **no required inputs**; `jira-secret` is its only optional input. Make the `traceability` check required in your repository's branch protection or ruleset to enforce it before merging.

Title edits, new commits, and adding or removing labels rerun the check. Commit messages, PR descriptions, the base branch, the event sender, and the workflow actor do not count. Bot detection uses the PR author's GitHub `type: Bot` or a login ending in `[bot]`; ordinary user accounts used for automation are not automatically exempt.

Fork PRs work without a GitHub token, subject to GitHub's normal workflow approval settings. `pull_request_target` is also supported; if using it, keep the action/workflow on trusted base-branch code and do not check out or execute PR code. This action reads the PR event and optionally contacts Jira; it does not call the GitHub API.

## Optional Jira validation

Set the single optional `jira-secret` input to a GitHub Actions secret containing this JSON:

```json
{
  "baseUrl": "https://your-team.atlassian.net",
  "email": "ci@example.com",
  "apiToken": "your-jira-api-token"
}
```

For example, save the JSON as a repository secret named `JIRA_SECRET`, then use:

```yaml
- uses: phrond/pr-traceability@main
  with:
    jira-secret: ${{ secrets.JIRA_SECRET }}
```

The action uses Jira Cloud's [email and API-token authentication](https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/) to read each candidate issue's status. The account must be able to view the referenced issues. Use your site URL for an unscoped API token; for a scoped API token, set `baseUrl` to `https://api.atlassian.com/ex/jira/<cloud-id>` and give the token permission to read issue status, following [Atlassian's API-token guidance](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account). The URL must use HTTPS.

With a nonempty secret, **every referenced issue must exist and have a status category other than Done**. The check uses `fields.status.statusCategory.key`, not the status name: `new` (To Do) and `indeterminate` (In Progress) qualify; `done` does not. A custom status such as Released still fails if it belongs to Done. Bot, incident, and label exemptions still pass without contacting Jira.

The action collects every distinct key from the PR title and source branch, then validates each issue. Any missing/inaccessible issue (HTTP 404 with Jira's recognized issue-not-found message) or Done issue fails the check and the rejected keys are listed. An active issue does not excuse another issue being Done. Duplicate keys are fetched only once, and at least one issue reference is required. Authentication errors, API errors (other than recognized issue-not-found responses), timeouts, malformed responses, and invalid secret configuration are swallowed and fall back to regex-only checking. Unrecognized 404 responses, including HTML pages, empty responses, and unrelated JSON errors, also fall back. A Done or missing/inaccessible issue reported by Jira still fails, even if another lookup encounters an integration error. Fallback still requires a regex match; inability to read any reference is not an automatic pass. The result log says when regex-only fallback was used, without logging secret values or error response bodies.

Jira error messages are requested in English so account language settings do not affect 404 recognition. Jira's recognized 404 response cannot distinguish a missing issue from an inaccessible one; some credential or endpoint problems can produce that same response and will also fail the check. See [Atlassian's scoped-token endpoint example](https://jira.atlassian.com/browse/JRACLOUD-94545).

Omitting the input or passing an empty value preserves regex-only behavior. [GitHub normally withholds repository secrets from fork PR workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflows-in-forked-repositories), so an unavailable `secrets.JIRA_SECRET` is empty and that run uses regex-only checking. If Jira validation must apply to forks, use a trusted `pull_request_target` workflow with a pinned action and no execution or checkout of PR code. Issue status is checked when the action runs; later Jira changes do not automatically rerun the check.

## Matching rules

Jira references are case-sensitive and match `[A-Z][A-Z0-9]+-[1-9][0-9]*`, with no adjacent letter or number. Project keys have at least two uppercase alphanumeric characters, begin with a letter, and are followed by a positive issue number without leading zeroes. Punctuation, underscores, and slashes may separate references.

| Text | Matches |
| --- | --- |
| `Fix TEAM-123 and OPS-456` | `TEAM-123`, `OPS-456` |
| `feature/TEAM2-123-fix` | `TEAM2-123` |
| `fix_TEAM-123_login` | `TEAM-123` |
| `https://example.atlassian.net/browse/TEAM-123` | `TEAM-123` |
| `team-123`, `A-1`, `TEAM-0`, `TEAM-012`, `prefixTEAM-123` | None |

Incident references match `\bINC[0-9]+\b` **in the PR title only**. Any number of digits is accepted, including leading zeroes, so both `INC123456` and `INC0012345` pass. The label name must be exactly `no issue reference`, ignoring case.

Without `jira-secret`, this is a syntax check and does not connect to Jira or verify that an issue exists. Custom Jira project-key formats are not configurable. Atlassian describes how [issue keys link GitHub development information to Jira](https://support.atlassian.com/jira-cloud-administration/docs/use-the-github-for-jira-app/).

Exemptions are checked first without an API request. Regex-only mode reads the PR title and source branch directly from the event and makes no network requests. With Jira validation enabled, every distinct key from those two fields is checked. Commit messages are ignored in both modes. This follows [Atlassian's documented PR linking rules](https://support.atlassian.com/jira-software-cloud/docs/reference-issues-in-your-development-work/): for GitHub, the key must be in the PR title or source branch to link the PR in Jira's development panel.

### Outputs

| Output | Meaning |
| --- | --- |
| `result` | `passed`, or `skipped` for a bot author. Both exit successfully. |
| `jira-references` | JSON array of distinct keys found before passing, in encounter order; `[]` for exemptions. |

The `jira-references` output contains every distinct key found in the title and source branch, in first-seen order. After successful Jira validation, all these keys are verified. On integration fallback, they are regex matches only. A failed check exits with status 1 and a GitHub error annotation explaining how to fix it. Outputs are written only on success. Bot skips appear as successful action steps with `result=skipped`.

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

CI runs the tests on Node 24 across Linux, macOS, and Windows. Tests cover the matching rules, all exemptions, rejection of commit-only references, optional Jira validation, API failures, action outputs, and entry-point exit codes. API tests use simulated responses and require no credentials or network access.

The action reads `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH`, and `GITHUB_OUTPUT` from the runner. GitHub supplies the optional Jira input as `INPUT_JIRA-SECRET`. For a local manual run, set the event variables and run `node src/index.mjs`. No GitHub token is needed.
