package action

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func testEvent(t *testing.T, fields string) Event {
	t.Helper()
	if fields != "" {
		fields = "," + fields
	}
	var event Event
	if err := json.Unmarshal([]byte(`{"sender":{"type":"Bot"},"pull_request":{"number":42`+fields+`}}`), &event); err != nil {
		t.Fatal(err)
	}
	return event
}

func TestCheck(t *testing.T) {
	for _, tc := range []struct {
		name, fields, status string
		refs                 []string
	}{
		{"bot type", `"user":{"type":"Bot","login":"automation"}`, "skipped", nil},
		{"bot suffix", `"user":{"type":"User","login":"dependabot[bot]"}`, "skipped", nil},
		{"bot suffix casing", `"user":{"login":"Automation[BOT]"}`, "skipped", nil},
		{"label", `"labels":[{"name":"other"},{"name":"no issue reference"}]`, "passed", nil},
		{"label casing", `"labels":[{"name":"No Issue Reference"}]`, "passed", nil},
		{"incident", `"title":"Fix outage (INC123456)"`, "passed", nil},
		{"incident leading zeroes", `"title":"INC0012345: repair"`, "passed", nil},
		{"request", `"title":"Fulfil request (REQ1234)"`, "passed", nil},
		{"request leading zeroes", `"title":"REQ0012345: provision access"`, "passed", nil},
		{"short request", `"title":"REQ1"`, "passed", nil},
		{"request-like Jira key", `"title":"REQ-1234"`, "passed", []string{"REQ-1234"}},
		{"multiple title keys", `"title":"TEAM-123 and OPS-4"`, "passed", []string{"TEAM-123", "OPS-4"}},
		{"branch", `"head":{"ref":"feature/TEAM-123-fix"}`, "passed", []string{"TEAM-123"}},
		{"deduplicate title and branch", `"title":"TEAM-123","head":{"ref":"TEAM-123-OPS-4"}`, "passed", []string{"TEAM-123", "OPS-4"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result, err := Check(testEvent(t, tc.fields), "")
			if err != nil {
				t.Fatal(err)
			}
			if tc.refs == nil {
				tc.refs = []string{}
			}
			if result.Status != tc.status || !reflect.DeepEqual(result.References, tc.refs) {
				t.Fatalf("got %+v; want status %s, references %v", result, tc.status, tc.refs)
			}
		})
	}
}

func TestCheckMissingReferences(t *testing.T) {
	for _, tc := range []struct{ name, fields string }{
		{"human named bot", `"user":{"type":"User","login":"robot"}`},
		{"bot sender does not exempt human", `"user":{"type":"User","login":"human"}`},
		{"label exact name", `"labels":[{"name":"no issue reference please"}]`},
		{"embedded incident", `"title":"XINC123456 INC123456x"`},
		{"lowercase incident", `"title":"inc123456"`},
		{"incident in source branch", `"head":{"ref":"fix/INC123456"}`},
		{"embedded request", `"title":"XREQ1234 REQ1234x"`},
		{"underscore adjacent request", `"title":"fix_REQ1234 REQ1234_fix"`},
		{"lowercase request", `"title":"req1234"`},
		{"request without digits", `"title":"REQ"`},
		{"separated request digits", `"title":"REQ 1234 REQ+1234"`},
		{"request in source branch", `"head":{"ref":"feature/REQ1234"}`},
		{"description ignored", `"body":"TEAM-123 INC123456 REQ1234 no issue reference"`},
		{"base branch ignored", `"base":{"ref":"TEAM-123"}`},
		{"commit references ignored", `"commits":[{"message":"TEAM-123"}],"head_commit":{"message":"OPS-456"}`},
		{"no match", `"title":"Fix"`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := Check(testEvent(t, tc.fields), ""); err == nil || !strings.Contains(err.Error(), "No issue reference found") {
				t.Fatalf("got %v; want missing reference error", err)
			}
		})
	}
	for _, event := range []Event{{}, {PullRequest: &PullRequest{}}, {PullRequest: &PullRequest{Number: -1}}} {
		if _, err := Check(event, ""); err == nil || err.Error() != "The event must contain a pull request" {
			t.Fatalf("invalid event: got %v", err)
		}
	}
}

func TestProjectKeys(t *testing.T) {
	for _, projects := range []string{"", " \t\n", "TEAM", "TEAM,OPS", " TEAM , OPS , TEAM "} {
		t.Run("allowed "+projects, func(t *testing.T) {
			result, err := Check(testEvent(t, `"title":"TEAM-123"`), projects)
			if err != nil || !reflect.DeepEqual(result.References, []string{"TEAM-123"}) {
				t.Fatalf("got %+v, %v", result, err)
			}
		})
	}
	result, err := Check(testEvent(t, `"title":"OTHER-1 OPS-2 TEAM-3","head":{"ref":"feature/TEAM-3-OPS-4-OTHER-5"}`), "TEAM,OPS")
	if err != nil || !reflect.DeepEqual(result.References, []string{"OPS-2", "TEAM-3", "OPS-4"}) {
		t.Fatalf("combined references: %+v, %v", result, err)
	}
	result, err = Check(testEvent(t, `"title":"OTHER-1","head":{"ref":"feature/TEAM-2-fix"}`), "TEAM")
	if err != nil || !reflect.DeepEqual(result.References, []string{"TEAM-2"}) {
		t.Fatalf("allowed branch: %+v, %v", result, err)
	}
	for _, title := range []string{"OTHER-1", "TE-1", "TEAM2-1", "XTEAM-1", "team-1", "TEAM-01", "No reference"} {
		event := Event{PullRequest: &PullRequest{Number: 42, Title: title}}
		if _, err := Check(event, "TEAM"); err == nil || !strings.Contains(err.Error(), "allowed project (TEAM)") {
			t.Fatalf("%s: got %v", title, err)
		}
	}
	for _, project := range []string{"A2", "AB", strings.Repeat("A", 255)} {
		event := Event{PullRequest: &PullRequest{Number: 42, Title: project + "-1"}}
		result, err := Check(event, project)
		if err != nil || !reflect.DeepEqual(result.References, []string{project + "-1"}) {
			t.Fatalf("valid project %q: %+v, %v", project, result, err)
		}
	}
	for _, project := range []string{
		"A", strings.Repeat("A", 256), "team", "2TEAM", "MY_TEAM", "TEAM-1", "TÉAM",
		"TEAM.*", "TEAM|OPS", "*", "TEAM OPS", "TEAM\nOPS", ",", ",TEAM", "TEAM,", "TEAM,,OPS", "TEAM, ,OPS", "TEAM,ops",
	} {
		if _, err := Check(testEvent(t, `"title":"TEAM-1"`), project); err == nil || !strings.Contains(err.Error(), "Invalid project-keys") {
			t.Fatalf("invalid project %q: got %v", project, err)
		}
	}
	if _, err := Check(testEvent(t, ""), " OPS,TEAM,OPS "); err == nil || !strings.Contains(err.Error(), "allowed project (OPS, TEAM)") {
		t.Fatalf("project order/deduplication: %v", err)
	}
}

func TestExemptionsPrecedeProjectConfiguration(t *testing.T) {
	for _, fields := range []string{`"user":{"type":"Bot"}`, `"title":"INC123456"`, `"title":"REQ1234"`, `"labels":[{"name":"no issue reference"}]`} {
		for _, projects := range []string{"TEAM", "invalid"} {
			result, err := Check(testEvent(t, fields), projects)
			if err != nil || len(result.References) != 0 {
				t.Fatalf("%s, %s: %+v, %v", fields, projects, result, err)
			}
		}
	}
}
