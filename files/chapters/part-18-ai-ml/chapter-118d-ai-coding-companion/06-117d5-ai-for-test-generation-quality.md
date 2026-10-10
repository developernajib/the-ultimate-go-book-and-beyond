## 118D.5 AI for Test Generation & Quality

### Generating Unit Tests from Function Signatures

Test generation is one of AI's highest-value contributions to Go development. Writing tests is mechanical enough that AI does it well, and important enough that skipping it is costly. Table-driven tests in particular are close to an ideal fit: the structure is formulaic, the interesting part is enumerating cases, and enumerating cases is something a model with broad exposure to failure modes is genuinely good at.

It is also the area where careless review costs you the most, for a reason worth stating up front: a wrong test does not announce itself. A wrong implementation usually trips a test; a wrong test just passes, and a suite full of passing tests is exactly what stops you looking. The worked example below is a real instance from this chapter's own draft, where AI produced a beautifully structured table whose boundary cases were off by one and asserted nothing.

**Template: Unit Test Generation Prompt**

````
Generate thorough Go unit tests for this function:

```text
[paste function]
```

Requirements:
1. Use table-driven tests with descriptive subtest names
2. Cover: happy path, error cases, edge cases, boundary values
3. Use the standard testing package (or testify/assert if the project
   already depends on it)
4. Include at least one test for nil/zero-value inputs
5. Name the test function Test[FunctionName] following Go conventions
6. Add comments explaining WHY each test case exists, not just WHAT it tests
7. Use current Go idioms (any, not interface{}; t.Run subtests)

Derive the expected values from the function's documented contract,
not from what the implementation currently returns. If the contract is
ambiguous for a case, say so instead of guessing an expectation.
````

### Table-Driven Test Generation for Go

Here is a realistic example of AI-generated table-driven tests.

```go
// The function to test.
package validator

import (
	"fmt"
	"net/mail"
	"regexp"
	"strings"
	"unicode/utf8"
)

// ValidationError provides structured validation failure information.
type ValidationError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
	Code    string `json:"code"`
}

func (e *ValidationError) Error() string {
	return fmt.Sprintf("%s: %s", e.Field, e.Message)
}

// ValidateEmail checks whether an email address is valid.
// It returns nil if valid, or a ValidationError describing the problem.
func ValidateEmail(email string) error {
	if email == "" {
		return &ValidationError{
			Field:   "email",
			Message: "email is required",
			Code:    "REQUIRED",
		}
	}

	if utf8.RuneCountInString(email) > 254 {
		return &ValidationError{
			Field:   "email",
			Message: "email exceeds maximum length of 254 characters",
			Code:    "MAX_LENGTH",
		}
	}

	if _, err := mail.ParseAddress(email); err != nil {
		return &ValidationError{
			Field:   "email",
			Message: "invalid email format",
			Code:    "INVALID_FORMAT",
		}
	}

	// Check for common disposable email domains.
	domain := strings.ToLower(email[strings.LastIndex(email, "@")+1:])
	disposable := []string{"mailinator.com", "guerrillamail.com", "tempmail.com"}
	for _, d := range disposable {
		if domain == d {
			return &ValidationError{
				Field:   "email",
				Message: "disposable email addresses are not allowed",
				Code:    "DISPOSABLE",
			}
		}
	}

	return nil
}

// ValidatePassword checks password strength requirements.
func ValidatePassword(password string) error {
	if password == "" {
		return &ValidationError{
			Field:   "password",
			Message: "password is required",
			Code:    "REQUIRED",
		}
	}

	length := utf8.RuneCountInString(password)
	if length < 8 {
		return &ValidationError{
			Field:   "password",
			Message: "password must be at least 8 characters",
			Code:    "MIN_LENGTH",
		}
	}

	if length > 128 {
		return &ValidationError{
			Field:   "password",
			Message: "password must not exceed 128 characters",
			Code:    "MAX_LENGTH",
		}
	}

	checks := []struct {
		pattern string
		message string
	}{
		{`[a-z]`, "password must contain at least one lowercase letter"},
		{`[A-Z]`, "password must contain at least one uppercase letter"},
		{`[0-9]`, "password must contain at least one digit"},
		{`[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>/?]`, "password must contain at least one special character"},
	}

	for _, check := range checks {
		matched, _ := regexp.MatchString(check.pattern, password)
		if !matched {
			return &ValidationError{
				Field:   "password",
				Message: check.message,
				Code:    "WEAK_PASSWORD",
			}
		}
	}

	return nil
}
```

**AI-generated tests:**

```go
package validator

import (
	"errors"
	"strings"
	"testing"
)

func TestValidateEmail(t *testing.T) {
	tests := []struct {
		name     string
		email    string
		wantErr  bool
		wantCode string
		reason   string // Why this test case exists.
	}{
		// Happy path cases.
		{
			name:    "valid simple email",
			email:   "user@example.com",
			wantErr: false,
			reason:  "basic valid email should pass all checks",
		},
		{
			name:    "valid email with plus addressing",
			email:   "user+tag@example.com",
			wantErr: false,
			reason:  "plus addressing is valid per RFC 5321",
		},
		{
			name:    "valid email with dots in local part",
			email:   "first.last@example.com",
			wantErr: false,
			reason:  "dots in local part are valid",
		},
		{
			name:    "valid email with subdomain",
			email:   "user@mail.example.com",
			wantErr: false,
			reason:  "subdomains in the domain part are valid",
		},

		// Required field validation.
		{
			name:     "empty email",
			email:    "",
			wantErr:  true,
			wantCode: "REQUIRED",
			reason:   "empty string should trigger required validation",
		},

		// Length validation.
		//
		// "@test.com" is 9 characters, so the local part plus 9 is the total.
		// Get this arithmetic wrong and the test still passes or fails for
		// reasons unrelated to what its name claims. See the note after this
		// block: the AI's first draft was off by one in both directions.
		{
			name:     "email exceeds 254 characters",
			email:    strings.Repeat("a", 246) + "@test.com", // 246 + 9 = 255
			wantErr:  true,
			wantCode: "MAX_LENGTH",
			reason:   "255 chars must be rejected: one past the documented limit",
		},
		{
			name:    "email at exactly 254 characters",
			email:   strings.Repeat("a", 245) + "@test.com", // 245 + 9 = 254
			wantErr: false,
			reason:  "boundary: exactly at the 254-character limit is allowed",
		},

		// Format validation.
		{
			name:     "missing at sign",
			email:    "userexample.com",
			wantErr:  true,
			wantCode: "INVALID_FORMAT",
			reason:   "email without @ is structurally invalid",
		},
		{
			name:     "double at sign",
			email:    "user@@example.com",
			wantErr:  true,
			wantCode: "INVALID_FORMAT",
			reason:   "multiple @ symbols are not valid",
		},
		{
			name:     "missing domain",
			email:    "user@",
			wantErr:  true,
			wantCode: "INVALID_FORMAT",
			reason:   "email without domain part is invalid",
		},
		{
			name:     "missing local part",
			email:    "@example.com",
			wantErr:  true,
			wantCode: "INVALID_FORMAT",
			reason:   "email without local part is invalid",
		},

		// Disposable email detection.
		{
			name:     "mailinator disposable email",
			email:    "test@mailinator.com",
			wantErr:  true,
			wantCode: "DISPOSABLE",
			reason:   "known disposable domain should be rejected",
		},
		{
			name:     "guerrillamail disposable email",
			email:    "test@guerrillamail.com",
			wantErr:  true,
			wantCode: "DISPOSABLE",
			reason:   "another known disposable domain",
		},
		{
			name:     "disposable domain case insensitive",
			email:    "test@MAILINATOR.COM",
			wantErr:  true,
			wantCode: "DISPOSABLE",
			reason:   "disposable check should be case-insensitive",
		},

		// Unicode and special characters.
		{
			name:    "email with unicode local part",
			email:   "user@example.com",
			wantErr: false,
			reason:  "standard ASCII email should work",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateEmail(tt.email)

			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error but got nil - %s", tt.reason)
				}

				var valErr *ValidationError
				if !errors.As(err, &valErr) {
					t.Fatalf("expected *ValidationError, got %T", err)
				}

				if tt.wantCode != "" && valErr.Code != tt.wantCode {
					t.Errorf("expected code %q, got %q - %s",
						tt.wantCode, valErr.Code, tt.reason)
				}
			} else {
				if err != nil {
					t.Fatalf("unexpected error: %v - %s", err, tt.reason)
				}
			}
		})
	}
}

func TestValidatePassword(t *testing.T) {
	tests := []struct {
		name     string
		password string
		wantErr  bool
		wantCode string
		reason   string
	}{
		// Happy path.
		{
			name:     "strong password",
			password: "MyP@ssw0rd!",
			wantErr:  false,
			reason:   "meets all requirements: length, upper, lower, digit, special",
		},
		{
			name:     "minimum valid password",
			password: "Aa1!xxxx",
			wantErr:  false,
			reason:   "exactly 8 characters with all required character types",
		},

		// Required field.
		{
			name:     "empty password",
			password: "",
			wantErr:  true,
			wantCode: "REQUIRED",
			reason:   "empty password must be rejected",
		},

		// Length boundaries.
		{
			name:     "too short - 7 characters",
			password: "Aa1!xxx",
			wantErr:  true,
			wantCode: "MIN_LENGTH",
			reason:   "boundary: 7 characters is below minimum of 8",
		},
		{
			name:     "too long - 129 characters",
			password: strings.Repeat("Aa1!", 32) + "x",
			wantErr:  true,
			wantCode: "MAX_LENGTH",
			reason:   "boundary: exceeds maximum of 128 characters",
		},
		{
			name:     "exactly 128 characters",
			password: strings.Repeat("Aa1!", 32),
			wantErr:  false,
			reason:   "boundary: exactly at max length should pass",
		},

		// Missing character types.
		{
			name:     "no uppercase",
			password: "myp@ssw0rd!",
			wantErr:  true,
			wantCode: "WEAK_PASSWORD",
			reason:   "missing uppercase letter should fail strength check",
		},
		{
			name:     "no lowercase",
			password: "MYP@SSW0RD!",
			wantErr:  true,
			wantCode: "WEAK_PASSWORD",
			reason:   "missing lowercase letter should fail strength check",
		},
		{
			name:     "no digit",
			password: "MyP@ssword!",
			wantErr:  true,
			wantCode: "WEAK_PASSWORD",
			reason:   "missing digit should fail strength check",
		},
		{
			name:     "no special character",
			password: "MyPassw0rd1",
			wantErr:  true,
			wantCode: "WEAK_PASSWORD",
			reason:   "missing special character should fail strength check",
		},
		{
			name:     "all lowercase only",
			password: "abcdefgh",
			wantErr:  true,
			wantCode: "WEAK_PASSWORD",
			reason:   "single character type should fail multiple checks",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidatePassword(tt.password)

			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error but got nil - %s", tt.reason)
				}

				var valErr *ValidationError
				if !errors.As(err, &valErr) {
					t.Fatalf("expected *ValidationError, got %T", err)
				}

				if tt.wantCode != "" && valErr.Code != tt.wantCode {
					t.Errorf("expected code %q, got %q - %s",
						tt.wantCode, valErr.Code, tt.reason)
				}
			} else {
				if err != nil {
					t.Fatalf("unexpected error: %v - %s", err, tt.reason)
				}
			}
		})
	}
}
```

> **The boundary cases in that table were wrong when AI first wrote them, and this is the most important paragraph in the section.**
>
> The original draft used `strings.Repeat("a", 245) + "@test.com"` for the case named "email exceeds 254 characters". Do the arithmetic: 245 + 9 = 254. The validator rejects `> 254`, so 254 does not exceed the limit, no error is returned, and the test fails. Its sibling, named "email at exactly 254 characters", used 244 + 9 = 253, so it passed while testing nothing it claimed to test.
>
> Look at what the AI got *right*, because that is what makes this dangerous. It knew boundary values needed testing. It knew the RFC 5321 limit was 254. It cited the RFC in the `reason` field. It structured the table correctly and named the cases well. Every signal a reviewer skims for says "this author knew what they were doing". The only thing wrong was arithmetic that nobody does while reading, because the string is `Repeat("a", 245)` and the constant in your head is 254 and those two numbers are close enough to feel consistent.
>
> Now notice the asymmetry that makes AI-generated tests more dangerous than AI-generated code. A wrong implementation usually fails a test. A wrong test just... passes. The "exactly 254" case would have sat in the suite forever, green, testing 253, while the actual boundary went unexercised. The failing case at least announced itself. **The bugs that survive are the ones in the direction of passing**, and a test suite's job is to fail, so a test that cannot fail is worse than no test at all: it occupies the space where a real test would have gone and reports safety.
>
> Two habits follow. First, **verify every generated assertion against the contract, not the implementation.** If you generate tests from the code, you encode current behavior, bugs included, and the suite becomes a bug-preservation device. Ask for expectations derived from the documented contract, then check them yourself. Second, **make each new test fail before you trust it.** Break the implementation deliberately, or write the test before the fix. A test you have never seen fail is a hypothesis, not a check. This is old TDD wisdom, and AI-generated tests make it load-bearing rather than optional, because now nobody watched the test fail even once.

### Fuzz Target Generation

AI is excellent at generating fuzz targets because the structure is formulaic but the input domain requires creativity.

**Template: Fuzz Test Generation Prompt**

````
Generate a Go fuzz test for this function:

```text
[paste function]
```

Requirements:
1. Use Go's native fuzzing (testing.F)
2. Add seed corpus entries that cover key edge cases
3. The fuzz function should verify that the function doesn't panic
4. If the function returns an error, verify the error is meaningful
5. If the function has invariants (e.g., output length == input length),
   verify them in the fuzz function
````


```go
package validator

import (
	"testing"
	"unicode/utf8"
)

func FuzzValidateEmail(f *testing.F) {
	// Seed corpus: known edge cases that have caused bugs in email validators.
	seeds := []string{
		"",
		"user@example.com",
		"a@b.c",
		"@",
		"user@",
		"@domain.com",
		"user@@domain.com",
		"user@domain..com",
		"user@mailinator.com",
		"a" + "@test.com",
		"user@example.com\x00injected",
		"user@example.com\r\ninjected: header",
		"<script>alert(1)</script>@example.com",
		"' OR 1=1 --@example.com",
	}

	for _, seed := range seeds {
		f.Add(seed)
	}

	f.Fuzz(func(t *testing.T, email string) {
		// The function should never panic regardless of input.
		err := ValidateEmail(email)

		// If it returns nil, the email should be non-empty and valid-looking.
		if err == nil {
			if email == "" {
				t.Error("ValidateEmail returned nil for empty email")
			}
			if !utf8.ValidString(email) {
				t.Error("ValidateEmail accepted invalid UTF-8")
			}
		}
	})
}

func FuzzValidatePassword(f *testing.F) {
	seeds := []string{
		"",
		"short",
		"MyP@ssw0rd!",
		"aaaaaaaaaa",
		"AAAAAAAAAA",
		"1234567890",
		"!@#$%^&*()",
		"\x00\x00\x00\x00\x00\x00\x00\x00",
	}

	for _, seed := range seeds {
		f.Add(seed)
	}

	f.Fuzz(func(t *testing.T, password string) {
		// Should never panic.
		_ = ValidatePassword(password)
	})
}
```

### Go Code: AI Test Generator That Reads Go Source

The test generator parses Go source files with `go/ast`, extracts exported function signatures (including receiver, parameters, return types, and doc comments), then sends them to an LLM with test generation instructions. The unique component is the signature extraction.

```go
package testgen

import (
	"bytes"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
)

// FuncSignature captures the information needed to generate tests.
type FuncSignature struct {
	Name       string  `json:"name"`
	Receiver   string  `json:"receiver,omitempty"`
	Params     []Param `json:"params"`
	Returns    []Param `json:"returns"`
	SourceCode string  `json:"source_code"`
	Comments   string  `json:"comments,omitempty"`
}

// Param represents a function parameter or return value.
type Param struct {
	Name string `json:"name,omitempty"`
	Type string `json:"type"`
}

// ExtractSignatures parses a Go source file and returns signatures
// for all exported functions.
func ExtractSignatures(filename string) (string, []FuncSignature, error) {
	fset := token.NewFileSet()
	node, err := parser.ParseFile(fset, filename, nil, parser.ParseComments)
	if err != nil {
		return "", nil, fmt.Errorf("parse: %w", err)
	}

	var funcs []FuncSignature
	for _, decl := range node.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || !fn.Name.IsExported() {
			continue
		}

		sig := FuncSignature{Name: fn.Name.Name}

		if fn.Recv != nil && len(fn.Recv.List) > 0 {
			sig.Receiver = printNode(fset, fn.Recv.List[0].Type)
		}

		sig.Params = extractFields(fset, fn.Type.Params)
		sig.Returns = extractFields(fset, fn.Type.Results)
		sig.SourceCode = printNode(fset, fn)

		if fn.Doc != nil {
			sig.Comments = fn.Doc.Text()
		}

		funcs = append(funcs, sig)
	}

	return node.Name.Name, funcs, nil
}

func extractFields(fset *token.FileSet, fields *ast.FieldList) []Param {
	if fields == nil {
		return nil
	}
	var params []Param
	for _, field := range fields.List {
		typeStr := printNode(fset, field.Type)
		if len(field.Names) == 0 {
			params = append(params, Param{Type: typeStr})
		} else {
			for _, name := range field.Names {
				params = append(params, Param{Name: name.Name, Type: typeStr})
			}
		}
	}
	return params
}

func printNode(fset *token.FileSet, node ast.Node) string {
	var buf bytes.Buffer
	printer.Fprint(&buf, fset, node)
	return buf.String()
}

// BuildTestPrompt creates the LLM prompt for test generation.
func BuildTestPrompt(pkgName string, funcs []FuncSignature) string {
	funcsJSON, _ := json.MarshalIndent(funcs, "", "  ")
	return fmt.Sprintf(`Generate thorough Go tests for package %s.

Functions: %s

Requirements:
1. Table-driven tests with descriptive subtest names
2. Cover: happy path, errors, edge cases, boundary values
3. Standard testing package, Go 1.27 idioms (any, for range N)
4. Comments explaining WHY each test case exists
5. Output ONLY valid Go code
6. Verify error types with errors.As for custom error types`, pkgName, string(funcsJSON))
}
```

The workflow: call `ExtractSignatures` on the source file, build the prompt with `BuildTestPrompt`, send through `LLMClient.Complete`, strip any markdown fences from the response, and write the result to `<file>_test.go`.

> **What AI Gets Wrong**: AI-generated tests often test the implementation rather than the behavior. They'll test that a specific error message string is returned rather than testing that an error of the right type is returned. Always review generated tests to ensure they test the contract, not the implementation. Tests that break when you refactor the implementation (but not the behavior) are brittle and counterproductive.
>
> The sharper version of this problem: if you paste the implementation and ask for tests, the model infers the expected values *from the code*. Any bug in the code becomes an assertion. The suite then passes, forever, and actively defends the bug against anyone who tries to fix it, because fixing it turns the build red. Generating tests from an implementation does not verify the implementation, it photographs it.

> **Pro Tip**: After AI generates tests, ask it: "What edge cases did you miss? What inputs could cause a panic that you didn't test for?" AI is remarkably good at critiquing its own test coverage when explicitly asked.

### Junior → FAANG: Test Generation as Testing Discipline Accelerator

AI test generation is the most effective accelerator for developing testing discipline because it removes the activation energy barrier. Writing tests is tedious, especially for functions with many input combinations. AI generates the table-driven test structure, populates multiple test cases including edge cases, and writes the assertion logic, leaving only the review step for the engineer. This review step is the critical learning opportunity: understanding whether the generated test cases cover the right scenarios, what edge cases are missing, and whether the assertions test behavior or implementation.

The "self-critique for edge cases" prompt ("what edge cases did you miss?") is a meta-level skill that develops through practice. AI's initial test generation covers the obvious happy path and a few error cases. The self-critique often identifies: what happens when the input is nil? What happens when the input is empty? What happens when the input exceeds the maximum expected size? What happens when the input contains special characters? Applying the self-critique prompt consistently builds the edge case thinking that distinguishes comprehensive test suites from superficial ones.

For FAANG coding interviews specifically, AI test generation practice has a direct benefit: it trains the habit of writing test cases before implementation. In a FAANG interview, writing test cases on the whiteboard before writing the solution demonstrates that you think about correctness and edge cases systematically, which is a positive signal regardless of whether the tests are formally executable.

### Senior @ FAANG: Test Generation as Team Quality Investment

At senior level, AI test generation is a team quality investment with measurable returns. The time saved on test writing can be redirected to: writing better assertions that test behavior rather than implementation, adding property-based tests for complex input spaces, implementing integration tests that verify cross-component behavior, and maintaining test quality as the codebase evolves. The net effect on test quality depends on whether the review step is applied systematically: teams that review AI-generated tests and add the missing edge cases see quality improvement. Teams that accept AI-generated tests without review see superficial coverage improvement without meaningful quality improvement.

The "behavior, not implementation" test quality criterion from the "What AI Gets Wrong" note is the architectural test quality standard that senior engineers enforce in code review. A test that asserts a specific error message string is brittle (the message can change without breaking the behavior). A test that asserts that the error is of a specific type (using errors.Is) is robust (it tests the contract). Building this distinction into the team's test review standards, and into the AI prompt templates for test generation ("write tests that check error types using errors.Is, not error message strings"), raises the team's test quality systematically.

---
