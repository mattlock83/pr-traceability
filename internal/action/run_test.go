package action

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func testEnvironment(t *testing.T, event Event) map[string]string {
	t.Helper()
	directory := t.TempDir()
	eventPath := filepath.Join(directory, "event.json")
	outputPath := filepath.Join(directory, "output")
	data, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(eventPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outputPath, []byte("previous=value\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return map[string]string{"GITHUB_EVENT_NAME": "pull_request", "GITHUB_EVENT_PATH": eventPath, "GITHUB_OUTPUT": outputPath}
}

func readOutput(t *testing.T, env map[string]string) string {
	t.Helper()
	data, err := os.ReadFile(env["GITHUB_OUTPUT"])
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestRunWithoutJira(t *testing.T) {
	env := testEnvironment(t, testEvent(t, `"title":"TEAM-1 and OPS-2"`))
	var logs bytes.Buffer
	calls := 0
	client := &http.Client{Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) {
		calls++
		return jsonResponse(500, nil), nil
	})}
	result, err := Run(context.Background(), func(key string) string { return env[key] }, &logs, client)
	if err != nil || result.Status != "passed" || calls != 0 {
		t.Fatalf("got %+v, %v, calls=%d", result, err, calls)
	}
	if got := readOutput(t, env); got != "previous=value\nresult=passed\njira-references=[\"TEAM-1\",\"OPS-2\"]\n" {
		t.Fatalf("outputs: %q", got)
	}
	if !strings.Contains(logs.String(), "passed: Jira reference found") {
		t.Fatalf("missing result log: %q", logs.String())
	}
	env["INPUT_PROJECT-KEYS"] = "OPS"
	result, err = Run(context.Background(), func(key string) string { return env[key] }, &logs, client)
	if err != nil || !reflect.DeepEqual(result.References, []string{"OPS-2"}) || !strings.HasSuffix(readOutput(t, env), "result=passed\njira-references=[\"OPS-2\"]\n") {
		t.Fatalf("project input/output: %+v, %v", result, err)
	}
}

func TestRunServiceNowBypassesJira(t *testing.T) {
	for _, reference := range []string{"INC123456", "REQ001234"} {
		t.Run(reference, func(t *testing.T) {
			event := jiraEvent(t, "opened")
			event.PullRequest.Title = reference + ": fix TEAM-1"
			env := testEnvironment(t, event)
			env["INPUT_PROJECT-KEYS"] = "invalid"
			env["INPUT_JIRA-SECRET"] = testSecret
			env["INPUT_JIRA-URL"] = "https://jira.example.com"
			env["INPUT_JIRA-REMOTE-LINKS"] = "true"
			env["INPUT_JIRA-COMPONENTS"] = "true"
			calls := 0
			client := &http.Client{Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) {
				calls++
				return jsonResponse(500, nil), nil
			})}
			var logs bytes.Buffer
			result, err := Run(context.Background(), func(key string) string { return env[key] }, &logs, client)
			if err != nil || result.Status != "passed" || len(result.References) != 0 || calls != 0 {
				t.Fatalf("got %+v, %v, calls=%d", result, err, calls)
			}
			if readOutput(t, env) != "previous=value\nresult=passed\njira-references=[]\n" {
				t.Fatal("incorrect exemption outputs")
			}
		})
	}
}

func TestRunJiraInputsAndRemoteLink(t *testing.T) {
	event := jiraEvent(t, "opened")
	event.PullRequest.Title = "OTHER-1 TEAM-1"
	env := testEnvironment(t, event)
	env["INPUT_PROJECT-KEYS"], env["INPUT_JIRA-URL"] = "TEAM", "https://jira.example.com"
	env["INPUT_JIRA-SECRET"], env["INPUT_JIRA-REMOTE-LINKS"], env["INPUT_JIRA-COMPONENTS"] = testSecret, "true", "false"
	var calls []string
	client := &http.Client{Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		calls = append(calls, req.Method+" "+req.URL.String())
		if req.Method == "GET" {
			// Disabling components needs no project or component metadata.
			return httpResponse(200, `{"fields":{"status":{"statusCategory":{"key":"new"}}}}`), nil
		}
		var body map[string]any
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		object := body["object"].(map[string]any)
		if body["globalId"] != "OpenAI/codex/42" || object["title"] != "PR #42: OTHER-1 TEAM-1" || len(object) != 2 {
			t.Fatalf("unexpected remote link: %+v", body)
		}
		return jsonResponse(201, map[string]any{"id": 1}), nil
	})}
	var logs bytes.Buffer
	result, err := Run(context.Background(), func(key string) string { return env[key] }, &logs, client)
	want := []string{"GET https://jira.example.com/rest/api/3/issue/TEAM-1?fields=status,project,components", "POST https://jira.example.com/rest/api/3/issue/TEAM-1/remotelink"}
	if err != nil || !reflect.DeepEqual(result.References, []string{"TEAM-1"}) || !strings.Contains(result.Reason, "PR remote links created") || strings.Contains(result.Reason, "component") || !reflect.DeepEqual(calls, want) {
		t.Fatalf("got %+v, %v, requests=%v", result, err, calls)
	}
}

func TestRunJiraFailurePaths(t *testing.T) {
	for _, reject := range []bool{true, false} {
		env := testEnvironment(t, testEvent(t, `"title":"TEAM-1 and OPS-2"`))
		env["INPUT_JIRA-SECRET"], env["INPUT_JIRA-URL"] = testSecret, "https://jira.example.com"
		var logs bytes.Buffer
		client := &http.Client{Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) {
			if reject {
				return jsonResponse(200, issueData("done")), nil
			}
			return httpResponse(503, "Jira temporarily unavailable"), nil
		})}
		result, err := Run(context.Background(), func(key string) string { return env[key] }, &logs, client)
		if reject {
			if err == nil || !strings.Contains(err.Error(), "TEAM-1: Done; OPS-2: Done") || readOutput(t, env) != "previous=value\n" || logs.Len() != 0 {
				t.Fatalf("rejection: %+v, %v, logs=%q", result, err, logs.String())
			}
		} else if err != nil || result.Status != "passed" || !strings.Contains(result.Reason, "regex-only") || !strings.Contains(logs.String(), "503; body: \"Jira temporarily unavailable\"") {
			t.Fatalf("fallback: %+v, %v, logs=%q", result, err, logs.String())
		}
	}
}

func TestRunInputAndOutputFailures(t *testing.T) {
	for _, tc := range []struct {
		name, want string
		change     func(map[string]string)
	}{
		{"event name", "requires a pull_request", func(env map[string]string) { env["GITHUB_EVENT_NAME"] = "push" }},
		{"event path", "Cannot read GITHUB_EVENT_PATH", func(env map[string]string) { env["GITHUB_EVENT_PATH"] += ".missing" }},
		{"malformed JSON", "Cannot decode pull request event", func(env map[string]string) {
			if err := os.WriteFile(env["GITHUB_EVENT_PATH"], []byte("{"), 0o600); err != nil {
				t.Fatal(err)
			}
		}},
		{"absent PR", "must contain a pull request", func(env map[string]string) {
			if err := os.WriteFile(env["GITHUB_EVENT_PATH"], []byte("{}"), 0o600); err != nil {
				t.Fatal(err)
			}
		}},
		{"project restriction", "allowed project (OTHER)", func(env map[string]string) { env["INPUT_PROJECT-KEYS"] = "OTHER" }},
		{"invalid project input", "Invalid project-keys", func(env map[string]string) { env["INPUT_PROJECT-KEYS"] = "TEAM," }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := testEnvironment(t, testEvent(t, `"title":"TEAM-1"`))
			tc.change(env)
			var logs bytes.Buffer
			_, err := Run(context.Background(), func(key string) string { return env[key] }, &logs, nil)
			if err == nil || !strings.Contains(err.Error(), tc.want) || readOutput(t, env) != "previous=value\n" || logs.Len() != 0 {
				t.Fatalf("got %v, logs=%q", err, logs.String())
			}
		})
	}
	for _, output := range []string{"directory", "nested"} {
		env := testEnvironment(t, testEvent(t, `"title":"TEAM-1"`))
		if output == "directory" {
			env["GITHUB_OUTPUT"] = t.TempDir()
		} else {
			env["GITHUB_OUTPUT"] = filepath.Join(t.TempDir(), "missing", "output")
		}
		var logs bytes.Buffer
		if _, err := Run(context.Background(), func(key string) string { return env[key] }, &logs, nil); err == nil || err.Error() != "Cannot write GITHUB_OUTPUT" {
			t.Fatalf("unwritable output: %v", err)
		}
	}
}

func TestRunTargetAndClosedEvents(t *testing.T) {
	for _, kind := range []string{"pull_request", "pull_request_target"} {
		event := jiraEvent(t, "closed")
		env := testEnvironment(t, event)
		env["GITHUB_EVENT_NAME"] = kind
		env["INPUT_JIRA-SECRET"] = testSecret
		env["INPUT_JIRA-REMOTE-LINKS"] = "true"
		delete(env, "GITHUB_OUTPUT")
		var logs bytes.Buffer
		result, err := Run(context.Background(), func(key string) string { return env[key] }, &logs, nil)
		if err != nil || result.Status != "passed" || !strings.Contains(result.Reason, "Jira reference found") {
			t.Fatalf("closed/target: %+v, %v", result, err)
		}
	}
}

func TestEscapeAnnotation(t *testing.T) {
	if got := EscapeAnnotation("bad%\r\n::warning::injected"); got != "bad%25%0D%0A::warning::injected" {
		t.Fatalf("got %q", got)
	}
}
