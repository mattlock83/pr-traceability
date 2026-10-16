package jira

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

const componentTestName = "OpenAI/codex"

type componentRequest struct {
	method string
	path   string
	body   map[string]any
	status int
}

type componentMock struct {
	t         *testing.T
	issues    map[string]*Issue
	projects  map[string][]Component
	requests  []*componentRequest
	nextID    int
	intercept func(*componentRequest) *http.Response
}

func componentIssue(project string, components ...Component) *Issue {
	return &Issue{StatusCategory: "new", Project: project, Components: append([]Component{}, components...)}
}

func newComponentMock(t *testing.T) *componentMock {
	t.Helper()
	return &componentMock{t: t, issues: map[string]*Issue{"TEAM-1": componentIssue("TEAM")}, projects: make(map[string][]Component), nextID: 100}
}

func componentJSON(status int, data any) *http.Response {
	body, _ := json.Marshal(data)
	return clientResponse(status, string(body))
}

func (m *componentMock) transport(request *http.Request) (*http.Response, error) {
	m.t.Helper()
	recorded := &componentRequest{method: request.Method, path: strings.TrimPrefix(request.URL.Path, "/jira/rest/api/3")}
	if request.Body != nil {
		if err := json.NewDecoder(request.Body).Decode(&recorded.body); err != nil {
			m.t.Fatalf("invalid request JSON: %v", err)
		}
	}
	m.requests = append(m.requests, recorded)
	respond := func(response *http.Response) (*http.Response, error) {
		recorded.status = response.StatusCode
		return response, nil
	}
	if m.intercept != nil {
		if response := m.intercept(recorded); response != nil {
			return respond(response)
		}
	}
	if strings.HasPrefix(recorded.path, "/project/") {
		project := strings.Split(recorded.path, "/")[2]
		components := m.projects[project]
		if components == nil {
			components = []Component{}
		}
		return respond(componentJSON(200, components))
	}
	if recorded.path == "/component" {
		project, name := text(recorded.body["project"]), text(recorded.body["name"])
		for _, component := range m.projects[project] {
			if strings.EqualFold(component.Name, name) {
				return respond(componentJSON(400, map[string]any{"errors": map[string]string{"name": "Component already exists"}}))
			}
		}
		component := Component{ID: strconv.Itoa(m.nextID), Name: name}
		m.nextID++
		m.projects[project] = append(m.projects[project], component)
		return respond(componentJSON(201, component))
	}
	parts := strings.Split(recorded.path, "/")
	if len(parts) < 3 || parts[1] != "issue" {
		m.t.Fatalf("unexpected path %q", recorded.path)
	}
	issue := m.issues[parts[2]]
	if issue == nil {
		m.t.Fatalf("unexpected issue %q", parts[2])
	}
	if recorded.method == http.MethodPut {
		if len(recorded.body) != 1 {
			m.t.Errorf("update must only add a component: %#v", recorded.body)
		}
		updates, ok := object(recorded.body["update"])["components"].([]any)
		if !ok || len(updates) != 1 {
			m.t.Fatalf("invalid component update: %#v", recorded.body)
		}
		target := object(object(updates[0])["add"])
		if len(target) != 1 {
			m.t.Errorf("add must identify the component once: %#v", target)
		}
		var found *Component
		for _, component := range m.projects[issue.Project] {
			if target["id"] == component.ID || target["id"] == nil && target["name"] == component.Name {
				copy := component
				found = &copy
				break
			}
		}
		if found == nil {
			return respond(componentJSON(400, map[string]any{
				"errorMessages": []string{}, "errors": map[string]string{"components": "Component name '" + text(target["name"]) + "' is not valid"},
			}))
		}
		for _, assigned := range issue.Components {
			if assigned.ID == found.ID {
				m.t.Errorf("duplicate component assignment: %#v", found)
			}
		}
		issue.Components = append(issue.Components, *found)
		return respond(clientResponse(204, ""))
	}
	return respond(componentJSON(200, map[string]any{"fields": map[string]any{
		"status":  map[string]any{"statusCategory": map[string]string{"key": issue.StatusCategory}},
		"project": map[string]string{"key": issue.Project}, "components": issue.Components,
	}}))
}

func (m *componentMock) client() *Client { return newTestClient(m.t, m.transport, nil) }

func getComponentIssue(t *testing.T, client *Client, reference string) *Issue {
	t.Helper()
	issue, err := client.GetIssue(context.Background(), reference)
	if err != nil || issue == nil {
		t.Fatalf("GetIssue(%q) = %#v, %v", reference, issue, err)
	}
	return issue
}

func assignComponent(t *testing.T, client *Client, reference string, issue *Issue) {
	t.Helper()
	if err := client.AssignRepositoryComponent(context.Background(), reference, issue, componentTestName); err != nil {
		t.Fatal(err)
	}
}

func componentRequestSummary(requests []*componentRequest) []string {
	var summary []string
	for _, request := range requests {
		summary = append(summary, fmt.Sprintf("%s %s %d", request.method, request.path, request.status))
	}
	return summary
}

func TestComponentsCreateAndAssignOncePreservingExisting(t *testing.T) {
	mock := newComponentMock(t)
	mock.issues["TEAM-1"] = componentIssue("TEAM", Component{ID: "7"})
	client := mock.client()
	assignComponent(t, client, "TEAM-1", getComponentIssue(t, client, "TEAM-1"))
	rerun := mock.client()
	assignComponent(t, rerun, "TEAM-1", getComponentIssue(t, rerun, "TEAM-1"))
	if got, want := mock.projects["TEAM"], []Component{{ID: "100", Name: componentTestName}}; !reflect.DeepEqual(got, want) {
		t.Errorf("project components = %#v, want %#v", got, want)
	}
	if got, want := mock.issues["TEAM-1"].Components, []Component{{ID: "7"}, {ID: "100", Name: componentTestName}}; !reflect.DeepEqual(got, want) {
		t.Errorf("issue components = %#v, want %#v", got, want)
	}
	want := []string{"GET /issue/TEAM-1 200", "PUT /issue/TEAM-1 400", "POST /component 201", "PUT /issue/TEAM-1 204", "GET /issue/TEAM-1 200"}
	if got := componentRequestSummary(mock.requests); !reflect.DeepEqual(got, want) {
		t.Errorf("requests = %v, want %v", got, want)
	}
}

func TestComponentsAlreadyAssignedNeedsNoRequests(t *testing.T) {
	for _, name := range []string{componentTestName, "openai/Codex"} {
		t.Run(name, func(t *testing.T) {
			mock := newComponentMock(t)
			issue := componentIssue("TEAM", Component{ID: "8", Name: name})
			assignComponent(t, mock.client(), "TEAM-1", issue)
			if len(mock.requests) != 0 {
				t.Fatalf("requests = %v", componentRequestSummary(mock.requests))
			}
		})
	}
}

func TestComponentsExistingUnassignedNeedsOnePUT(t *testing.T) {
	mock := newComponentMock(t)
	mock.projects["TEAM"] = []Component{{ID: "8", Name: componentTestName}}
	assignComponent(t, mock.client(), "TEAM-1", componentIssue("TEAM"))
	if got, want := componentRequestSummary(mock.requests), []string{"PUT /issue/TEAM-1 204"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("requests = %v, want %v", got, want)
	}
	want := map[string]any{"update": map[string]any{"components": []any{map[string]any{"add": map[string]any{"name": componentTestName}}}}}
	if !reflect.DeepEqual(mock.requests[0].body, want) {
		t.Errorf("PUT body = %#v, want %#v", mock.requests[0].body, want)
	}
}

func TestComponentsMissingNeedsThreeCalls(t *testing.T) {
	mock := newComponentMock(t)
	assignComponent(t, mock.client(), "TEAM-1", componentIssue("TEAM"))
	if got, want := componentRequestSummary(mock.requests), []string{"PUT /issue/TEAM-1 400", "POST /component 201", "PUT /issue/TEAM-1 204"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("requests = %v, want %v", got, want)
	}
	if !reflect.DeepEqual(mock.requests[1].body, map[string]any{"name": componentTestName, "project": "TEAM"}) {
		t.Errorf("creation body = %#v", mock.requests[1].body)
	}
}

func TestComponentsReuseCaseInsensitiveNameAndCreationForbidden(t *testing.T) {
	for _, forbidden := range []bool{false, true} {
		t.Run(strconv.FormatBool(forbidden), func(t *testing.T) {
			mock := newComponentMock(t)
			component := Component{ID: "8", Name: "openai/Codex"}
			mock.projects["TEAM"] = []Component{component}
			if forbidden {
				mock.intercept = func(request *componentRequest) *http.Response {
					if request.path == "/component" {
						return componentJSON(403, map[string]any{"errorMessages": []string{"No permission to create components"}})
					}
					return nil
				}
			}
			assignComponent(t, mock.client(), "TEAM-1", componentIssue("TEAM"))
			if !reflect.DeepEqual(mock.projects["TEAM"], []Component{component}) || !reflect.DeepEqual(mock.issues["TEAM-1"].Components, []Component{component}) {
				t.Fatalf("case variant was not reused: project %#v, issue %#v", mock.projects, mock.issues["TEAM-1"])
			}
			if len(mock.requests) != 4 || mock.requests[2].path != "/project/TEAM/components" {
				t.Errorf("requests = %v", componentRequestSummary(mock.requests))
			}
		})
	}
}

func TestComponentsCachedFromLaterValidatedIssue(t *testing.T) {
	mock := newComponentMock(t)
	component := Component{ID: "8", Name: "openai/Codex"}
	mock.issues["TEAM-2"] = componentIssue("TEAM", component)
	mock.projects["TEAM"] = []Component{component}
	client := mock.client()
	first := getComponentIssue(t, client, "TEAM-1")
	second := getComponentIssue(t, client, "TEAM-2")
	assignComponent(t, client, "TEAM-1", first)
	assignComponent(t, client, "TEAM-2", second)
	want := []string{"GET /issue/TEAM-1 200", "GET /issue/TEAM-2 200", "PUT /issue/TEAM-1 204"}
	if got := componentRequestSummary(mock.requests); !reflect.DeepEqual(got, want) {
		t.Fatalf("requests = %v, want %v", got, want)
	}
	add := object(object(object(mock.requests[2].body["update"])["components"].([]any)[0])["add"])
	if !reflect.DeepEqual(add, map[string]any{"id": "8"}) {
		t.Errorf("cached component assignment = %#v", add)
	}
}

func TestComponentsCachedIDAlreadyAssignedNeedsNoPUT(t *testing.T) {
	mock := newComponentMock(t)
	mock.issues["TEAM-2"] = componentIssue("TEAM", Component{ID: "8", Name: componentTestName})
	client := mock.client()
	getComponentIssue(t, client, "TEAM-2")
	assignComponent(t, client, "TEAM-1", componentIssue("TEAM", Component{ID: "8"}))
	if len(mock.requests) != 1 {
		t.Errorf("unexpected calls: %v", componentRequestSummary(mock.requests))
	}
}

func TestComponentsExistingNameSharedAcrossIssues(t *testing.T) {
	mock := newComponentMock(t)
	mock.issues["TEAM-2"] = componentIssue("TEAM")
	mock.projects["TEAM"] = []Component{{ID: "8", Name: componentTestName}}
	client := mock.client()
	assignComponent(t, client, "TEAM-1", componentIssue("TEAM"))
	assignComponent(t, client, "TEAM-2", componentIssue("TEAM"))
	want := []string{"PUT /issue/TEAM-1 204", "PUT /issue/TEAM-2 204"}
	if got := componentRequestSummary(mock.requests); !reflect.DeepEqual(got, want) {
		t.Fatalf("requests = %v, want %v", got, want)
	}
}

func TestComponentsCreateOncePerActualProject(t *testing.T) {
	mock := newComponentMock(t)
	mock.issues["TEAM-2"] = componentIssue("TEAM")
	mock.issues["OLD-3"] = componentIssue("OPS")
	client := mock.client()
	for _, reference := range []string{"TEAM-1", "TEAM-2", "OLD-3"} {
		assignComponent(t, client, reference, getComponentIssue(t, client, reference))
	}
	var projects []string
	for _, request := range mock.requests {
		if request.path == "/component" {
			projects = append(projects, text(request.body["project"]))
		}
		if strings.HasPrefix(request.path, "/project/") {
			t.Errorf("unnecessary project lookup: %#v", request)
		}
	}
	if !reflect.DeepEqual(projects, []string{"TEAM", "OPS"}) {
		t.Errorf("created projects = %v", projects)
	}
	for _, reference := range []string{"TEAM-1", "TEAM-2", "OLD-3"} {
		if len(mock.issues[reference].Components) != 1 {
			t.Errorf("%s components = %#v", reference, mock.issues[reference].Components)
		}
	}
}

func TestComponentsRecoverConcurrentCreation(t *testing.T) {
	mock := newComponentMock(t)
	mock.intercept = func(request *componentRequest) *http.Response {
		if request.path == "/component" {
			mock.projects["TEAM"] = []Component{{ID: "9", Name: componentTestName}}
			return componentJSON(400, map[string]any{"errors": map[string]string{"name": "Component already exists"}})
		}
		return nil
	}
	assignComponent(t, mock.client(), "TEAM-1", componentIssue("TEAM"))
	if got, want := componentRequestSummary(mock.requests), []string{"PUT /issue/TEAM-1 400", "POST /component 400", "GET /project/TEAM/components 200", "PUT /issue/TEAM-1 204"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("requests = %v, want %v", got, want)
	}
	if got := mock.issues["TEAM-1"].Components; !reflect.DeepEqual(got, []Component{{ID: "9", Name: componentTestName}}) {
		t.Errorf("assigned components = %#v", got)
	}
}

func TestComponentsInvalidCreateOrLookupNeverAssigns(t *testing.T) {
	cases := []struct {
		name   string
		create *http.Response
		list   *http.Response
	}{
		{"list forbidden", componentJSON(400, map[string]any{}), clientResponse(403, "forbidden")},
		{"malformed list", componentJSON(400, map[string]any{}), componentJSON(200, map[string]any{})},
		{"list null", componentJSON(400, map[string]any{}), componentJSON(200, nil)},
		{"existing ID missing", componentJSON(400, map[string]any{}), componentJSON(200, []map[string]any{{"name": componentTestName}})},
		{"existing ID numeric", componentJSON(400, map[string]any{}), componentJSON(200, []map[string]any{{"id": 8, "name": componentTestName}})},
		{"creation forbidden", componentJSON(403, map[string]any{}), componentJSON(200, []any{})},
		{"creation rejected", componentJSON(400, map[string]any{"errors": map[string]string{"name": "Rejected"}}), componentJSON(200, []any{})},
		{"created ID missing", componentJSON(201, map[string]any{"name": componentTestName}), nil},
		{"created ID numeric", componentJSON(201, map[string]any{"id": 8, "name": componentTestName}), nil},
		{"created name wrong", componentJSON(201, Component{ID: "8", Name: "Other/repo"}), nil},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			mock := newComponentMock(t)
			mock.intercept = func(request *componentRequest) *http.Response {
				if request.path == "/component" {
					return test.create
				}
				if strings.HasPrefix(request.path, "/project/") {
					return test.list
				}
				return nil
			}
			if err := mock.client().AssignRepositoryComponent(context.Background(), "TEAM-1", componentIssue("TEAM"), componentTestName); err == nil {
				t.Fatal("expected error")
			}
			if len(mock.issues["TEAM-1"].Components) != 0 {
				t.Fatalf("unverified component assigned: %#v", mock.issues["TEAM-1"].Components)
			}
		})
	}
}

func TestComponentsUnrelated400NeverCreates(t *testing.T) {
	missing := "Component name '" + componentTestName + "' is not valid"
	for _, body := range []string{
		`{"errors":{"components":"Field is not editable"}}`,
		`{"errors":{"summary":"Summary is required"}}`,
		`{"errors":{"components":"Invalid operation"}}`,
		`{"errors":{"components":"Component name 'Other/repo' is not valid"}}`,
		`{"errors":{"components":"` + missing + `","summary":"Summary is required"}}`,
		`{"errors":{"components":"` + missing + `"},"errorMessages":["Issue cannot be edited"]}`,
		`{"errors":{"components":"` + missing + `"},"errorMessages":{}}`,
		`{"errors":{"components":"` + missing + `"},"errorMessages":"bad"}`,
		`{}`, `null`, `[]`,
	} {
		t.Run(body, func(t *testing.T) {
			mock := newComponentMock(t)
			mock.intercept = func(request *componentRequest) *http.Response {
				if request.method == http.MethodPut {
					return clientResponse(400, body)
				}
				return nil
			}
			var logs []string
			client := newTestClient(t, mock.transport, &logs)
			if err := client.AssignRepositoryComponent(context.Background(), "TEAM-1", componentIssue("TEAM"), componentTestName); err == nil {
				t.Fatal("expected error")
			}
			if len(mock.requests) != 1 || len(mock.projects) != 0 {
				t.Fatalf("unexpected creation or lookup: %v", componentRequestSummary(mock.requests))
			}
			if len(logs) != 1 || !strings.Contains(logs[0], "PUT /issue/TEAM-1: 400") || strings.Contains(logs[0], "Authorization") {
				t.Errorf("logs = %v", logs)
			}
		})
	}
}

func TestComponentsMissingErrorMessagesMayBeAbsentOrNull(t *testing.T) {
	for _, suffix := range []string{"", `,"errorMessages":null`} {
		t.Run(suffix, func(t *testing.T) {
			mock := newComponentMock(t)
			first := true
			mock.intercept = func(request *componentRequest) *http.Response {
				if request.method == http.MethodPut && first {
					first = false
					return clientResponse(400, `{"errors":{"components":"Component name '`+componentTestName+`' is not valid"}`+suffix+`}`)
				}
				return nil
			}
			assignComponent(t, mock.client(), "TEAM-1", componentIssue("TEAM"))
			if len(mock.requests) != 3 {
				t.Errorf("requests = %v", componentRequestSummary(mock.requests))
			}
		})
	}
}

func TestComponentsInvalidMetadataSendsNoRequests(t *testing.T) {
	for _, issue := range []*Issue{nil, {}, {Project: "TEAM"}, {Components: []Component{}}, {Project: " ", Components: []Component{}}, {Project: "TEAM", Components: []Component{{}}}} {
		t.Run(fmt.Sprintf("%#v", issue), func(t *testing.T) {
			mock := newComponentMock(t)
			if err := mock.client().AssignRepositoryComponent(context.Background(), "TEAM-1", issue, componentTestName); err == nil || !strings.Contains(err.Error(), "missing project or component") {
				t.Fatalf("error = %v", err)
			}
			if len(mock.requests) != 0 {
				t.Errorf("unexpected requests: %v", componentRequestSummary(mock.requests))
			}
		})
	}
}

func TestComponentsMetadataDoesNotPreventStatusValidation(t *testing.T) {
	for _, metadata := range []string{
		``, `,"project":null,"components":null`, `,"project":{},"components":{}`,
		`,"project":42,"components":[]`, `,"project":[],"components":true`,
		`,"project":{"key":42},"components":[]`, `,"project":{"key":"TEAM"},"components":[null]`,
		`,"project":{"key":"TEAM"},"components":[{"id":8}]`,
		`,"project":{"key":"TEAM"},"components":[{"id":8,"name":"OpenAI/codex"}]`,
		`,"project":{"key":"TEAM"},"components":[{"id":"8","name":42}]`,
		`,"project":{"key":"TEAM"},"components":[{"id":"8","name":"OpenAI/codex"},42]`,
	} {
		t.Run(metadata, func(t *testing.T) {
			requests := 0
			client := newTestClient(t, func(*http.Request) (*http.Response, error) {
				requests++
				return clientResponse(200, `{"fields":{"status":{"statusCategory":{"key":"done"}}`+metadata+`}}`), nil
			}, nil)
			issue, err := client.GetIssue(context.Background(), "TEAM-1")
			if err != nil || issue.StatusCategory != "done" {
				t.Fatalf("status validation lost: %#v, %v", issue, err)
			}
			if err := client.AssignRepositoryComponent(context.Background(), "TEAM-1", issue, componentTestName); err == nil {
				t.Fatal("malformed component metadata should prevent assignment")
			}
			if requests != 1 {
				t.Fatal("malformed component metadata triggered a write")
			}
		})
	}
}

func TestComponentsCreationFailureCachedAcrossProjectIssues(t *testing.T) {
	mock := newComponentMock(t)
	mock.issues["TEAM-2"] = componentIssue("TEAM")
	mock.intercept = func(request *componentRequest) *http.Response {
		if request.path == "/component" {
			return componentJSON(403, map[string]any{"errorMessages": []string{"Forbidden"}})
		}
		return nil
	}
	client := mock.client()
	for _, reference := range []string{"TEAM-1", "TEAM-2"} {
		if err := client.AssignRepositoryComponent(context.Background(), reference, componentIssue("TEAM"), componentTestName); err == nil {
			t.Fatal("expected cached creation failure")
		}
	}
	if got, want := componentRequestSummary(mock.requests), []string{"PUT /issue/TEAM-1 400", "POST /component 403", "GET /project/TEAM/components 200"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("requests = %v, want %v", got, want)
	}
}

func TestComponentsCachedUpdateFailureAndDirectUpdateFailures(t *testing.T) {
	for _, cached := range []bool{false, true} {
		t.Run(strconv.FormatBool(cached), func(t *testing.T) {
			mock := newComponentMock(t)
			mock.intercept = func(request *componentRequest) *http.Response {
				if request.method == http.MethodPut {
					return clientResponse(403, "Forbidden")
				}
				return nil
			}
			client := mock.client()
			if cached {
				mock.issues["TEAM-2"] = componentIssue("TEAM", Component{ID: "8", Name: componentTestName})
				getComponentIssue(t, client, "TEAM-2")
			}
			issue := componentIssue("TEAM")
			if err := client.AssignRepositoryComponent(context.Background(), "TEAM-1", issue, componentTestName); err == nil {
				t.Fatal("expected update failure")
			}
			if len(issue.Components) != 0 {
				t.Error("failed assignment changed issue metadata")
			}
		})
	}
}

func TestComponentsEnsureRequestFailure(t *testing.T) {
	for _, path := range []string{"/component", "/project/TEAM/components"} {
		t.Run(path, func(t *testing.T) {
			mock := newComponentMock(t)
			mock.intercept = func(request *componentRequest) *http.Response {
				if request.path == path {
					return clientResponse(503, "Jira unavailable")
				}
				if request.path == "/component" {
					return componentJSON(400, map[string]any{})
				}
				return nil
			}
			if err := mock.client().AssignRepositoryComponent(context.Background(), "TEAM-1", componentIssue("TEAM"), componentTestName); err == nil {
				t.Fatal("expected request failure")
			}
		})
	}
}
