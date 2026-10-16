package action

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

const testSecret = `{"email":"ci@example.com","apiToken":"secret-token"}`

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func httpResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}

func jsonResponse(status int, body any) *http.Response {
	data, _ := json.Marshal(body)
	return httpResponse(status, string(data))
}

func issueData(category string) map[string]any {
	return map[string]any{"fields": map[string]any{
		"status":  map[string]any{"statusCategory": map[string]any{"key": category}},
		"project": map[string]any{"key": "TEAM"}, "components": []any{},
	}}
}

func jiraEvent(t *testing.T, action string) Event {
	event := testEvent(t, `"title":"TEAM-1: Fix","html_url":"https://github.com/OpenAI/codex/pull/42"`)
	event.Action = action
	event.Repository.FullName = "OpenAI/codex"
	return event
}

func syntaxResult(refs ...string) Result {
	return Result{Status: "passed", Reason: "Jira reference found", References: refs}
}

func jiraInputs() Inputs { return Inputs{JiraSecret: testSecret, JiraURL: "https://jira.example.com"} }

type mockIssue struct {
	status int
	body   any
	err    error
}

func mockJira(t *testing.T, issues map[string]mockIssue, failLink string) (*http.Client, *[]string) {
	t.Helper()
	var calls []string
	client := &http.Client{Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		path := strings.TrimPrefix(req.URL.Path, "/rest/api/3")
		calls = append(calls, req.Method+" "+path)
		key := strings.Split(path, "/")[2]
		switch req.Method {
		case "PUT":
			return httpResponse(204, ""), nil
		case "POST":
			if !strings.HasSuffix(path, "/remotelink") {
				t.Errorf("unexpected creation: %s", path)
				return nil, errors.New("unexpected creation")
			}
			if key == failLink {
				return jsonResponse(403, map[string]any{"errorMessages": []string{"No linking permission"}}), nil
			}
			return jsonResponse(200, map[string]any{"id": 1}), nil
		}
		issue, ok := issues[key]
		if !ok {
			t.Errorf("unexpected issue: %s", key)
			return nil, errors.New("unexpected issue")
		}
		if issue.err != nil {
			return nil, issue.err
		}
		if issue.status == 0 {
			issue.status = 200
		}
		return jsonResponse(issue.status, issue.body), nil
	})}
	return client, &calls
}

func TestJiraAbsentSecretAndExemptions(t *testing.T) {
	for _, inputs := range []Inputs{{}, {JiraSecret: " "}, {RemoteLinks: "true"}, {Components: "false"}, {Components: "invalid"}, {JiraSecret: "", JiraURL: "invalid"}} {
		calls := 0
		client := &http.Client{Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) {
			calls++
			return nil, errors.New("must not request")
		})}
		original := syntaxResult("TEAM-1")
		result, err := ApplyJira(context.Background(), original, jiraEvent(t, "opened"), inputs, client, nil)
		if err != nil || !reflect.DeepEqual(result, original) || calls != 0 {
			t.Fatalf("absent secret: %+v, %v, calls=%d", result, err, calls)
		}
	}
	for _, original := range []Result{{Status: "skipped", References: []string{}}, {Status: "passed", References: []string{}}} {
		result, err := ApplyJira(context.Background(), original, jiraEvent(t, "opened"), Inputs{JiraSecret: "invalid", RemoteLinks: "true"}, nil, nil)
		if err != nil || !reflect.DeepEqual(result, original) {
			t.Fatalf("exemption: %+v, %v", result, err)
		}
	}
}

func TestJiraRejectedIssuesPreventEveryWrite(t *testing.T) {
	missing := mockIssue{status: 404, body: map[string]any{"errorMessages": []string{"Issue does not exist or you do not have permission to see it."}}}
	for _, tc := range []struct {
		name, want string
		issues     map[string]mockIssue
	}{
		{"missing", "TEAM-1: not found or inaccessible", map[string]mockIssue{"TEAM-1": missing}},
		{"Done", "TEAM-1: Done", map[string]mockIssue{"TEAM-1": {body: issueData("done")}}},
		{"mixed", "TEAM-2: Done; TEAM-3: not found or inaccessible", map[string]mockIssue{
			"TEAM-1": {body: issueData("new")}, "TEAM-2": {body: issueData("done")}, "TEAM-3": missing,
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			refs := []string{"TEAM-1"}
			if tc.name == "mixed" {
				refs = append(refs, "TEAM-2", "TEAM-3")
			}
			client, calls := mockJira(t, tc.issues, "")
			inputs := jiraInputs()
			inputs.RemoteLinks = "true"
			_, err := ApplyJira(context.Background(), syntaxResult(refs...), jiraEvent(t, "opened"), inputs, client, nil)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v; want %s", err, tc.want)
			}
			for _, call := range *calls {
				if !strings.HasPrefix(call, "GET ") {
					t.Fatalf("rejected issue allowed a write: %v", *calls)
				}
			}
		})
	}
	for _, known := range []mockIssue{missing, {body: issueData("done")}} {
		for _, errorFirst := range []bool{true, false} {
			refs := []string{"TEAM-1", "ERR-1"}
			if errorFirst {
				refs[0], refs[1] = refs[1], refs[0]
			}
			client, _ := mockJira(t, map[string]mockIssue{"TEAM-1": known, "ERR-1": {err: errors.New("secret-token")}}, "")
			if _, err := ApplyJira(context.Background(), syntaxResult(refs...), jiraEvent(t, "opened"), jiraInputs(), client, nil); err == nil || !strings.Contains(err.Error(), "Referenced Jira issues must exist") {
				t.Fatalf("known rejection lost to unrelated failure: %v", err)
			}
		}
	}
}

func TestJiraFallback(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
		err    error
	}{
		{"network", 0, "", errors.New("Authorization: secret-token")},
		{"unauthorized", 401, "secret-token", nil},
		{"permission", 403, "secret-token", nil},
		{"rate limit", 429, "secret-token", nil},
		{"timeout", 0, "", context.DeadlineExceeded},
		{"HTML404", 404, "<html>secret-token</html>", nil},
		{"empty404", 404, "", nil},
		{"routing404", 404, `{"errorMessages":["route not found"]}`, nil},
		{"malformedJSON", 200, "secret-token", nil},
		{"unknownCategory", 200, `{"fields":{"status":{"statusCategory":{"key":"unexpected"}}}}`, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			client := &http.Client{Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
				calls++
				if req.Method != "GET" {
					t.Errorf("unverified write: %s", req.Method)
				}
				return httpResponse(tc.status, tc.body), tc.err
			})}
			inputs := jiraInputs()
			inputs.RemoteLinks = "true"
			var logs []string
			result, err := ApplyJira(context.Background(), syntaxResult("TEAM-1"), jiraEvent(t, "opened"), inputs, client, func(message string) { logs = append(logs, message) })
			if err != nil || result.Status != "passed" || !strings.Contains(result.Reason, "regex-only") || calls != 1 {
				t.Fatalf("got %+v, %v, calls=%d", result, err, calls)
			}
			if strings.Contains(result.Reason+strings.Join(logs, ""), "secret-token") {
				t.Fatal("leaked Jira credentials")
			}
		})
	}
}

func TestJiraConfigurationFallback(t *testing.T) {
	for _, change := range []func(*Inputs){
		func(in *Inputs) { in.JiraSecret = "invalid" },
		func(in *Inputs) { in.JiraURL = "invalid" },
		func(in *Inputs) { in.RemoteLinks = "yes" },
		func(in *Inputs) { in.Components = "yes" },
		func(in *Inputs) { in.Components = "TRUE" },
	} {
		inputs := jiraInputs()
		change(&inputs)
		result, err := ApplyJira(context.Background(), syntaxResult("TEAM-1"), jiraEvent(t, "opened"), inputs, nil, nil)
		if err != nil || result.Status != "passed" || !strings.Contains(result.Reason, "configuration unavailable") {
			t.Fatalf("got %+v, %v", result, err)
		}
	}
}

func TestJiraLogsSemanticFailures(t *testing.T) {
	for _, tc := range []struct {
		name, body, wantLog, wantReason string
		links                           bool
	}{
		{
			name:       "unknown status category",
			body:       `{"fields":{"status":{"statusCategory":{"key":"unexpected"}}}}`,
			wantLog:    "Jira validation for TEAM-1: Jira response is missing a recognized status category",
			wantReason: "regex-only",
		},
		{
			name:       "missing component metadata",
			body:       `{"fields":{"status":{"statusCategory":{"key":"new"}}}}`,
			wantLog:    "Jira component assignment for TEAM-1: Jira issue is missing project or component information",
			wantReason: "Some Jira repository components could not be assigned",
		},
		{
			name:       "invalid remote link",
			body:       `{"fields":{"status":{"statusCategory":{"key":"new"}}}}`,
			wantLog:    "Jira remote link for TEAM-1: Invalid pull request link",
			wantReason: "Some Jira remote links could not be created",
			links:      true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client := &http.Client{Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
				if req.Method != http.MethodGet {
					t.Fatalf("unexpected write: %s", req.Method)
				}
				return httpResponse(200, tc.body), nil
			})}
			inputs := jiraInputs()
			event := jiraEvent(t, "opened")
			if tc.links {
				inputs.RemoteLinks, inputs.Components = "true", "false"
				event.PullRequest.HTMLURL = ""
			}
			var logs []string
			result, err := ApplyJira(context.Background(), syntaxResult("TEAM-1"), event, inputs, client, func(message string) { logs = append(logs, message) })
			if err != nil || result.Status != "passed" || !strings.Contains(result.Reason, tc.wantReason) {
				t.Fatalf("got %+v, %v", result, err)
			}
			if !strings.Contains(strings.Join(logs, "\n"), tc.wantLog) {
				t.Fatalf("logs = %q, want %q", logs, tc.wantLog)
			}
		})
	}
}

func TestJiraWritesOnlyVerifiedIssuesAfterAllReads(t *testing.T) {
	client, calls := mockJira(t, map[string]mockIssue{
		"TEAM-1": {body: issueData("new")}, "ERR-1": {status: 503, body: "Unavailable"}, "TEAM-2": {body: issueData("indeterminate")},
	}, "")
	inputs := jiraInputs()
	inputs.RemoteLinks = "true"
	result, err := ApplyJira(context.Background(), syntaxResult("TEAM-1", "ERR-1", "TEAM-2"), jiraEvent(t, "opened"), inputs, client, nil)
	if err != nil || result.Status != "passed" || !strings.Contains(result.Reason, "regex-only") || !strings.Contains(result.Reason, "Some Jira repository components") || !strings.Contains(result.Reason, "Some Jira remote links") {
		t.Fatalf("got %+v, %v", result, err)
	}
	want := []string{"GET /issue/TEAM-1", "GET /issue/ERR-1", "GET /issue/TEAM-2", "PUT /issue/TEAM-1", "PUT /issue/TEAM-2", "POST /issue/TEAM-1/remotelink", "POST /issue/TEAM-2/remotelink"}
	if !reflect.DeepEqual(*calls, want) {
		t.Fatalf("requests=%v; want %v", *calls, want)
	}
}

func TestJiraParentChecksRemainExcluded(t *testing.T) {
	data := issueData("new")
	data["fields"].(map[string]any)["parent"] = map[string]any{"key": "EPIC-1", "fields": issueData("done")["fields"]}
	client, calls := mockJira(t, map[string]mockIssue{"TEAM-1": {body: data}, "EPIC-1": {body: issueData("done")}}, "")
	inputs := jiraInputs()
	inputs.RemoteLinks = "true"
	result, err := ApplyJira(context.Background(), syntaxResult("TEAM-1"), jiraEvent(t, "opened"), inputs, client, nil)
	if err != nil || result.Status != "passed" || !reflect.DeepEqual(*calls, []string{"GET /issue/TEAM-1", "PUT /issue/TEAM-1", "POST /issue/TEAM-1/remotelink"}) {
		t.Fatalf("parent must not be fetched: %+v, %v, requests=%v", result, err, *calls)
	}
	if _, err := ApplyJira(context.Background(), syntaxResult("TEAM-1", "EPIC-1"), jiraEvent(t, "opened"), inputs, client, nil); err == nil || !strings.Contains(err.Error(), "EPIC-1: Done") {
		t.Fatalf("explicit parent reference must be checked: %v", err)
	}
}

func TestJiraWritesOnlyOnOpened(t *testing.T) {
	for _, activity := range []string{"edited", "synchronize", "reopened", "labeled", "unlabeled", "ready_for_review", "converted_to_draft", ""} {
		t.Run(activity, func(t *testing.T) {
			client, calls := mockJira(t, map[string]mockIssue{"TEAM-1": {body: issueData("new")}}, "")
			inputs := jiraInputs()
			inputs.RemoteLinks = "true"
			result, err := ApplyJira(context.Background(), syntaxResult("TEAM-1"), jiraEvent(t, activity), inputs, client, nil)
			if err != nil || !strings.Contains(result.Reason, "Referenced Jira issues exist") || !reflect.DeepEqual(*calls, []string{"GET /issue/TEAM-1"}) {
				t.Fatalf("got %+v, %v, requests=%v", result, err, *calls)
			}
			client, _ = mockJira(t, map[string]mockIssue{"TEAM-1": {body: issueData("done")}}, "")
			if _, err := ApplyJira(context.Background(), syntaxResult("TEAM-1"), jiraEvent(t, activity), inputs, client, nil); err == nil {
				t.Fatal("Done issue passed validation")
			}
		})
	}
	for _, links := range []string{"true", "false"} {
		inputs := jiraInputs()
		inputs.RemoteLinks = links
		original := syntaxResult("TEAM-1")
		result, err := ApplyJira(context.Background(), original, jiraEvent(t, "closed"), inputs, nil, nil)
		if err != nil || !reflect.DeepEqual(result, original) {
			t.Fatalf("closed event must not access Jira: %+v, %v", result, err)
		}
	}
}

func TestJiraComponentsOptionalAndLinkFailures(t *testing.T) {
	for _, option := range []string{"false", " false "} {
		client, calls := mockJira(t, map[string]mockIssue{"TEAM-1": {body: issueData("new")}, "TEAM-2": {body: issueData("new")}}, "TEAM-1")
		inputs := jiraInputs()
		inputs.Components, inputs.RemoteLinks = option, " true "
		event := jiraEvent(t, "opened")
		event.Repository.FullName = ""
		result, err := ApplyJira(context.Background(), syntaxResult("TEAM-1", "TEAM-2"), event, inputs, client, nil)
		want := []string{"GET /issue/TEAM-1", "GET /issue/TEAM-2", "POST /issue/TEAM-1/remotelink", "POST /issue/TEAM-2/remotelink"}
		if err != nil || strings.Contains(strings.ToLower(result.Reason), "component") || !strings.Contains(result.Reason, "Some Jira remote links could not be created") || !reflect.DeepEqual(*calls, want) {
			t.Fatalf("got %+v, %v, requests=%v", result, err, *calls)
		}
	}
	for _, components := range []string{"", " ", "true", " true "} {
		client, calls := mockJira(t, map[string]mockIssue{"TEAM-1": {body: issueData("new")}}, "")
		inputs := jiraInputs()
		inputs.Components = components
		result, err := ApplyJira(context.Background(), syntaxResult("TEAM-1"), jiraEvent(t, "opened"), inputs, client, nil)
		if err != nil || !strings.Contains(result.Reason, "Jira repository component assigned") || !reflect.DeepEqual(*calls, []string{"GET /issue/TEAM-1", "PUT /issue/TEAM-1"}) {
			t.Fatalf("components default/enabled: %+v, %v, requests=%v", result, err, *calls)
		}
	}
}

func TestJiraComponentFailureDoesNotBlockLinks(t *testing.T) {
	for _, invalidRepository := range []string{"", "repo", "org/repo/extra"} {
		client, calls := mockJira(t, map[string]mockIssue{"TEAM-1": {body: issueData("new")}}, "")
		inputs := jiraInputs()
		inputs.RemoteLinks = "true"
		event := jiraEvent(t, "opened")
		event.Repository.FullName = invalidRepository
		result, err := ApplyJira(context.Background(), syntaxResult("TEAM-1"), event, inputs, client, nil)
		if err != nil || !strings.Contains(result.Reason, "Some Jira repository components") || !strings.Contains(result.Reason, "Jira PR remote links created") || !reflect.DeepEqual(*calls, []string{"GET /issue/TEAM-1", "POST /issue/TEAM-1/remotelink"}) {
			t.Fatalf("got %+v, %v, requests=%v", result, err, *calls)
		}
	}
	client, _ := mockJira(t, map[string]mockIssue{"TEAM-1": {body: issueData("new")}}, "")
	transport := client.Transport
	client.Transport = roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		if req.Method == "PUT" {
			return jsonResponse(403, map[string]any{"errorMessages": []string{"Cannot edit"}}), nil
		}
		return transport.RoundTrip(req)
	})
	inputs := jiraInputs()
	inputs.RemoteLinks = "true"
	result, err := ApplyJira(context.Background(), syntaxResult("TEAM-1"), jiraEvent(t, "opened"), inputs, client, nil)
	if err != nil || !strings.Contains(result.Reason, "Some Jira repository components") || !strings.Contains(result.Reason, "Jira PR remote links created") {
		t.Fatalf("component errors must not block links: %+v, %v", result, err)
	}
}
