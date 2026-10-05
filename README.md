# PR traceability

A zero-configuration GitHub Action written in plain JavaScript, with no dependencies or build step. Requires a Jira issue reference in a pull request's **title** or **source branch name**. One matching reference is enough. Optionally restrict matching to specific Jira project keys.

The check also succeeds when:

- The **PR author** is a bot (validation is skipped).
- The **PR title** contains an incident reference such as `INC123456`.
- The PR has the **`no issue reference`** label.

The action checks syntax only: it makes no network requests and does not verify issue existence or status. No credentials, checkout, or runtime setup are needed in the consuming workflow. GitHub runs the source directly using its provided Node 24 runtime. No GitHub token or API permissions are required. The action supports Linux, macOS, and Windows runners. No Docker, npm install, bundler, compiled binaries, or external packages are required.

## Why PR titles and source branches?

The purpose of this action is to help GitHub pull requests appear against the relevant issues in **Jira's development panel**. Your repository must already be connected through the [GitHub for Jira integration](https://support.atlassian.com/jira-cloud-administration/docs/use-the-github-for-jira-app/). This action enforces reference placement; the integration handles synchronization with Jira.

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

Pin to a release tag or full commit SHA when publishing a stable version. The action has **no required inputs**; `project-keys` is its only optional input. Make the `traceability` check required in your repository's branch protection or ruleset to enforce it before merging.

Title edits, new commits, and adding or removing labels rerun the check. Commit messages, PR descriptions, the base branch, the event sender, and the workflow actor do not count. Bot detection uses the PR author's GitHub `type: Bot` or a login ending in `[bot]`; ordinary user accounts used for automation are not automatically exempt.

The `closed` event runs when a PR is merged or closed without merging. It currently runs the same traceability check; merge-specific behavior can be added later by checking `github.event.pull_request.merged`.

Fork PRs work without a GitHub token, subject to GitHub's normal workflow approval settings. `pull_request_target` is also supported; if using it, keep the action/workflow on trusted base-branch code and do not check out or execute PR code. This action reads only the PR event and its configuration.

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

Custom Jira project-key formats are not configurable.

Exemptions are checked first. References are extracted from the PR title and source branch, then filtered by `project-keys` when configured. Commit messages are ignored.

### Outputs

| Output | Meaning |
| --- | --- |
| `result` | `passed`, or `skipped` for a bot author. Both exit successfully. |
| `jira-references` | JSON array of distinct matching references, restricted to allowed projects when configured; `[]` for exemptions. |

The `jira-references` output contains matching references in first-seen order: title before branch, with duplicates removed. When `project-keys` is configured, only references from those projects are included. A failed check exits with status 1 and a GitHub error annotation explaining how to fix it. Outputs are written only on success. Bot skips appear as successful action steps with `result=skipped`.

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

CI runs the tests on Node 24 across Linux, macOS, and Windows. Tests cover the matching rules, all exemptions, rejection of commit-only references, project restrictions, invalid configuration, action outputs, and entry-point exit codes. Tests require no credentials or network access.

The action reads `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH`, and `GITHUB_OUTPUT` from the runner. GitHub supplies the optional project list as `INPUT_PROJECT-KEYS`. For a local manual run, set the event variables and run `node src/index.mjs`. No GitHub token is needed.
