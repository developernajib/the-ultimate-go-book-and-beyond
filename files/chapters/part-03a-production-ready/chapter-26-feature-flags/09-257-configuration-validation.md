## 26.7 Configuration Validation

### Struct Validation

Validating configuration at startup rather than at the first use of each field catches misconfiguration before any requests are served. Collecting all validation errors into a slice and returning them together gives operators a complete picture of what needs to be fixed rather than forcing them to fix one error, restart, and discover the next.

```go
package config

import (
    "fmt"
    "net/url"
    "strings"
    "time"
)

type ValidationError struct {
    Field   string
    Message string
}

func (e ValidationError) Error() string {
    return fmt.Sprintf("%s: %s", e.Field, e.Message)
}

type ValidationErrors []ValidationError

func (e ValidationErrors) Error() string {
    var msgs []string
    for _, err := range e {
        msgs = append(msgs, err.Error())
    }
    return strings.Join(msgs, "; ")
}

func (c *Config) Validate() error {
    var errs ValidationErrors

    if c.Port < 1 || c.Port > 65535 {
        errs = append(errs, ValidationError{"port", "must be between 1 and 65535"})
    }

    if c.DatabaseURL == "" {
        errs = append(errs, ValidationError{"database_url", "is required"})
    } else if err := validateDBURL(c.DatabaseURL); err != nil {
        errs = append(errs, ValidationError{"database_url", err.Error()})
    }

    if c.Environment != "" {
        valid := []string{"development", "staging", "production"}
        found := false
        for _, v := range valid {
            if c.Environment == v {
                found = true
                break
            }
        }
        if !found {
            errs = append(errs, ValidationError{"environment", "must be one of: development, staging, production"})
        }
    }

    if c.ShutdownTimeout < 5*time.Second {
        errs = append(errs, ValidationError{"shutdown_timeout", "must be at least 5 seconds"})
    }

    if len(errs) > 0 {
        return errs
    }

    return nil
}

// validateDBURL does what url.Parse alone does not: check that the parse
// produced something usable. url.Parse accepts almost any string as a valid
// relative reference, so the error return is nearly useless as a validator.
func validateDBURL(raw string) error {
    u, err := url.Parse(raw)
    if err != nil {
        return fmt.Errorf("must be a valid URL: %w", err)
    }
    if u.Scheme == "" {
        return fmt.Errorf("must include a scheme, for example postgres://")
    }
    switch u.Scheme {
    case "postgres", "postgresql":
    default:
        return fmt.Errorf("unsupported scheme %q, want postgres://", u.Scheme)
    }
    if u.Host == "" {
        return fmt.Errorf("must include a host")
    }
    return nil
}
```

> **`url.Parse` is not a URL validator, and treating it as one is a widespread bug.** It parses *URL references*, and a bare string with no scheme and no host is a perfectly legal relative reference. So `url.Parse("hunter2")` returns a nil error, and so does `url.Parse("not a url at all")`. Only genuinely malformed input such as `://broken` or a bad percent-escape like `%%%` fails. The original check therefore accepted essentially every non-empty string, which means a `DATABASE_URL` typo'd down to a single word sailed through the validator and blew up later at connection time, in a stack trace far from the actual mistake. That is exactly the outcome the fail-fast section promises to prevent.
>
> A validator has to assert the properties you actually depend on. Here that means a non-empty scheme, a scheme you support, and a non-empty host. Whitelisting the scheme is worth the extra line: it converts a `mysql://` URL pasted into a Postgres service from a confusing runtime driver error into a startup message naming the field.

Note `Port` is checked with `c.Port < 1 || c.Port > 65535` rather than a bare non-zero test. Port 0 is meaningful to the kernel (it means "pick any free port"), so it is a legal value that is almost never the intended one in a service config, and it deserves to be rejected explicitly rather than by accident.

### Using Validator Library

The `go-playground/validator` library removes the boilerplate of manual field-by-field checks by driving validation from struct tags. Tag-based rules like `validate:"required,min=1,max=65535"` and `validate:"oneof=development staging production"` are concise, self-documenting, and automatically generate useful error messages that include the field name and the violated constraint.

```go
package config

import (
    "time"

    "github.com/go-playground/validator/v10"
)

type Config struct {
    Port         int           `validate:"required,min=1,max=65535"`
    DatabaseURL  string        `validate:"required,url"`
    RedisURL     string        `validate:"omitempty,url"`
    LogLevel     string        `validate:"required,oneof=debug info warn error"`
    Environment  string        `validate:"required,oneof=development staging production"`
    MaxConns     int           `validate:"min=1,max=100"`
    Timeout      time.Duration `validate:"min=1s,max=5m"`
    AllowedHosts []string      `validate:"required,min=1,dive,hostname"`
}

func (c *Config) Validate() error {
    validate := validator.New()
    return validate.Struct(c)
}
```

### Staff Lens: Fail Fast at Startup

Validate all config before accepting traffic. A service that starts with invalid config silently and fails later is worse than one that fails to start. Fail fast, so operators see the error immediately.

---
