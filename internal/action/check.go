package action

import (
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"

	"github.com/mattlock83/pr-traceability/jira"
)

var (
	projectKey = regexp.MustCompile(`^[A-Z][A-Z0-9]{1,254}$`)
	serviceNow = regexp.MustCompile(`\b(?:INC|REQ)[0-9]+\b`)
)

// Check uses only the PR event and optional project allowlist. Jira access is
// separate, so missing credentials never affect the syntax check.
func Check(event Event, projectKeys string) (Result, error) {
	pr := event.PullRequest
	if pr == nil || pr.Number <= 0 {
		return Result{}, errors.New("The event must contain a pull request")
	}
	// The PR author matters, rather than the event sender or workflow actor.
	if pr.User.Type == "Bot" || strings.HasSuffix(strings.ToLower(pr.User.Login), "[bot]") {
		return Result{Status: "skipped", Reason: "PR author is a bot", References: []string{}}, nil
	}
	for _, label := range pr.Labels {
		if strings.ToLower(label.Name) == "no issue reference" {
			return Result{Status: "passed", Reason: `PR has the "no issue reference" label`, References: []string{}}, nil
		}
	}
	if serviceNow.MatchString(pr.Title) {
		return Result{Status: "passed", Reason: "PR title contains a ServiceNow incident or request reference", References: []string{}}, nil
	}
	var projects []string
	if strings.TrimSpace(projectKeys) != "" {
		for _, key := range strings.Split(projectKeys, ",") {
			key = strings.TrimSpace(key)
			if !projectKey.MatchString(key) {
				return Result{}, errors.New("Invalid project-keys: use comma-separated uppercase Jira project keys, each 2–255 letters or digits starting with a letter (e.g. TEAM,OPS)")
			}
			if !slices.Contains(projects, key) {
				projects = append(projects, key)
			}
		}
	}
	refs := make([]string, 0)
	for _, reference := range jira.FindReferences(pr.Title + "\n" + pr.Head.Ref) {
		key, _, _ := strings.Cut(reference, "-")
		if len(projects) == 0 || slices.Contains(projects, key) {
			refs = append(refs, reference)
		}
	}
	if len(refs) == 0 {
		required := "a Jira key (e.g. PROJ-123)"
		if len(projects) != 0 {
			required = "a Jira key from an allowed project (" + strings.Join(projects, ", ") + ")"
		}
		return Result{}, fmt.Errorf(`No issue reference found: add %s to the PR title or source branch; add a ServiceNow incident or request reference (e.g. INC123456 or REQ123456) to the PR title; or apply the "no issue reference" label`, required)
	}
	return Result{Status: "passed", Reason: "Jira reference found in PR title or source branch", References: refs}, nil
}
