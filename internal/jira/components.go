package jira

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
)

// Component identifies a Jira project component. Jira component IDs are strings.
type Component struct {
	ID   string `json:"id,omitempty"`
	Name string `json:"name,omitempty"`
}

type componentResult struct {
	component Component
	err       error
}

func componentKey(project, name string) string { return project + "/" + strings.ToLower(name) }

func (c *Client) readComponentMetadata(issue *Issue, project, components json.RawMessage) {
	// Decode optional metadata separately so a malformed field cannot hide Done.
	var metadata struct {
		Key string `json:"key"`
	}
	if json.Unmarshal(project, &metadata) == nil {
		issue.Project = metadata.Key
	}
	if json.Unmarshal(components, &issue.Components) != nil {
		issue.Components = nil
		return
	}
	// Validation already returns components; share their IDs across the project.
	for _, component := range issue.Components {
		if nonempty(issue.Project) && nonempty(component.ID) && nonempty(component.Name) {
			c.components[componentKey(issue.Project, component.Name)] = componentResult{component: component}
		}
	}
}

func (c *Client) ensureComponent(ctx context.Context, project, name string) (Component, error) {
	status, data, err := c.request(ctx, http.MethodPost, "/component", map[string]string{"name": name, "project": project}, 201, 400, 403)
	if err != nil {
		return Component{}, err
	}
	var component Component
	if status == http.StatusCreated {
		if json.Unmarshal(data, &component) != nil {
			return Component{}, errors.New("Invalid Jira component response")
		}
	} else {
		_, data, err = c.request(ctx, http.MethodGet, "/project/"+url.PathEscape(project)+"/components", nil, 200)
		if err != nil {
			return Component{}, err
		}
		var candidates []Component
		if json.Unmarshal(data, &candidates) != nil || candidates == nil {
			return Component{}, errors.New("Invalid Jira project components response")
		}
		for _, candidate := range candidates {
			if strings.EqualFold(candidate.Name, name) {
				component = candidate
				break
			}
		}
	}
	if !nonempty(component.ID) || !strings.EqualFold(component.Name, name) {
		return Component{}, errors.New("Invalid Jira component response")
	}
	return component, nil
}

// AssignRepositoryComponent preserves the issue's current components and avoids
// extra lookups: an existing name needs one PUT, a missing name needs three calls.
func (c *Client) AssignRepositoryComponent(ctx context.Context, reference string, issue *Issue, name string) error {
	if issue == nil || !nonempty(issue.Project) || issue.Components == nil {
		return errors.New("Jira issue is missing project or component information")
	}
	for _, component := range issue.Components {
		if !nonempty(component.ID) && !nonempty(component.Name) {
			return errors.New("Jira issue is missing project or component information")
		}
	}
	key := componentKey(issue.Project, name)
	for _, component := range issue.Components {
		if strings.EqualFold(component.Name, name) {
			c.components[key] = componentResult{component: component}
			return nil
		}
	}
	result, cached := c.components[key]
	if result.err != nil {
		return result.err
	}
	component := result.component
	if !cached {
		component = Component{Name: name}
		status, data, err := c.updateComponent(ctx, reference, component, 204, 400)
		if err != nil {
			return err
		}
		if status == http.StatusNoContent {
			c.components[key] = componentResult{component: component}
			issue.Components = append(issue.Components, component)
			return nil
		}
		// Other 400s can mean the field is not editable; only create for a missing name.
		var response struct {
			Errors        map[string]string `json:"errors"`
			ErrorMessages []json.RawMessage `json:"errorMessages"`
		}
		if json.Unmarshal(data, &response) != nil || len(response.Errors) != 1 ||
			response.Errors["components"] != "Component name '"+name+"' is not valid" || len(response.ErrorMessages) != 0 {
			return errors.New("Jira rejected the component assignment")
		}
		component, err = c.ensureComponent(ctx, issue.Project, name)
		c.components[key] = componentResult{component: component, err: err}
		if err != nil {
			return err
		}
	}
	if component.ID != "" {
		for _, assigned := range issue.Components {
			if assigned.ID == component.ID {
				return nil
			}
		}
	}
	if _, _, err := c.updateComponent(ctx, reference, component, 204); err != nil {
		return err
	}
	issue.Components = append(issue.Components, component)
	return nil
}

func (c *Client) updateComponent(ctx context.Context, reference string, component Component, statuses ...int) (int, json.RawMessage, error) {
	value := map[string]string{"name": component.Name}
	if component.ID != "" {
		value = map[string]string{"id": component.ID}
	}
	body := map[string]any{"update": map[string]any{"components": []any{map[string]any{"add": value}}}}
	return c.request(ctx, http.MethodPut, "/issue/"+url.PathEscape(reference), body, statuses...)
}
