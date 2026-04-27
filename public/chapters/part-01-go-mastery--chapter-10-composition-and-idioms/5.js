export default `## 10.4 Constructor Patterns

Go has no built-in constructors, but the language convention is clear: provide a \`New\` function that returns a properly initialized value. The patterns below range from simple factories to the full builder pattern, each suited to a different level of construction complexity.

### Simple Factory Function

A factory function encapsulates struct initialization, validating inputs and setting defaults in one place. This ensures the type is always constructed in a valid state.

\`\`\`go
func NewUser(name, email string) *User {
    return &User{
        ID:        uuid.New().String(),
        Name:      name,
        Email:     email,
        CreatedAt: time.Now(),
        UpdatedAt: time.Now(),
    }
}
\`\`\`

### Factory with Validation

Adding validation to the factory function prevents construction of invalid objects. Returning an error from the constructor is the idiomatic Go approach when initialization can fail.

\`\`\`go
var (
    ErrNameRequired  = errors.New("name is required")
    ErrInvalidEmail  = errors.New("invalid email format")
)

var emailRegex = regexp.MustCompile(\`^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}\$\`)

func NewUser(name, email string) (*User, error) {
    name = strings.TrimSpace(name)
    if name == "" {
        return nil, ErrNameRequired
    }

    email = strings.TrimSpace(strings.ToLower(email))
    if !emailRegex.MatchString(email) {
        return nil, ErrInvalidEmail
    }

    return &User{
        ID:        uuid.New().String(),
        Name:      name,
        Email:     email,
        CreatedAt: time.Now(),
        UpdatedAt: time.Now(),
    }, nil
}
\`\`\`

### Must Pattern

Some values are known at compile time, regular expressions, file paths, environment lookups, and failure to initialize them means the program cannot function. The \`Must\` pattern wraps a fallible call and panics on error, which is acceptable for package-level variables that are set once during startup:

\`\`\`go
// MustCompile panics if compilation fails
func MustCompile(pattern string) *regexp.Regexp {
    re, err := regexp.Compile(pattern)
    if err != nil {
        panic(fmt.Sprintf("regexp: Compile(%q): %v", pattern, err))
    }
    return re
}

// Generic must helper
func must[T any](v T, err error) T {
    if err != nil {
        panic(err)
    }
    return v
}

// Package-level initialization
var (
    emailRegex = regexp.MustCompile(\`^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}\$\`)
    homeDir    = must(os.UserHomeDir())
    configPath = must(filepath.Abs("config.yaml"))
)
\`\`\`

### Builder Pattern

When an object requires multi-step construction with validation at each stage, the builder pattern provides a fluent API. Each method returns the builder itself, enabling method chaining. Errors are deferred until the final \`Build()\` call, so the caller gets a single error check instead of one per step. This example builds parameterized SQL queries safely:

\`\`\`go
type Query struct {
    table      string
    columns    []string
    conditions []condition
    orderBy    []orderClause
    limit      int
    offset     int
}

type condition struct {
    column string
    op     string
    value  any
}

type orderClause struct {
    column string
    desc   bool
}

type QueryBuilder struct {
    query Query
    err   error
}

func Select(columns ...string) *QueryBuilder {
    if len(columns) == 0 {
        columns = []string{"*"}
    }
    return &QueryBuilder{
        query: Query{columns: columns},
    }
}

func (b *QueryBuilder) From(table string) *QueryBuilder {
    if b.err != nil {
        return b
    }
    if table == "" {
        b.err = errors.New("table name required")
        return b
    }
    b.query.table = table
    return b
}

func (b *QueryBuilder) Where(column, op string, value any) *QueryBuilder {
    if b.err != nil {
        return b
    }
    b.query.conditions = append(b.query.conditions, condition{column, op, value})
    return b
}

func (b *QueryBuilder) OrderBy(column string, desc bool) *QueryBuilder {
    if b.err != nil {
        return b
    }
    b.query.orderBy = append(b.query.orderBy, orderClause{column, desc})
    return b
}

func (b *QueryBuilder) Limit(n int) *QueryBuilder {
    if b.err != nil {
        return b
    }
    if n < 0 {
        b.err = errors.New("limit cannot be negative")
        return b
    }
    b.query.limit = n
    return b
}

func (b *QueryBuilder) Offset(n int) *QueryBuilder {
    if b.err != nil {
        return b
    }
    if n < 0 {
        b.err = errors.New("offset cannot be negative")
        return b
    }
    b.query.offset = n
    return b
}

func (b *QueryBuilder) Build() (string, []any, error) {
    if b.err != nil {
        return "", nil, b.err
    }
    if b.query.table == "" {
        return "", nil, errors.New("table not specified")
    }

    var args []any
    var sql strings.Builder

    // SELECT
    sql.WriteString("SELECT ")
    sql.WriteString(strings.Join(b.query.columns, ", "))

    // FROM
    sql.WriteString(" FROM ")
    sql.WriteString(b.query.table)

    // WHERE
    if len(b.query.conditions) > 0 {
        sql.WriteString(" WHERE ")
        for i, c := range b.query.conditions {
            if i > 0 {
                sql.WriteString(" AND ")
            }
            sql.WriteString(c.column)
            sql.WriteString(" ")
            sql.WriteString(c.op)
            sql.WriteString(" \$")
            sql.WriteString(strconv.Itoa(len(args) + 1))
            args = append(args, c.value)
        }
    }

    // ORDER BY
    if len(b.query.orderBy) > 0 {
        sql.WriteString(" ORDER BY ")
        for i, o := range b.query.orderBy {
            if i > 0 {
                sql.WriteString(", ")
            }
            sql.WriteString(o.column)
            if o.desc {
                sql.WriteString(" DESC")
            }
        }
    }

    // LIMIT
    if b.query.limit > 0 {
        sql.WriteString(" LIMIT ")
        sql.WriteString(strconv.Itoa(b.query.limit))
    }

    // OFFSET
    if b.query.offset > 0 {
        sql.WriteString(" OFFSET ")
        sql.WriteString(strconv.Itoa(b.query.offset))
    }

    return sql.String(), args, nil
}

// Usage
query, args, err := Select("id", "name", "email").
    From("users").
    Where("active", "=", true).
    Where("age", ">=", 18).
    OrderBy("created_at", true).
    Limit(10).
    Offset(20).
    Build()

// SELECT id, name, email FROM users WHERE active = \$1 AND age >= \$2 ORDER BY created_at DESC LIMIT 10 OFFSET 20
// args: [true, 18]
\`\`\`

### Constructor Discipline

For a senior engineer reviewing constructors:

1. **\`New\` returning pointer is the default for non-trivial types.** Value returns fit small value types.
2. **Errors return the zero value plus error, not a partially-built object.** Callers should not need to inspect a partially-constructed type.
3. **Defaults are set before applying options or arguments.** Guarantees a valid object even with zero options.

### The Zero-Value-Useful Constructor

The most Go-idiomatic construction pattern is no constructor at all. If a type works correctly at its zero value (\`bytes.Buffer\`, \`strings.Builder\`, \`sync.Mutex\`, \`sync.WaitGroup\`), the caller does not need \`New\`. Exporting \`New\` for a type that works at zero value is a smell: either the type actually needs initialization (and the zero value is a trap) or the constructor is a habit from other languages.

\`\`\`go
var buf bytes.Buffer // works. No New needed.
buf.WriteString("hello")
\`\`\`

When designing a new type, first ask: does the zero value make sense? If yes, do not write \`New\`. If no, write \`New\` and make the unexported struct fields private so callers cannot construct the type incorrectly. This is one of the most understated Go design patterns, and it is the reason stdlib types are so pleasant to use.

### When to Reject the Builder Pattern

The builder pattern shown above is correct for query construction, where accumulation over many method calls is intrinsic to the domain. It is the wrong pattern for most Go constructors, where functional options are idiomatic and the "fluent API" is Java tourism. Reach for a builder only when:

- Each step adds to a mutable collection (query conditions, SQL clauses, build steps in a pipeline).
- The final \`Build()\` performs non-trivial synthesis (SQL generation, configuration merging, graph traversal).
- The construction order genuinely matters (and cannot be expressed as a functional option set).

For plain struct construction with many optional fields, the builder is over-engineered. Use functional options. In code review, flag any builder where the final \`Build()\` just returns a struct. That is a functional-options call dressed up in Java drag.

### Staff Lens: Constructor Taxonomy for the Team

The team's constructor style guide should enumerate four patterns and state the default:

1. **Zero-value.** No constructor. Preferred when the zero value is useful.
2. **Simple factory.** \`func New(required1, required2) *T\`. For types with required arguments but no optional configuration.
3. **Factory with options.** \`func New(required, opts ...Option) (*T, error)\`. The default for types that grow configuration over time.
4. **Builder.** For multi-step accumulation only.

Rejecting the wrong pattern in review is cheaper than debugging a badly-shaped API later. The team that codifies this in one page of documentation reviews new constructor PRs in two minutes. The team that does not revisits the "what pattern should we use" conversation every quarter.

### Principal Lens: Constructor Migration Cost

Changing a constructor's signature is a breaking change. \`NewServer(addr string)\` to \`NewServer(addr string, opts ...Option)\` adds a variadic and is source-compatible. \`NewServer(addr string)\` to \`NewServer(ctx context.Context, addr string)\` is not. Principal engineers think about signature evolution before the first \`New\` is exported. The conservative default: always accept \`ctx context.Context\` as the first argument when there is any chance the constructor will do I/O in the future. Retrofitting a context is a coordinated migration across every caller. Adding it on day one costs nothing. This is the kind of decision that feels like overengineering when it is made and feels like foresight when the alternative would have cost six weeks of caller migration.

---
`;
