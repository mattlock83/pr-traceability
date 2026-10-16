package jira

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

const clientTestSecret = `{"email":"ci@example.com","apiToken":"secret-token"}`
const clientTestURL = "https://jira.example.com/jira/"

type clientTransport func(*http.Request) (*http.Response, error)

func (f clientTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func clientResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: http.Header{"X-Private-Header": []string{"must-not-appear"}}, Body: io.NopCloser(strings.NewReader(body))}
}

func clientIssueBody(category string) string {
	return `{"fields":{"status":{"name":"Custom status","statusCategory":{"key":"` + category + `"}}}}`
}

// Request assertions inspect the JSON wire format independently of response types.
func object(value any) map[string]any {
	result, _ := value.(map[string]any)
	return result
}

func text(value any) string {
	result, _ := value.(string)
	return result
}

func newTestClient(t *testing.T, transport clientTransport, logs *[]string) *Client {
	t.Helper()
	log := func(string) {}
	if logs != nil {
		log = func(message string) { *logs = append(*logs, message) }
	}
	client, err := New(clientTestSecret, clientTestURL, &http.Client{Transport: transport}, log)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestClientAuthenticationAndRequest(t *testing.T) {
	client := newTestClient(t, func(request *http.Request) (*http.Response, error) {
		if got, want := request.URL.String(), "https://jira.example.com/jira/rest/api/3/issue/TEAM-1?fields=status,project,components"; got != want {
			t.Errorf("URL = %q, want %q", got, want)
		}
		if request.Method != http.MethodGet {
			t.Errorf("method = %q", request.Method)
		}
		for name, want := range map[string]string{
			"Authorization": "Basic " + base64.StdEncoding.EncodeToString([]byte("ci@example.com:secret-token")),
			"Accept":        "application/json", "Content-Type": "application/json",
			"Accept-Language": "en-US", "X-Force-Accept-Language": "true",
		} {
			if got := request.Header.Get(name); got != want {
				t.Errorf("%s = %q, want %q", name, got, want)
			}
		}
		if deadline, ok := request.Context().Deadline(); !ok || time.Until(deadline) > 10*time.Second {
			t.Error("request must have a deadline of at most 10 seconds")
		}
		return clientResponse(200, clientIssueBody("new")), nil
	}, nil)
	issue, err := client.GetIssue(context.Background(), "TEAM-1")
	if err != nil || issue.StatusCategory != "new" {
		t.Fatalf("GetIssue = %#v, %v", issue, err)
	}
}

func TestClientConfigurableEndpoint(t *testing.T) {
	for _, baseURL := range []string{"https://example.atlassian.net", "https://api.atlassian.com/ex/jira/cloud-id"} {
		t.Run(baseURL, func(t *testing.T) {
			secret := `{"email":"ci@example.com","apiToken":"secret-token","baseUrl":"` + baseURL + `"}`
			transport := clientTransport(func(request *http.Request) (*http.Response, error) {
				if got, want := request.URL.String(), baseURL+"/rest/api/3/issue/TEAM-1?fields=status,project,components"; got != want {
					t.Errorf("URL = %q, want %q", got, want)
				}
				return clientResponse(200, clientIssueBody("new")), nil
			})
			client, err := New(secret, "", &http.Client{Transport: transport}, nil)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := client.GetIssue(context.Background(), "TEAM-1"); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestClientExplicitURLAndEncodedReference(t *testing.T) {
	transport := clientTransport(func(request *http.Request) (*http.Response, error) {
		if got, want := request.URL.String(), "https://jira.example.com/jira/rest/api/3/issue/TEAM%2F1%3Fsecret?fields=status,project,components"; got != want {
			t.Errorf("URL = %q, want %q", got, want)
		}
		return clientResponse(200, clientIssueBody("new")), nil
	})
	client, err := New(`{"email":"ci@example.com","apiToken":"secret-token","baseUrl":"https://unused.example"}`, "  "+clientTestURL+"  ", &http.Client{Transport: transport}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.GetIssue(context.Background(), "TEAM/1?secret"); err != nil {
		t.Fatal(err)
	}
}

func TestClientInvalidConfiguration(t *testing.T) {
	for _, secret := range []string{
		"not-json", "null", "{}", `{"token":""}`, `{"username":"bad:name","password":"secret"}`,
		`{"email":"bad:name","apiToken":"secret"}`, `{"email":"ci@example.com","apiToken":" "}`,
		`{"email":" ","apiToken":"secret"}`, `{"token":"secret-token"}`, `{"username":"ci","password":"secret"}`,
		`{"email":42,"apiToken":"secret"}`, `{"email":"ci@example.com","apiToken":42}`, `[]`,
	} {
		t.Run(secret, func(t *testing.T) {
			_, err := New(secret, clientTestURL, nil, nil)
			if err == nil || err.Error() != "Invalid Jira URL or credentials" {
				t.Fatalf("error = %v", err)
			}
		})
	}
	for _, baseURL := range []string{"", "not-a-url", "http://jira.internal:8080/jira", "file:///tmp/jira", "https://user:secret@example.com", "https://example.com?secret", "https://example.com#secret", "https:///jira", "https://example.com:%xx"} {
		t.Run(baseURL, func(t *testing.T) {
			_, err := New(clientTestSecret, baseURL, nil, nil)
			if err == nil || err.Error() != "Invalid Jira URL or credentials" {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestClientCopiesHTTPClientAndPreservesTimeout(t *testing.T) {
	for _, timeout := range []time.Duration{0, time.Second, time.Minute} {
		original := &http.Client{Timeout: timeout}
		client, err := New(clientTestSecret, clientTestURL, original, nil)
		if err != nil {
			t.Fatal(err)
		}
		if original.Timeout != timeout || original.CheckRedirect != nil {
			t.Fatal("New mutated the caller's HTTP client")
		}
		if client.http.Timeout != timeout {
			t.Errorf("timeout = %s, want %s", client.http.Timeout, timeout)
		}
	}
	client, err := New(clientTestSecret, clientTestURL, nil, nil)
	if err != nil || client.http.Timeout != 0 {
		t.Fatalf("default client = %#v, %v", client, err)
	}
}

func TestClientUsesShorterHTTPTimeout(t *testing.T) {
	original := &http.Client{
		Timeout: 10 * time.Millisecond,
		Transport: clientTransport(func(request *http.Request) (*http.Response, error) {
			<-request.Context().Done()
			return nil, request.Context().Err()
		}),
	}
	client, err := New(clientTestSecret, clientTestURL, original, nil)
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	if _, err := client.GetIssue(context.Background(), "TEAM-1"); err == nil || err.Error() != "Jira request failed or returned an invalid response" {
		t.Fatalf("error = %v", err)
	}
	if time.Since(started) > time.Second {
		t.Error("the caller's shorter timeout was not honored")
	}
}

func TestClientDoesNotFollowRedirects(t *testing.T) {
	requests := 0
	client := newTestClient(t, func(request *http.Request) (*http.Response, error) {
		requests++
		response := clientResponse(http.StatusFound, "redirect diagnostic")
		response.Header.Set("Location", "/redirect-target")
		return response, nil
	}, nil)
	if _, err := client.GetIssue(context.Background(), "TEAM-1"); err == nil || requests != 1 {
		t.Fatalf("redirect followed: requests = %d, error = %v", requests, err)
	}
}

func TestClientStatusCategories(t *testing.T) {
	for _, category := range []string{"new", "indeterminate", "done"} {
		t.Run(category, func(t *testing.T) {
			client := newTestClient(t, func(*http.Request) (*http.Response, error) {
				return clientResponse(200, clientIssueBody(category)), nil
			}, nil)
			issue, err := client.GetIssue(context.Background(), "TEAM-1")
			if err != nil || issue.StatusCategory != category {
				t.Fatalf("GetIssue = %#v, %v", issue, err)
			}
		})
	}
}

func TestClientMissingIssueDistinction(t *testing.T) {
	for _, body := range []string{"", "<html>secret-token</html>", "{", "null", "{}", `{"errorMessages":"` + missingIssueMessage + `"}`, `{"errorMessages":["route not found"]}`} {
		t.Run(body, func(t *testing.T) {
			client := newTestClient(t, func(*http.Request) (*http.Response, error) { return clientResponse(404, body), nil }, nil)
			issue, err := client.GetIssue(context.Background(), "TEAM-1")
			if err == nil || strings.Contains(err.Error(), "secret-token") || issue != nil {
				t.Fatalf("unrecognized 404 = %#v, %v", issue, err)
			}
		})
	}
	var logs []string
	client := newTestClient(t, func(*http.Request) (*http.Response, error) {
		return clientResponse(404, `{"errorMessages":["`+missingIssueMessage+`"],"errors":{}}`), nil
	}, &logs)
	issue, err := client.GetIssue(context.Background(), "TEAM-1")
	if err != nil || issue != nil || len(logs) != 1 || !strings.Contains(logs[0], "404") || !strings.Contains(logs[0], missingIssueMessage) {
		t.Fatalf("recognized 404 = %#v, %v; logs %v", issue, err, logs)
	}
}

func TestClientRecognizesMissingIssueAmongOtherErrorValues(t *testing.T) {
	client := newTestClient(t, func(*http.Request) (*http.Response, error) {
		return clientResponse(404, `{"errorMessages":[42,null,{},"`+missingIssueMessage+`"],"errors":false}`), nil
	}, nil)
	issue, err := client.GetIssue(context.Background(), "TEAM-1")
	if issue != nil || err != nil {
		t.Fatalf("canonical missing issue was lost: %#v, %v", issue, err)
	}
}

func TestClientMalformedIssueResponses(t *testing.T) {
	for _, body := range []string{"null", "{}", "[]", clientIssueBody("unexpected"), `{"fields":{"status":{"statusCategory":{"key":123}}}}`} {
		t.Run(body, func(t *testing.T) {
			client := newTestClient(t, func(*http.Request) (*http.Response, error) { return clientResponse(200, body), nil }, nil)
			_, err := client.GetIssue(context.Background(), "TEAM-1")
			if err == nil || !strings.Contains(err.Error(), "missing a recognized status category") {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestClientHTTPAndJSONFailuresAreSanitized(t *testing.T) {
	for _, status := range []int{200, 301, 302, 401, 403, 429, 500} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			client := newTestClient(t, func(*http.Request) (*http.Response, error) { return clientResponse(status, "secret-token"), nil }, nil)
			_, err := client.GetIssue(context.Background(), "TEAM-1")
			if err == nil || err.Error() != "Jira request failed or returned an invalid response" {
				t.Fatalf("error = %v", err)
			}
		})
	}
	client := newTestClient(t, func(*http.Request) (*http.Response, error) {
		return clientResponse(200, clientIssueBody("new")+" null"), nil
	}, nil)
	if _, err := client.GetIssue(context.Background(), "TEAM-1"); err == nil {
		t.Error("trailing JSON must be rejected")
	}
}

func TestClientDiagnosticsQuoteBodiesAndOmitHeaders(t *testing.T) {
	for _, status := range []int{200, 302, 401, 403, 404, 429, 500} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var logs []string
			client := newTestClient(t, func(*http.Request) (*http.Response, error) {
				return clientResponse(status, "Upstream \"diagnostic\"\r\n::error::plain text\x00\x1b[31m"), nil
			}, &logs)
			if _, err := client.GetIssue(context.Background(), "TEAM-1"); err == nil {
				t.Fatal("expected error")
			}
			if len(logs) != 1 || !strings.Contains(logs[0], `body: "Upstream \"diagnostic\"\r\n::error::plain text\x00\x1b[31m"`) {
				t.Fatalf("logs = %v", logs)
			}
			for _, forbidden := range []string{"Authorization", "Accept", "X-Private-Header", "must-not-appear", "\r", "\n", "\x00", "\x1b"} {
				if strings.Contains(logs[0], forbidden) {
					t.Errorf("log contains %q: %s", forbidden, logs[0])
				}
			}
		})
	}
}

func TestClientRedactsEchoedCredentials(t *testing.T) {
	var logs []string
	encoded := base64.StdEncoding.EncodeToString([]byte("ci@example.com:secret-token"))
	client := newTestClient(t, func(*http.Request) (*http.Response, error) {
		return clientResponse(401, "Denied: secret-token ci@example.com Basic "+encoded+" "+clientTestSecret), nil
	}, &logs)
	if _, err := client.GetIssue(context.Background(), "TEAM-1"); err == nil {
		t.Fatal("expected error")
	}
	if len(logs) != 1 || !strings.Contains(logs[0], "Denied: [REDACTED]") {
		t.Fatalf("logs = %v", logs)
	}
	for _, value := range []string{clientTestSecret, encoded, "secret-token", "ci@example.com"} {
		if strings.Contains(logs[0], value) {
			t.Errorf("credential %q leaked in log", value)
		}
	}
}

type clientBrokenBody struct{}

func (clientBrokenBody) Read([]byte) (int, error) { return 0, errors.New("secret-token") }
func (clientBrokenBody) Close() error             { return nil }

func TestClientTransportAndBodyReadFailures(t *testing.T) {
	for _, transport := range []clientTransport{
		func(*http.Request) (*http.Response, error) {
			return nil, errors.New("Authorization: secret-token; X-Private: hidden")
		},
		func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Body: clientBrokenBody{}}, nil
		},
	} {
		var logs []string
		client := newTestClient(t, transport, &logs)
		_, err := client.GetIssue(context.Background(), "TEAM-1")
		if err == nil || err.Error() != "Jira request failed or returned an invalid response" {
			t.Fatalf("error = %v", err)
		}
		if len(logs) != 1 || !strings.HasSuffix(logs[0], `body: "Response body unavailable"`) || strings.Contains(logs[0], "secret-token") || strings.Contains(logs[0], "X-Private") {
			t.Fatalf("logs = %v", logs)
		}
	}
}

func TestClientCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	client := newTestClient(t, func(request *http.Request) (*http.Response, error) {
		cancel()
		<-request.Context().Done()
		return nil, errors.New("secret-token")
	}, nil)
	if _, err := client.GetIssue(ctx, "TEAM-1"); err == nil || strings.Contains(err.Error(), "secret-token") {
		t.Fatalf("error = %v", err)
	}
}

func TestClientExpiredDeadlineDoesNotStartAnotherRequest(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	calls := 0
	var logs []string
	client := newTestClient(t, func(*http.Request) (*http.Response, error) {
		calls++
		return clientResponse(200, clientIssueBody("new")), nil
	}, &logs)
	if _, err := client.GetIssue(ctx, "TEAM-1"); err == nil || calls != 0 {
		t.Fatalf("expired request: err=%v, calls=%d", err, calls)
	}
	if len(logs) != 1 || !strings.HasSuffix(logs[0], `body: "Response body unavailable"`) {
		t.Fatalf("logs = %v", logs)
	}
}

func TestClientSuccessfulResponseIsNotLogged(t *testing.T) {
	var logs []string
	client := newTestClient(t, func(*http.Request) (*http.Response, error) { return clientResponse(200, clientIssueBody("new")), nil }, &logs)
	if _, err := client.GetIssue(context.Background(), "TEAM-1"); err != nil {
		t.Fatal(err)
	}
	if len(logs) != 0 {
		t.Fatalf("logs = %v", logs)
	}
}

func TestClientRemoteLinkIdentityAndTitle(t *testing.T) {
	var requests []map[string]any
	client := newTestClient(t, func(request *http.Request) (*http.Response, error) {
		if request.Method != http.MethodPost || request.URL.Path != "/jira/rest/api/3/issue/TEAM-1/remotelink" {
			t.Fatalf("unexpected request %s %s", request.Method, request.URL)
		}
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		requests = append(requests, body)
		if len(requests) == 1 {
			return clientResponse(201, `{"id":123}`), nil
		}
		return clientResponse(200, `{"id":"123"}`), nil
	}, nil)
	prURL := "https://github.example.com/org/repo/pull/42"
	for _, title := range []string{"TEAM-1: Fix login", "TEAM-1: Fix login", "Updated title"} {
		if err := client.UpsertPullRequestLink(context.Background(), "TEAM-1", prURL, 42, title); err != nil {
			t.Fatal(err)
		}
	}
	for i, body := range requests {
		if body["globalId"] != "org/repo/42" || body["relationship"] != "implemented by" {
			t.Errorf("request %d = %#v", i, body)
		}
		application := object(body["application"])
		if application["type"] != "net.phrond.pr-traceability" || application["name"] != "GitHub" {
			t.Errorf("application = %#v", application)
		}
		link := object(body["object"])
		if len(link) != 2 || link["url"] != prURL {
			t.Errorf("link = %#v", link)
		}
		want := "PR #42: TEAM-1: Fix login"
		if i == 2 {
			want = "PR #42: Updated title"
		}
		if link["title"] != want {
			t.Errorf("title = %q, want %q", link["title"], want)
		}
	}
}

func TestClientRemoteLinkIdentitiesDistinguishRepositories(t *testing.T) {
	for _, identity := range []string{"org/repo/42", "other/repo/42", "org/other/42", "org/repo/43"} {
		t.Run(identity, func(t *testing.T) {
			parts := strings.Split(identity, "/")
			var number int64 = 42
			if parts[2] == "43" {
				number = 43
			}
			client := newTestClient(t, func(request *http.Request) (*http.Response, error) {
				var body map[string]any
				_ = json.NewDecoder(request.Body).Decode(&body)
				if body["globalId"] != identity {
					t.Errorf("identity = %q, want %q", body["globalId"], identity)
				}
				return clientResponse(200, `{"id":1}`), nil
			}, nil)
			if err := client.UpsertPullRequestLink(context.Background(), "TEAM-1", "https://github.com/"+parts[0]+"/"+parts[1]+"/pull/"+parts[2], number, "Fix"); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestClientInvalidRemoteLinksNeverSendRequests(t *testing.T) {
	client := newTestClient(t, func(*http.Request) (*http.Response, error) {
		t.Fatal("invalid PR link must not send a request")
		return nil, nil
	}, nil)
	for _, prURL := range []string{
		"", "file:///tmp/pr", "https://github.com/repo/pull/1", "https://github.com/org/repo/issues/1",
		"https://github.com/org/repo/pull/2", "https://user:secret@github.com/org/repo/pull/1",
		"https://github.com/org/repo/pull/1?secret", "https://github.com/org/repo/pull/1#secret",
		"https://github.com/org/repo/pull/01", "https://github.com/org/repo/pull/1/extra", "http:///org/repo/pull/1",
	} {
		t.Run(prURL, func(t *testing.T) {
			if err := client.UpsertPullRequestLink(context.Background(), "TEAM-1", prURL, 1, "Fix"); err == nil || err.Error() != "Invalid pull request link" {
				t.Fatalf("error = %v", err)
			}
		})
	}
	if err := client.UpsertPullRequestLink(context.Background(), "TEAM-1", "https://github.com/org/repo/pull/1", 0, "Fix"); err == nil {
		t.Error("zero PR number must be rejected")
	}
}

func TestClientRemoteLinkSuccessDoesNotInterpretUnusedID(t *testing.T) {
	for _, body := range []string{`{}`, `null`, `{"id":null}`, `{"id":123}`, `{"id":"123"}`} {
		t.Run(body, func(t *testing.T) {
			client := newTestClient(t, func(*http.Request) (*http.Response, error) { return clientResponse(200, body), nil }, nil)
			if err := client.UpsertPullRequestLink(context.Background(), "TEAM-1", "https://github.com/org/repo/pull/1", 1, "Fix"); err != nil {
				t.Fatalf("successful remote link rejected: %v", err)
			}
		})
	}
}

func TestClientRemoteLinkInvalidJSONStillFails(t *testing.T) {
	for _, body := range []string{"", "{", "unexpected HTML", `{} {}`} {
		t.Run(body, func(t *testing.T) {
			var logs []string
			client := newTestClient(t, func(*http.Request) (*http.Response, error) { return clientResponse(201, body), nil }, &logs)
			if err := client.UpsertPullRequestLink(context.Background(), "TEAM-1", "https://github.com/org/repo/pull/1", 1, "Fix"); err == nil {
				t.Fatal("invalid JSON must still fail")
			}
			if len(logs) != 1 || !strings.Contains(logs[0], "POST /issue/TEAM-1/remotelink: 201") {
				t.Fatalf("logs = %v", logs)
			}
		})
	}
}

func TestClientRemoteLinkFailureLogsBody(t *testing.T) {
	var logs []string
	client := newTestClient(t, func(*http.Request) (*http.Response, error) {
		return clientResponse(403, `{"errorMessages":["Issue linking is disabled"]}`), nil
	}, &logs)
	if err := client.UpsertPullRequestLink(context.Background(), "TEAM-1", "https://github.com/org/repo/pull/42", 42, "Fix"); err == nil {
		t.Fatal("expected error")
	}
	if len(logs) != 1 || !strings.Contains(logs[0], "POST /issue/TEAM-1/remotelink: 403") || !strings.Contains(logs[0], "Issue linking is disabled") {
		t.Fatalf("logs = %v", logs)
	}
}
