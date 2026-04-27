export default `## 2.9 Comments and \`godoc\` Conventions

Go treats documentation as a first-class part of the language. The \`go doc\` and \`pkg.go.dev\` tools render comments directly from source, so the comments you write *are* the documentation. There is no separate doc DSL like Javadoc or Doxygen.

### Comment Syntax

Two forms, identical to C:

\`\`\`go
// Line comment.

/*
Block comment.
Used for package-level docs, otherwise rare in modern Go.
*/
\`\`\`

Most Go code uses \`//\` everywhere. Block comments are mainly used for long package documentation in a \`doc.go\` file.

### The Three Rules That Matter

1. **A doc comment is the comment immediately above a declaration, with no blank line between them.**
2. **The comment starts with the name of the thing being documented.**
3. **The first sentence should be a complete sentence ending with a period.** This sentence appears in package summaries.

\`\`\`go
// User represents an authenticated end user of the system.
// Use NewUser to construct a User, the zero value is not safe.
type User struct {
    ID   string
    Name string
}

// NewUser returns a User with the given ID and a freshly generated name.
// It returns an error if id is empty.
func NewUser(id string) (*User, error) { ... }
\`\`\`

A blank line between the comment and the declaration breaks the link, the comment is then ignored by \`go doc\`.

\`\`\`go
// This is no longer a doc comment.

func Broken() {}
\`\`\`

### Package Comments

Every package should have a package comment on **exactly one** file. Convention is to put it in \`doc.go\` if it is long, or above \`package foo\` in \`foo.go\` if it is short.

\`\`\`go
// Package cache provides a simple in-process key-value store
// with TTL-based expiration and bounded memory use.
//
// Typical usage:
//
//   c := cache.New(cache.WithMaxSize(1024))
//   c.Set("key", "value", time.Minute)
//   v, ok := c.Get("key")
//
// Cache values must be safe for concurrent use by the caller.
package cache
\`\`\`

Package comments support:

- Indented blocks (4 spaces or a tab) render as code blocks.
- Blank lines separate paragraphs.
- A line that is a single capitalized word followed by a colon starts a section header (e.g., \`Example:\`, \`Note:\`).
- Since Go 1.19, links written as \`[Name]\` resolve to the named symbol, and \`[text]: https://example.com\` defines URL references.

### What to Document

- **Every exported identifier** (capitalized name) should have a doc comment. \`golint\` and \`revive\` will flag missing ones.
- Document the **behavior**, not the implementation. A reader of \`pkg.go.dev\` cannot see your function body.
- Document **error conditions**. "Returns an error if the input is empty" is more useful than "Returns an error".
- Document **concurrency**. "Safe for concurrent use" or "The caller must hold the lock" matters more than parameter names.
- Document **lifecycle**. Does this type require an explicit \`Close()\`? Is the zero value ready to use? Most Go bugs come from misunderstanding lifecycle.

### What Not to Document

- Do not restate what the code obviously says. \`// AddOne adds one to x\` is noise.
- Do not narrate the implementation. \`// Use a hash map for O(1) lookup\` belongs in a commit message, not a doc comment.
- Do not add \`// Author:\`, \`// Date:\`, \`// Modified:\` tags. Git tracks all of that.

### Special Comment Directives

Go reserves a few comment forms with special meaning. They have **no space** after the \`//\`.

\`\`\`go
//go:embed assets/*           // embed files at compile time (Go 1.16+)
//go:generate stringer -type=Color   // run a tool with \`go generate\`
//go:build linux && amd64     // build constraint (Go 1.17+)
//go:noinline                 // compiler hint, rarely used
\`\`\`

A \`// Deprecated:\` paragraph in a doc comment is also recognized by tools (gopls, staticcheck) and rendered with a strikethrough on \`pkg.go.dev\`.

\`\`\`go
// Deprecated: use NewWithContext instead.
func New() *Client { ... }
\`\`\`

The \`Deprecated:\` line must be a paragraph on its own. Both \`gopls\` and \`staticcheck\` will surface a warning at every call site.

### Examples Are Tests

A function named \`ExampleFoo\` in a \`_test.go\` file is rendered as runnable example code on \`pkg.go.dev\` and is also executed by \`go test\`. The output is checked against the \`// Output:\` comment.

\`\`\`go
func ExampleNewUser() {
    u, _ := NewUser("u-1")
    fmt.Println(u.ID)
    // Output: u-1
}
\`\`\`

This is one of Go's most underused features. An \`Example\` function gives readers copy-pasteable code that the CI verifies still compiles.

### Reading Docs Locally

\`\`\`bash
go doc fmt.Printf            # one symbol
go doc -all net/http         # whole package
go doc -src strings.Builder  # show source
godoc -http=:6060            # local web server (separate install)
\`\`\`

\`gopls\` (the language server most editors use) renders these comments in hover popups, so the docs you write are read every time someone hovers a symbol.

### Code-Review Lens (Senior Track)

- An exported symbol without a doc comment is a public-API debt, future readers cannot tell whether the absence is intentional.
- A doc comment that does not start with the symbol name will not render correctly. Flag it.
- A \`// Deprecated:\` line should always come with the replacement and a target removal version, otherwise it is just a permanent warning.
- Long doc comments are fine. The community standard library has paragraphs of prose on tricky types like \`sync.Pool\` and \`context.Context\`. Do not compress documentation to fit a line-length convention.
- Examples that the CI runs are a stronger contract than prose. If a behavior is subtle, write it as an \`ExampleFoo\` function rather than as a sentence.

### Migration Lens

- **From Java:** No \`@param\`, \`@return\`, \`@throws\`. The body of the doc comment is plain English referring to the parameters by name.
- **From Python:** No \`:param x:\` or \`:returns:\` syntax. No docstring inside the function, doc comments are above the declaration.
- **From Rust:** No triple-slash \`///\`, no inner-doc \`//!\`. No Markdown rendering until Go 1.19, and even then only a tiny subset (links, code blocks, headers).
- **From TypeScript:** No JSDoc tags. Type information is in the signature, not the doc.
`;
