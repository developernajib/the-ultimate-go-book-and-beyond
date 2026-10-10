## 41.10 Exercises with Solutions

### Exercise 1: Implement Breaking Change Detection

**Problem:** Build a tool that compares two OpenAPI specs and detects breaking changes.

**Solution:**

Two details in this solution are worth reading closely, because both are traps that produce a tool which looks like it works.

The first is `typesChanged`. `Schema.Type` is a `*openapi3.Types`, a pointer to a slice of type names (a slice because OpenAPI 3.1 permits unions like `["string","null"]`). The obvious `oldProp.Value.Type != newProp.Value.Type` compiles cleanly and is completely wrong: it compares pointer addresses, which are different for every separately parsed schema. A detector written that way reports a type change on every field of every endpoint, so it blocks every PR, and the team's response is to disable it. Compare the slices by value, sorted, so that `["string","null"]` and `["null","string"]` are recognized as the same type.

The second is error handling in `main`. Discarding the error from `LoadFromFile` means a renamed or missing spec file yields a nil document, zero detected changes, and a green check. A gate that silently passes when it cannot read its inputs is worse than no gate, because the team now trusts it. Exit non-zero on a load failure, with a distinct code from the one used for "breaking changes found," so CI can tell "the tool broke" apart from "the API broke."

```go
// ... imports omitted for brevity (fmt, os, slices,
// github.com/getkin/kin-openapi/openapi3)

type BreakingChange struct {
    Type        string
    Path        string
    Description string
    Severity    string // "breaking", "warning"
}

type BreakingChangeDetector struct {
    oldSpec *openapi3.T
    newSpec *openapi3.T
}

func NewDetector(oldSpec, newSpec *openapi3.T) *BreakingChangeDetector {
    return &BreakingChangeDetector{
        oldSpec: oldSpec,
        newSpec: newSpec,
    }
}

func (d *BreakingChangeDetector) DetectChanges() []BreakingChange {
    var changes []BreakingChange

    changes = append(changes, d.detectRemovedPaths()...)
    changes = append(changes, d.detectRemovedOperations()...)
    changes = append(changes, d.detectNewRequiredFields()...)
    changes = append(changes, d.detectResponseChanges()...)
    changes = append(changes, d.detectParameterChanges()...)

    return changes
}

// Paths is a struct, not a map. Map() exposes it for ranging, Find() for
// lookup. Indexing it (d.oldSpec.Paths[path]) does not compile.
func (d *BreakingChangeDetector) detectRemovedPaths() []BreakingChange {
    var changes []BreakingChange

    for path := range d.oldSpec.Paths.Map() {
        if d.newSpec.Paths.Find(path) == nil {
            changes = append(changes, BreakingChange{
                Type:        "path_removed",
                Path:        path,
                Description: fmt.Sprintf("Path '%s' was removed", path),
                Severity:    "breaking",
            })
        }
    }

    return changes
}

func (d *BreakingChangeDetector) detectRemovedOperations() []BreakingChange {
    var changes []BreakingChange

    for path, oldPathItem := range d.oldSpec.Paths.Map() {
        newPathItem := d.newSpec.Paths.Find(path)
        if newPathItem == nil {
            continue // Already caught by detectRemovedPaths
        }

        // Operations() returns every declared method, so there is no need to
        // hand-maintain a map of the five verbs and silently miss HEAD,
        // OPTIONS, or TRACE.
        newOps := newPathItem.Operations()
        for method := range oldPathItem.Operations() {
            if newOps[method] == nil {
                changes = append(changes, BreakingChange{
                    Type:        "operation_removed",
                    Path:        fmt.Sprintf("%s %s", method, path),
                    Description: fmt.Sprintf("Operation '%s %s' was removed", method, path),
                    Severity:    "breaking",
                })
            }
        }
    }

    return changes
}

func (d *BreakingChangeDetector) detectNewRequiredFields() []BreakingChange {
    var changes []BreakingChange

    for path, newPathItem := range d.newSpec.Paths.Map() {
        oldPathItem := d.oldSpec.Paths.Find(path)
        if oldPathItem == nil {
            continue // New path, not breaking
        }

        for method, newOp := range newPathItem.Operations() {
            if newOp == nil || newOp.RequestBody == nil {
                continue
            }

            oldOp := oldPathItem.Operations()[method]
            if oldOp == nil || oldOp.RequestBody == nil {
                continue
            }

            oldSchema := d.getRequestSchema(oldOp)
            newSchema := d.getRequestSchema(newOp)
            if oldSchema == nil || newSchema == nil {
                continue
            }

            for _, required := range newSchema.Required {
                if !slices.Contains(oldSchema.Required, required) {
                    changes = append(changes, BreakingChange{
                        Type:        "new_required_field",
                        Path:        fmt.Sprintf("%s %s", method, path),
                        Description: fmt.Sprintf("Field '%s' is now required", required),
                        Severity:    "breaking",
                    })
                }
            }
        }
    }

    return changes
}

func (d *BreakingChangeDetector) detectResponseChanges() []BreakingChange {
    var changes []BreakingChange

    for path, newPathItem := range d.newSpec.Paths.Map() {
        oldPathItem := d.oldSpec.Paths.Find(path)
        if oldPathItem == nil {
            continue
        }

        for method, newOp := range newPathItem.Operations() {
            oldOp := oldPathItem.Operations()[method]
            if oldOp == nil || oldOp.Responses == nil || newOp.Responses == nil {
                continue
            }

            // Responses is also a struct: Map() to range, Value() to look up.
            for status, oldResp := range oldOp.Responses.Map() {
                newResp := newOp.Responses.Value(status)
                if newResp == nil || oldResp.Value == nil || newResp.Value == nil {
                    continue
                }

                oldSchema := d.getResponseSchema(oldResp.Value)
                newSchema := d.getResponseSchema(newResp.Value)
                if oldSchema == nil || newSchema == nil {
                    continue
                }

                for field, oldProp := range oldSchema.Properties {
                    newProp, exists := newSchema.Properties[field]
                    if !exists {
                        changes = append(changes, BreakingChange{
                            Type:        "response_field_removed",
                            Path:        fmt.Sprintf("%s %s (response %s)", method, path, status),
                            Description: fmt.Sprintf("Response field '%s' was removed", field),
                            Severity:    "breaking",
                        })
                        continue
                    }

                    if typesChanged(oldProp, newProp) {
                        changes = append(changes, BreakingChange{
                            Type:        "field_type_changed",
                            Path:        fmt.Sprintf("%s %s (response %s)", method, path, status),
                            Description: fmt.Sprintf("Field '%s' type changed from %v to %v",
                                field, typeNames(oldProp), typeNames(newProp)),
                            Severity:    "breaking",
                        })
                    }
                }
            }
        }
    }

    return changes
}

// typesChanged compares schema types BY VALUE.
//
// Schema.Type is a *openapi3.Types (a *[]string in disguise, because 3.1
// allows unions like ["string","null"]). Writing `oldProp.Value.Type !=
// newProp.Value.Type` compiles and is catastrophically wrong: it compares
// pointer addresses, which differ for every separately-parsed schema, so the
// detector reports a type change on every field of every endpoint and blocks
// every PR. Compare the slices.
func typesChanged(oldProp, newProp *openapi3.SchemaRef) bool {
    if oldProp.Value == nil || newProp.Value == nil {
        return false
    }
    return !slices.Equal(typeNames(oldProp), typeNames(newProp))
}

func typeNames(ref *openapi3.SchemaRef) []string {
    if ref.Value == nil || ref.Value.Type == nil {
        return nil
    }
    names := append([]string(nil), ref.Value.Type.Slice()...)
    slices.Sort(names) // ["string","null"] and ["null","string"] are the same type
    return names
}

func (d *BreakingChangeDetector) detectParameterChanges() []BreakingChange {
    var changes []BreakingChange

    for path, newPathItem := range d.newSpec.Paths.Map() {
        oldPathItem := d.oldSpec.Paths.Find(path)
        if oldPathItem == nil {
            continue
        }

        for method, newOp := range newPathItem.Operations() {
            oldOp := oldPathItem.Operations()[method]
            if oldOp == nil {
                continue
            }

            for _, newParam := range newOp.Parameters {
                if newParam.Value == nil || !newParam.Value.Required {
                    continue
                }

                found := false
                for _, oldParam := range oldOp.Parameters {
                    if oldParam.Value == nil || oldParam.Value.Name != newParam.Value.Name {
                        continue
                    }
                    found = true
                    if !oldParam.Value.Required {
                        changes = append(changes, BreakingChange{
                            Type:        "parameter_now_required",
                            Path:        fmt.Sprintf("%s %s", method, path),
                            Description: fmt.Sprintf("Parameter '%s' is now required",
                                newParam.Value.Name),
                            Severity:    "breaking",
                        })
                    }
                    break
                }

                if !found {
                    changes = append(changes, BreakingChange{
                        Type:        "new_required_parameter",
                        Path:        fmt.Sprintf("%s %s", method, path),
                        Description: fmt.Sprintf("New required parameter '%s' added",
                            newParam.Value.Name),
                        Severity:    "breaking",
                    })
                }
            }
        }
    }

    return changes
}

// Helper methods
func (d *BreakingChangeDetector) getRequestSchema(op *openapi3.Operation) *openapi3.Schema {
    if op.RequestBody == nil || op.RequestBody.Value == nil {
        return nil
    }
    content := op.RequestBody.Value.Content.Get("application/json")
    if content == nil || content.Schema == nil {
        return nil
    }
    return content.Schema.Value
}

func (d *BreakingChangeDetector) getResponseSchema(resp *openapi3.Response) *openapi3.Schema {
    content := resp.Content.Get("application/json")
    if content == nil || content.Schema == nil {
        return nil
    }
    return content.Schema.Value
}

// CLI usage
func main() {
    loader := openapi3.NewLoader()

    // Do not discard these errors. A typo'd filename would otherwise yield a
    // nil spec, zero detected changes, and a green CI check that means
    // "nothing was compared" while looking exactly like "nothing broke".
    oldSpec, err := loader.LoadFromFile("openapi-v1.yaml")
    if err != nil {
        fmt.Fprintln(os.Stderr, "load old spec:", err)
        os.Exit(2)
    }
    newSpec, err := loader.LoadFromFile("openapi-v2.yaml")
    if err != nil {
        fmt.Fprintln(os.Stderr, "load new spec:", err)
        os.Exit(2)
    }

    changes := NewDetector(oldSpec, newSpec).DetectChanges()

    hasBreaking := false
    for _, change := range changes {
        fmt.Printf("[%s] %s: %s\n", change.Severity, change.Type, change.Description)
        if change.Severity == "breaking" {
            hasBreaking = true
        }
    }

    if hasBreaking {
        fmt.Println("\nBreaking changes detected. A major version bump is required.")
        os.Exit(1)
    }
}
```

### Exercise 2: Generate Multi-Language SDK Examples

**Problem:** Create a tool that generates code samples in multiple languages from an OpenAPI spec.

**Solution:**

Note the `.Funcs(tmplFuncs)` call before every `.Parse`. `text/template` resolves function names at *parse* time, not execute time, so a template that pipes through `goValue` or `lower` without those functions registered fails to parse. Wrapped in `template.Must`, that failure becomes a panic during `loadTemplates`, meaning the program dies at startup before generating anything. Registering the FuncMap first is not a style preference, it is what makes the templates parse at all.

`extractExample` shows the other recurring 3.1 adjustment: `Type` cannot be compared against a string literal, so a `switch prop.Value.Type { case "string": }` does not compile. Switch on `Type.Is("string")` instead, which also behaves correctly for union types.

```go
package main

// ... imports omitted for brevity (bytes, encoding/json, fmt, strings,
// text/template, github.com/getkin/kin-openapi/openapi3)

type CodeGenerator struct {
    spec      *openapi3.T
    templates map[string]*template.Template
}

func NewCodeGenerator(spec *openapi3.T) *CodeGenerator {
    gen := &CodeGenerator{
        spec:      spec,
        templates: make(map[string]*template.Template),
    }
    gen.loadTemplates()
    return gen
}

// tmplFuncs must be registered with .Funcs() BEFORE .Parse(). text/template
// resolves function names at parse time, so a template referencing an
// unregistered function fails to parse and template.Must turns that into a
// panic at startup, before a single sample is generated.
var tmplFuncs = template.FuncMap{
    "lower": strings.ToLower,
    // goValue renders a Go literal for an example value.
    "goValue": func(v any) string {
        b, err := json.Marshal(v)
        if err != nil {
            return `""`
        }
        // JSON literals for strings, numbers, bools, null happen to be valid
        // Go literals too, except null, which is nil in Go.
        if string(b) == "null" {
            return "nil"
        }
        return string(b)
    },
}

func (g *CodeGenerator) loadTemplates() {
    // Go template
    g.templates["go"] = template.Must(template.New("go").Funcs(tmplFuncs).Parse(`
package main

import (
    "bytes"
    "encoding/json"
    "fmt"
    "net/http"
)

func main() {
    {{if .HasBody}}
    body := map[string]any{
        {{range $key, $value := .BodyExample}}
        "{{$key}}": {{$value | goValue}},
        {{end}}
    }
    jsonBody, _ := json.Marshal(body)

    req, _ := http.NewRequest("{{.Method}}", "{{.BaseURL}}{{.Path}}", bytes.NewBuffer(jsonBody))
    req.Header.Set("Content-Type", "application/json")
    {{else}}
    req, _ := http.NewRequest("{{.Method}}", "{{.BaseURL}}{{.Path}}", nil)
    {{end}}
    req.Header.Set("Authorization", "Bearer YOUR_API_KEY")

    client := &http.Client{}
    resp, err := client.Do(req)
    if err != nil {
        panic(err)
    }
    defer resp.Body.Close()

    var result map[string]any
    json.NewDecoder(resp.Body).Decode(&result)
    fmt.Printf("%+v\n", result)
}
`))

    // cURL template
    g.templates["curl"] = template.Must(template.New("curl").Funcs(tmplFuncs).Parse(`
curl -X {{.Method}} "{{.BaseURL}}{{.Path}}" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  {{if .HasBody}}-d '{{.BodyJSON}}'{{end}}
`))

    // Python template
    g.templates["python"] = template.Must(template.New("python").Funcs(tmplFuncs).Parse(`
import requests

url = "{{.BaseURL}}{{.Path}}"
headers = {
    "Authorization": "Bearer YOUR_API_KEY",
    "Content-Type": "application/json"
}
{{if .HasBody}}
payload = {{.BodyPython}}
response = requests.{{.Method | lower}}(url, headers=headers, json=payload)
{{else}}
response = requests.{{.Method | lower}}(url, headers=headers)
{{end}}

print(response.json())
`))

    // JavaScript template
    g.templates["javascript"] = template.Must(template.New("javascript").Funcs(tmplFuncs).Parse(`
const response = await fetch("{{.BaseURL}}{{.Path}}", {
    method: "{{.Method}}",
    headers: {
        "Authorization": "Bearer YOUR_API_KEY",
        "Content-Type": "application/json"
    },
    {{if .HasBody}}body: JSON.stringify({{.BodyJSON}}){{end}}
});

const data = await response.json();
console.log(data);
`))
}

type OperationData struct {
    Method      string
    Path        string
    BaseURL     string
    HasBody     bool
    BodyExample map[string]any
    BodyJSON    string
    BodyPython  string
}

func (g *CodeGenerator) GenerateSamples(path, method string) map[string]string {
    samples := make(map[string]string)

    // Paths is a struct: Find(), not index.
    pathItem := g.spec.Paths.Find(path)
    if pathItem == nil {
        return samples
    }

    // Operations() covers every method rather than a hand-written switch.
    op := pathItem.Operations()[strings.ToUpper(method)]
    if op == nil {
        return samples
    }

    // A spec with no servers is legal, so do not index Servers[0] blindly.
    baseURL := ""
    if len(g.spec.Servers) > 0 {
        baseURL = g.spec.Servers[0].URL
    }

    data := OperationData{
        Method:  strings.ToUpper(method),
        Path:    path,
        BaseURL: baseURL,
    }

    // Extract request body example
    if op.RequestBody != nil && op.RequestBody.Value != nil {
        content := op.RequestBody.Value.Content.Get("application/json")
        if content != nil && content.Schema != nil && content.Schema.Value != nil {
            data.HasBody = true
            data.BodyExample = g.extractExample(content.Schema.Value)
            jsonBytes, _ := json.MarshalIndent(data.BodyExample, "", "  ")
            data.BodyJSON = string(jsonBytes)
            data.BodyPython = g.toPythonDict(data.BodyExample)
        }
    }

    for lang, tmpl := range g.templates {
        var buf bytes.Buffer
        if err := tmpl.Execute(&buf, data); err == nil {
            samples[lang] = strings.TrimSpace(buf.String())
        }
    }

    return samples
}

func (g *CodeGenerator) extractExample(schema *openapi3.Schema) map[string]any {
    result := make(map[string]any)

    for name, prop := range schema.Properties {
        if prop.Value == nil {
            continue
        }
        if prop.Value.Example != nil {
            result[name] = prop.Value.Example
            continue
        }

        // Type is a *openapi3.Types, not a string, so switch on Is() rather
        // than comparing against a string literal.
        t := prop.Value.Type
        switch {
        case t == nil:
            result[name] = nil
        case t.Is("string"):
            if prop.Value.Format == "email" {
                result[name] = "user@example.com"
            } else {
                result[name] = "string"
            }
        case t.Is("integer"), t.Is("number"):
            result[name] = 0
        case t.Is("boolean"):
            result[name] = true
        case t.Is("array"):
            result[name] = []any{}
        case t.Is("object"):
            result[name] = map[string]any{}
        }
    }

    return result
}

// toPythonDict converts the JSON rendering into Python literal syntax.
//
// Note the limitation, and do not ship this as-is: the replacements are
// textual, so a string value containing the word "true" or "null" is
// rewritten too. It is fine for generating docs from controlled examples and
// wrong for arbitrary data. A correct version walks the value recursively.
func (g *CodeGenerator) toPythonDict(data map[string]any) string {
    jsonBytes, _ := json.MarshalIndent(data, "", "    ")
    result := string(jsonBytes)
    result = strings.ReplaceAll(result, ": true", ": True")
    result = strings.ReplaceAll(result, ": false", ": False")
    result = strings.ReplaceAll(result, ": null", ": None")
    return result
}

// Usage
func main() {
    spec, err := openapi3.NewLoader().LoadFromFile("openapi.yaml")
    if err != nil {
        panic(err)
    }
    gen := NewCodeGenerator(spec)

    samples := gen.GenerateSamples("/users", "POST")

    for lang, code := range samples {
        fmt.Printf("=== %s ===\n%s\n\n", lang, code)
    }
}
```

### Junior to FAANG: Working the Exercises

Prerequisite gap. Juniors often skip the detector exercise because it looks like tooling work. It is the single most valuable exercise in the chapter. Writing a breaking-change detector teaches you exactly which diffs matter and which do not. Every senior engineer has the rules in their head because they wrote or debugged one of these tools.

Worked walkthrough for Exercise 1. Start with three cases: path removed, required field added, field type changed. Run the detector against two hand-written specs. Observe the output. Add one case per day until the rule list is complete. Then add a test suite that feeds known-breaking and known-additive diffs and asserts the correct verdict.

First-job context. Teams ship breaking changes by accident more often than by intent. If you deliver a working detector as a CI gate in your first six months, it will be one of the most-used tools you ever write. The PR comment "breaking-change-detector says this is breaking" is a gift to the reviewer, because it removes the human judgment call from the merge conversation.

"Why did this fail?" reflex on the exercise. If the detector misses a real break, ask which rule was missing. Add it. If the detector false-positives, ask whether the rule is too strict. Refine. The loop is the product.

Interview entry point. "Walk me through how you would detect breaking changes automatically." The answer uses the exercise structure. Classify diffs into path, operation, request, response, parameter. For each, enumerate the breaking signatures. Wire it into CI as a required check.

### Senior at FAANG: Staff Extensions

Staff extensions turn these exercises into platform capabilities.

Staff extension 1. Build a breaking-change detector that gates PRs. The exercise above stops at printing to stdout. Staff extension wraps it as a GitHub Action, reads the base and head specs, posts a review comment with a diff table, and blocks merge on any breaking change unless a label such as `version-bump-approved` is applied by an API review board member. Add a rule table that maps each detected type to a policy (hard block, warn, allow with ADR link). Add metrics on how often each rule fires across the org to prioritize developer education.

Staff extension 2. Implement Sunset and Deprecation middleware. Start from the middleware sketched in 41.8 and harden it. Emit structured telemetry per request with fields for customer ID, endpoint, version, days to sunset, and SDK user-agent. Store in a time-series database. Build a dashboard per customer and per endpoint. Define exit criteria as thirty consecutive days of zero traffic. Add an admin endpoint that forces a 410 response for a specific customer to simulate sunset and verify client handling.

Staff extension 3. Design a customer-migration dashboard. The dashboard is the single artifact leadership will look at during a migration. Required views: per-customer version breakdown, top ten callers on deprecated versions, days-since-last-call histogram, trend lines against the sunset deadline, and a projection of which customers will miss the deadline at current trajectory. Add drill-down to per-endpoint breakdown. Add outreach status (emailed, acknowledged, migrating, migrated). Expose the data as an API so support teams can script bulk outreach.

Staff extension 4. SDK codegen pipeline. Turn the multi-language sample generator above into a full SDK pipeline. Add semantic version alignment across languages, golden file tests per language, a publish pipeline that emits simultaneously to npm, PyPI, Maven, NuGet, crates.io, pkg.go.dev, RubyGems, and Packagist. Add a changelog generator that reads the OpenAPI diff and emits a structured entry per SDK. Add a contract test per language that instantiates the generated client and exercises every operation against a mock server.

Staff extension 5. Versioning policy as code. Write the versioning policy in a machine-readable format such as Rego or a Go policy package. Have CI evaluate every PR against the policy and output pass or fail with cited rule IDs. This is how staff engineers scale governance without becoming a bottleneck.

ADR template for a detector rollout:

1. Scope. Which repositories, which specs, which rules.
2. Rollout. Warn-only mode, then enforcement, with dates.
3. Exceptions. Labels, approval workflow, audit log.
4. Metrics. Detection count, override count, time-to-merge impact.
5. Ownership. Platform team, escalation path, on-call rotation.

Maturity model L1 to L5 for versioning tooling:

- L1. No detector. Breaking changes land silently.
- L2. Manual spec review. Humans catch some breaks.
- L3. Automated detector in CI with warn-only output.
- L4. Enforcing detector with override workflow and per-rule metrics.
- L5. Policy-as-code, cross-repo governance, dashboard integration, automated customer outreach tied to telemetry.

---
