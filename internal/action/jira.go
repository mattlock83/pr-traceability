package action

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/mattlock83/pr-traceability/internal/jira"
)

var repositoryName = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

// ApplyJira enriches a successful syntax check. Integration failures fall back
// to that result; only confirmed missing or Done issues reject it.
func ApplyJira(ctx context.Context, result Result, event Event, inputs Inputs, httpClient *http.Client, log func(string)) (Result, error) {
	if len(result.References) == 0 || strings.TrimSpace(inputs.JiraSecret) == "" || event.Action == "closed" {
		return result, nil
	}
	if log == nil {
		log = func(string) {}
	}
	links, linksOK := booleanInput(inputs.RemoteLinks, false)
	components, componentsOK := booleanInput(inputs.Components, true)
	client, err := jira.New(inputs.JiraSecret, inputs.JiraURL, httpClient, log)
	if !linksOK || !componentsOK || err != nil {
		if !linksOK {
			log("Invalid jira-remote-links: expected true or false")
		}
		if !componentsOK {
			log("Invalid jira-components: expected true or false")
		}
		if err != nil {
			log(err.Error())
		}
		result.Reason += "; Jira configuration unavailable, using regex only"
		return result, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	type verifiedIssue struct {
		reference string
		issue     *jira.Issue
	}
	var rejected []string
	var verifiedIssues []verifiedIssue
	unavailable := false
	// Complete validation before any writes, so a later rejection prevents them.
	for _, reference := range result.References {
		issue, err := client.GetIssue(ctx, reference)
		switch {
		case err != nil:
			log(fmt.Sprintf("Jira validation for %s: %s", reference, err))
			unavailable = true
		case issue == nil:
			rejected = append(rejected, reference+": not found or inaccessible")
		case issue.StatusCategory == "done":
			rejected = append(rejected, reference+": Done")
		default:
			verifiedIssues = append(verifiedIssues, verifiedIssue{reference, issue})
		}
	}
	if len(rejected) != 0 {
		return Result{}, fmt.Errorf("Referenced Jira issues must exist and be outside the Done status category (%s)", strings.Join(rejected, "; "))
	}
	reasons := []string{"Referenced Jira issues exist and are outside Done"}
	if unavailable {
		reasons[0] = "Jira validation unavailable; passed regex-only check"
	}
	if event.Action == "opened" {
		if components {
			repository := event.Repository.FullName
			valid := repositoryName.MatchString(repository)
			failed := unavailable || !valid
			if valid {
				for _, verified := range verifiedIssues {
					if err := client.AssignRepositoryComponent(ctx, verified.reference, verified.issue, repository); err != nil {
						log(fmt.Sprintf("Jira component assignment for %s: %s", verified.reference, err))
						failed = true
					}
				}
			} else {
				log("Jira component assignment: event is missing a valid repository name")
			}
			if failed {
				reasons = append(reasons, "Some Jira repository components could not be assigned")
			} else {
				reasons = append(reasons, "Jira repository component assigned")
			}
		}
		if links {
			failed := unavailable
			pr := event.PullRequest
			for _, verified := range verifiedIssues {
				if err := client.UpsertPullRequestLink(ctx, verified.reference, pr.HTMLURL, pr.Number, pr.Title); err != nil {
					log(fmt.Sprintf("Jira remote link for %s: %s", verified.reference, err))
					failed = true
				}
			}
			if failed {
				reasons = append(reasons, "Some Jira remote links could not be created")
			} else {
				reasons = append(reasons, "Jira PR remote links created")
			}
		}
	}
	result.Reason = strings.Join(reasons, "; ")
	return result, nil
}

func booleanInput(value string, fallback bool) (bool, bool) {
	switch strings.TrimSpace(value) {
	case "":
		return fallback, true
	case "true":
		return true, true
	case "false":
		return false, true
	default:
		return false, false
	}
}
