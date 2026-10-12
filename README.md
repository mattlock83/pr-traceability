# PR traceability

A GitHub Action written in plain JavaScript, with no external dependencies or build step. It requires a Jira issue reference in a pull request's **title** or **source branch name** and works without configuration or a Jira secret.

- **Traceability:** find and deduplicate Jira references, optionally restricted to specific project keys.
- **Jira validation, with a secret:** check that every matching issue exists and is outside the Done status category. Integration errors fall back to the regex check.
- **Repository components, enabled by default with a secret:** on PR open, create or reuse an `org/repo` component in each referenced Jira project and assign it to the referenced issues. Set `jira-components: 'false'` to disable this.
- **Optional remote links:** on PR open, link the PR from each validated referenced Jira issue.

The check also succeeds when:

- The **PR author** is a bot (validation is skipped).
- The **PR title** contains a ServiceNow incident or request reference such as `INC123456` or `REQ1234`.
- The PR has the **`no issue reference`** label.

Without Jira credentials, the action checks syntax only and makes no network requests. GitHub runs the source directly using its provided Node 24 runtime; no checkout or runtime setup is needed in the consuming workflow. No GitHub token or API permissions are required. The action supports Linux, macOS, and Windows runners. No Docker, npm install, bundler, compiled binaries, or external packages are required.

## Why PR titles and source branches?

The purpose of this action is to help GitHub pull requests appear against the relevant issues in **Jira's development panel**. For that panel, connect your repository through the [GitHub for Jira integration](https://support.atlassian.com/jira-cloud-administration/docs/use-the-github-for-jira-app/). This action enforces reference placement; the integration handles synchronization with Jira. If you do not use that integration, the optional remote-link feature below provides ordinary issue links to PRs; it does not populate the development panel.

Atlassian documents different linking rules for each kind of development information:

| Where the issue key appears | What it links in Jira | Satisfies this action? |
| --- | --- | --- |
| PR title, such as `TEAM-123: Fix login` | The PR | Yes |
| Source branch, such as `feature/TEAM-123-fix-login` | The branch and its PR | Yes |
| PR description | The PR | No; outside this action's current scope |
| Commit message only, such as `TEAM-123 Fix login` | That commit; it does not establish the GitHub PR link | No |

A commit-only reference could therefore pass a broader check while leaving the PR absent from the issue's PR list. Atlassian supports linking a PR through its commits for **Bitbucket Cloud only**, so this action deliberately checks the PR title and source branch. See [Atlassian's development-reference rules](https://support.atlassian.com/jira-software-cloud/docs/reference-issues-in-your-development-work/).

The native GitHub integration [also recognizes issue keys in PR descriptions](https://jira.atlassian.com/browse/JRACLOUD-98420). This action currently enforces the narrower title/branch rule. It does not parse description commands or transition issue statuses.

If you also want individual commits listed in Jira, include the key in their commit messages. A branch or PR reference does not replace those commit references. Bot, ServiceNow incident/request, and label exemptions allow the check to pass without establishing a Jira issue link.

## Usage

Add `.github/workflows/pr-traceability.yml` to a consuming repository:

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

Pin to a release tag or full commit SHA when publishing a stable version. The action has **no required inputs**. Make the `traceability` check required in your repository's branch protection or ruleset to enforce it before merging.

Title edits, new commits, and adding or removing labels rerun the check. Commit messages, PR descriptions, the base branch, the event sender, and the workflow actor do not count. Bot detection uses the PR author's GitHub `type: Bot` or a login ending in `[bot]`; ordinary user accounts used for automation are not automatically exempt.

The workflow does not need the `closed` event. If included, regex checks and exemptions still apply, but closing or merging a PR makes no Jira requests.

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

Bot, ServiceNow incident/request, and label exemptions take precedence over project configuration.

## Optional Jira integration

The optional integration supports **Jira Cloud only**, using [REST API v3](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/). This complete workflow enables validation, repository components, and remote links:

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
        with:
          project-keys: 'TEAM,OPS' # Optional
          jira-url: 'https://your-team.atlassian.net'
          jira-secret: ${{ secrets.JIRA_SECRET }}
          jira-remote-links: 'true' # Optional; defaults to false
          jira-components: 'true' # Optional; set to false to disable component creation and assignment
```

| Input | Default | Purpose |
| --- | --- | --- |
| `project-keys` | Empty | Allow any valid project key, or supply a comma-separated allowlist. |
| `jira-secret` | Empty | Enable Jira validation and configured Jira features using JSON credentials. |
| `jira-url` | Empty | Jira API base URL; required with a secret unless its JSON contains `baseUrl`. |
| `jira-remote-links` | `false` | Set to `true` to create PR remote links on the `opened` event. Requires a Jira secret. |
| `jira-components` | `true` | Set to `false` to disable creating and assigning repository components on the `opened` event. Requires a Jira secret. |

If `JIRA_SECRET` is absent or empty, the same workflow runs the regex check without making any Jira requests. The URL and Jira feature settings have no effect without a secret.

### Jira secret requirements

1. [Create an Atlassian API token](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/) for an account with access to the relevant Jira projects.
2. In the consuming GitHub repository, open **Settings → Secrets and variables → Actions** and create a repository secret named **`JIRA_SECRET`**. An organization secret shared with the repository also works.
3. Store the following JSON as the secret value, using the token owner's email and token. Use an API token, not the account password; do not Base64-encode the JSON.

```json
{"email":"ci@example.com","apiToken":"your-api-token"}
```

Use `https://your-team.atlassian.net` as `jira-url` with an **unscoped token**. With a **scoped token**, use `https://api.atlassian.com/ex/jira/<cloud-id>` instead, following [Atlassian's token guidance](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/). Tokens expire; replace the GitHub secret when rotating the token.

The URL must use HTTPS and must not include credentials, query parameters, a fragment, or `/rest/api/3`. Alternatively, include `baseUrl` in the JSON secret; an explicit `jira-url` takes precedence.

The account needs the following Jira permissions. For scoped tokens, Atlassian's recommended classic scopes are listed alongside them; token scopes do not grant permissions the account lacks.

| Operation | Account permissions and Jira requirements | Classic token scope |
| --- | --- | --- |
| [Validate issues](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-get) and look up components | Browse projects, including access under any issue security rules | `read:jira-work` |
| [Assign components](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-put) | Edit issues, with the Components field editable | `write:jira-work` |
| [Create missing components](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-project-components/#api-rest-api-3-component-post) | Administer projects in each affected project, or Administer Jira | `manage:jira-project` |
| [Create/update remote links](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-remote-links/#api-rest-api-3-issue-issueidorkey-remotelink-post) | Browse projects and Link issues; issue linking must be enabled | `write:jira-work` |

Component assignment is automatic on PR open when a secret is supplied, unless `jira-components: 'false'`. When disabled, component write permissions and scopes are unnecessary; Jira validation and optional remote links still run. Creation permission is unnecessary when the component already exists. Missing write permissions leave the traceability check successful and report incomplete updates.

### Validation and fallback

With credentials supplied, **every matching reference** must exist and have a `statusCategory.key` other than `done`. Checks use the status category rather than a status name such as Closed, Released, or Complete.

Only matching references from the PR title or source branch are validated and eligible for components and remote links. Parent issues and epics are checked only if they are themselves referenced in the PR title or source branch and match `project-keys` when configured.

Invalid Jira inputs, malformed credentials or responses, authentication failures, rate limits, connection errors, and timeouts fall back to regex matching. A confirmed missing/inaccessible referenced issue or Done referenced issue still fails, even if another request errors. Only recognized Jira issue-not-found 404 bodies count as missing issues; HTML, empty, and unrelated JSON 404s fall back. Jira can return the same recognized 404 for missing issues and permission/configuration problems, so those cannot always be distinguished. Failed HTTP responses log the status and response body for triage; invalid JSON responses are also logged. Request and response headers are never logged. Credential values are redacted if echoed in a response body, and bodies are quoted on one line so their contents cannot become workflow commands. Network errors without a response log that no body is available.

Requests have a 10-second timeout and share a 30-second total budget per action run. A fallback still requires a regex reference from an allowed project; API failure never excuses missing traceability. Bot, ServiceNow incident/request, and label exemptions bypass all Jira checks and writes. With no secret, all Jira features are skipped.

### Repository components

When `jira-secret` is supplied, a PR's **`opened` event** ensures a Jira component named after the base repository, such as `OpenAI/codex`, exists in each referenced issue's project and assigns it to that issue. Fork PRs use the destination repository's name. This is enabled by default; set `jira-components: 'false'` to skip all component creation and assignment. Jira issue validation and optional remote links continue to work. Multiple issues in one project share the same component; references in different projects receive a component in each project, using the project returned by Jira.

`jira-components` accepts `true` or `false`, with surrounding whitespace trimmed. Omitting it or leaving it empty enables components. Invalid values fall back to the regex-only check, like other invalid Jira configuration.

Existing issue components are preserved. The action skips existing assignments, reuses component IDs returned during validation, and otherwise tries an [additive update by component name](https://support.atlassian.com/automation/kb/add-components-to-jira-work-items-using-automation/). A recognized missing-component response triggers creation and assignment; unrelated or unrecognized errors skip the assignment without creating anything. If another run creates the component first, or its name uses different casing, a fallback lookup reuses it. Rerunning the opened event skips existing assignments.

For a single referenced issue, component handling uses these additional calls beyond issue validation and optional remote links:

| Component state | Additional API calls |
| --- | --- |
| Already assigned | 0 |
| Exists with the repository name, but not assigned | 1 issue update |
| Does not exist | 3: rejected issue update, component creation, issue update |

Creation results are shared within each project. A casing mismatch or concurrent creation can require an additional lookup; these are fallback paths rather than calls on every run.

Component writes run after issue validation and apply only to successfully validated references. A confirmed missing or Done reference prevents all writes. Component errors are logged and reported without failing the traceability check; other projects and remote links can still update. Other events, including `reopened`, `edited`, and merge, do not create or assign components. References introduced after opening do not automatically receive a component.

This requires Jira components in a [company-managed project](https://support.atlassian.com/jira-software-cloud/docs/what-are-jira-components/); Compass components and team-managed projects are not supported. See the permissions above.

### PR remote links

Set `jira-remote-links: 'true'` with Jira credentials to create a remote link on each validated referenced issue during the PR's **`opened` event**. The link includes the PR number, title, and URL. A stable `globalId` in the form `org/repo/PR-number` (for example, `phrond/pr-traceability/42`) makes reruns update the same link instead of creating duplicates. See the [Jira Cloud create/update API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-remote-links/).

Remote-link write errors do not fail the check; the result log reports incomplete updates. During validation fallback, links are written only for references whose issue checks completed successfully. Rerun the `opened` event to retry a failed write; the action uses that event's original title and references.

Other events do not update links. Later title changes, added or removed issue references, closing, and merging are not synchronized. Existing links are not cleaned up, marked resolved, or given a merged suffix. The action does not transition Jira issues or epics.

## Matching rules

Jira Cloud references are case-sensitive and match `[A-Z][A-Z0-9]{1,254}-[1-9][0-9]*`, with no adjacent letter or number. Project keys contain 2–255 uppercase ASCII letters or digits, begin with a letter, and are followed by a positive issue number without leading zeroes. Jira's default maximum project-key length is 10, but [sites can configure it up to 255](https://support.atlassian.com/jira-cloud-administration/docs/configure-jira-application-options/); the action accepts that full range. Punctuation, underscores, and slashes may separate references.

| Text | Matches |
| --- | --- |
| `Fix TEAM-123 and OPS-456` | `TEAM-123`, `OPS-456` |
| `feature/TEAM2-123-fix` | `TEAM2-123` |
| `fix_TEAM-123_login` | `TEAM-123` |
| `https://example.atlassian.net/browse/TEAM-123` | `TEAM-123` |
| `team-123`, `A-1`, `TEAM-0`, `TEAM-012`, `prefixTEAM-123` | None |

ServiceNow incident and request references match `\b(?:INC|REQ)[0-9]+\b` **in the PR title only**. Prefixes are case-sensitive, and any number of digits is accepted, including leading zeroes: `INC123456`, `INC0012345`, `REQ1234`, and `REQ0012345` all pass. Embedded references such as `XREQ1234` or `REQ1234suffix` do not qualify. These references are syntax exemptions and bypass all Jira checks and writes, even if the title also contains Jira keys. The label name must be exactly `no issue reference`, ignoring case.

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

CI runs the tests on Node 24 across Linux, macOS, and Windows. Tests cover matching, exemptions, project restrictions, action outputs, Jira Cloud v3 authentication, referenced-issue checks, fallback, response logging, repository components, and remote links on PR open. Jira tests use simulated responses and require no credentials or network access.

The regex parser (`src/jira.mjs`) and synchronous `check()` function in `src/action.mjs` remain separate from Jira behavior. `src/jira-api.mjs` owns credentials and REST requests; `src/jira-integration.mjs` owns validation, fallback, component assignment, and remote-link creation. The action runner connects them.

The action reads `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH`, and `GITHUB_OUTPUT` from the runner. GitHub supplies inputs as `INPUT_PROJECT-KEYS`, `INPUT_JIRA-SECRET`, `INPUT_JIRA-URL`, `INPUT_JIRA-REMOTE-LINKS`, and `INPUT_JIRA-COMPONENTS`. For a local manual run, set the event variables and run `node src/index.mjs`. No GitHub token is needed.
