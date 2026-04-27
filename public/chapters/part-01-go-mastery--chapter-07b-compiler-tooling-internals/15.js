export default `## 7B.13 Writing a Complete Linter: structtag

This section builds a complete, production-quality linter that validates struct field tags. Struct tags in Go are notoriously fragile. They are raw strings with no compile-time validation, so typos, duplicate keys, and convention violations go unnoticed until runtime. This linter catches those problems statically by parsing each struct's tags and checking JSON naming conventions, database column casing, validator rule correctness, and duplicate keys. It uses the \`analysis\` framework, so it integrates with existing tooling like \`go vet\`.

\`\`\`go
// cmd/structtag-lint/main.go
package main

import (
	"go/ast"
	"reflect"
	"strings"

	"golang.org/x/tools/go/analysis"
	"golang.org/x/tools/go/analysis/passes/inspect"
	"golang.org/x/tools/go/analysis/singlechecker"
	"golang.org/x/tools/go/ast/inspector"
)

var Analyzer = &analysis.Analyzer{
	Name:     "structtag",
	Doc:      "validates struct field tags for correctness and consistency",
	Run:      run,
	Requires: []*analysis.Analyzer{inspect.Analyzer},
}

func main() {
	singlechecker.Main(Analyzer)
}

func run(pass *analysis.Pass) (any, error) {
	insp := pass.ResultOf[inspect.Analyzer].(*inspector.Inspector)

	nodeFilter := []ast.Node{(*ast.StructType)(nil)}
	insp.Preorder(nodeFilter, func(n ast.Node) {
		st := n.(*ast.StructType)
		checkStructFields(pass, st)
	})
	return nil, nil
}

func checkStructFields(pass *analysis.Pass, st *ast.StructType) {
	if st.Fields == nil {
		return
	}

	for _, field := range st.Fields.List {
		if field.Tag == nil {
			continue
		}

		tagStr := strings.Trim(field.Tag.Value, "\`")
		tag := reflect.StructTag(tagStr)

		// Check JSON tags
		if jsonTag, ok := tag.Lookup("json"); ok {
			checkJSONTag(pass, field, jsonTag)
		}

		// Check db tags
		if dbTag, ok := tag.Lookup("db"); ok {
			checkDBTag(pass, field, dbTag)
		}

		// Check validate tags (go-playground/validator)
		if validateTag, ok := tag.Lookup("validate"); ok {
			checkValidateTag(pass, field, validateTag)
		}

		// Check for duplicate tags
		checkDuplicateTags(pass, field, tagStr)
	}
}

func checkJSONTag(pass *analysis.Pass, field *ast.Field, tag string) {
	parts := strings.Split(tag, ",")
	name := parts[0]

	if name == "-" {
		return // explicitly excluded
	}

	// Check for empty name (uses field name, often unintentional)
	if name == "" && len(field.Names) > 0 {
		pass.Reportf(field.Pos(),
			"json tag has empty name for field %s, consider adding explicit name",
			field.Names[0].Name)
	}

	// Check for uppercase start (violates Go JSON convention)
	if len(name) > 0 && name[0] >= 'A' && name[0] <= 'Z' {
		pass.Reportf(field.Pos(),
			"json tag name %q starts with uppercase, prefer camelCase",
			name)
	}

	// Validate options
	for _, opt := range parts[1:] {
		switch opt {
		case "omitempty", "string", "":
			// valid
		default:
			pass.Reportf(field.Pos(),
				"unknown json tag option %q", opt)
		}
	}
}

func checkDBTag(pass *analysis.Pass, field *ast.Field, tag string) {
	parts := strings.Split(tag, ",")
	name := parts[0]

	if name == "-" {
		return
	}

	// DB column names should be snake_case
	if name != strings.ToLower(name) {
		pass.Reportf(field.Pos(),
			"db tag %q should be lowercase snake_case",
			name)
	}
}

func checkValidateTag(pass *analysis.Pass, field *ast.Field, tag string) {
	// Check for common mistakes
	rules := strings.Split(tag, ",")
	for _, rule := range rules {
		if rule == "required" && isPointerType(field) {
			pass.Reportf(field.Pos(),
				"'required' validation on pointer type may not work as expected; consider 'required' on non-pointer or use 'omitempty' carefully")
		}
	}
}

func checkDuplicateTags(pass *analysis.Pass, field *ast.Field, tagStr string) {
	seen := make(map[string]bool)
	tag := reflect.StructTag(tagStr)

	// reflect.StructTag doesn't expose all keys; parse manually
	s := tagStr
	for s != "" {
		i := 0
		for i < len(s) && s[i] == ' ' {
			i++
		}
		s = s[i:]
		if s == "" {
			break
		}
		i = 0
		for i < len(s) && s[i] != ':' && s[i] != ' ' {
			i++
		}
		if i+1 >= len(s) || s[i] != ':' || s[i+1] != '"' {
			break
		}
		key := s[:i]
		if seen[key] {
			pass.Reportf(field.Pos(), "duplicate struct tag key %q", key)
		}
		seen[key] = true
		s = s[i+1:]
		// Skip the value
		_, rest, _ := strings.Cut(s[1:], "\\"")
		s = rest
		_ = tag // used for lookup
	}
}

func isPointerType(field *ast.Field) bool {
	_, ok := field.Type.(*ast.StarExpr)
	return ok
}
\`\`\`

### Taking the Linter to Production

For a senior engineer releasing a team-authored linter:

1. **Test the linter on a large, representative codebase.** False positives are the enemy. Adjust the rules until the false-positive rate is near zero.
2. **Wire into \`golangci-lint\`.** Most teams run a meta-linter. Add yours as a configured analyzer rather than a standalone tool.
3. **Document the rule and the fix.** Every diagnostic should have a canonical example of the right way.
4. **Measure adoption.** Track diagnostics per week over time. A rule with zero fires either prevents bugs silently (good) or is dead weight (remove).

---
`;
