## 109.8 Common Mistakes and How to Avoid Them

### Mistake 1: Logging Secrets

Structured logging frameworks make it dangerously easy to include entire structs or request parameters in log output, and secret values embedded in those fields flow silently into log aggregation systems where they may be accessible to many people. The safe pattern is to redact or omit any value classified as a secret before it ever reaches a logger, using a helper like `redactSecret` that replaces the value with a placeholder before it is formatted.

```go
// WRONG: Logs secret
log.Printf("Connecting with API key: %s", apiKey)

// CORRECT: Never log secrets
log.Printf("Connecting with API key: %s", redactSecret(apiKey))
```

### Mistake 2: Secrets in Error Messages

Error values in Go are often propagated up the call stack, wrapped with additional context, and eventually written to logs or returned in API responses. Any secret embedded in an error message travels that entire path. Error messages should describe what failed at the operation level without including any credential or token value, keeping the diagnostic useful while eliminating the leakage vector entirely.

```go
// WRONG: Exposes secret in error
return fmt.Errorf("failed to connect with password %s", password)

// CORRECT: Generic error
return fmt.Errorf("failed to authenticate to database")
```

### Mistake 3: Hardcoded Secrets

A secret literal embedded in source code is immediately and permanently compromised the moment the repository is cloned or the binary is decompiled, and rotating it requires a code change, a new build, and a redeployment rather than a simple value update. Secrets must be injected at runtime through environment variables, mounted files, or a secrets manager so that the codebase itself contains no sensitive material and rotation can happen without touching source.

```go
// WRONG: Hardcoded in source
const apiKey = "sk_live_abc123xyz"

// CORRECT: Load from secure source
apiKey := os.Getenv("API_KEY")
```

### Mistake 4: Committing .env Files

Environment files are designed for local developer convenience and commonly hold real credentials that should never leave the developer's machine, yet they are frequently committed when `.gitignore` entries are missing or incomplete. Adding every known secret-bearing file pattern to `.gitignore` at project creation time prevents accidental commits, and adding a pre-commit hook that scans for credential patterns provides a second line of defense.

```bash
# Add to .gitignore
.env
.env.local
.env.*.local
secrets/
credentials.json
```

### Junior → FAANG: Common Secrets Mistakes Are Predictable and Preventable

The mistakes covered in this section appear repeatedly in public breach disclosures. A junior who can name all of them and describe the prevention for each is demonstrating security awareness that stands out in interviews.

**Gap to close:** Logging secrets is the most subtle mistake because it often happens indirectly. An error message that includes the full database connection string logs the password. A debug log that prints `fmt.Sprintf("%+v", config)` logs every field including secret fields. Use a logging wrapper that redacts fields with names like `password`, `token`, `key`, and `secret`. Never use `%+v` or `%v` on structs that may contain secret fields.

**First-job habit:** Review every log statement in your service for potential secret exposure. Configure a `logfmt` or JSON logger that redacts fields by name. Run a grep for `fmt.Sprintf("%+v"` and `log.Printf("%+v"` in your codebase and review each occurrence.

**Interview framing:** When asked about secrets mistakes, name the top three: (1) hardcoding in source (git history is forever), (2) logging secrets (appears in log aggregation systems with broad access), (3) no rotation (a compromised static secret is valid indefinitely). Then describe the automation that prevents each: pre-commit hooks, log field redaction, secrets manager with rotation enabled.

### Senior @ FAANG: Systematic Secrets Mistake Prevention

At senior level, preventing secrets mistakes requires automation at every point in the development and operations lifecycle, not individual awareness.

**Pre-commit hooks as a mandatory control:** `gitleaks` as a pre-commit hook prevents secrets from entering the git history. Configure it in the repository's `.pre-commit-config.yaml` and enforce it in CI as well (some developers bypass pre-commit hooks by using `--no-verify`). CI-level secrets scanning catches secrets that bypass the hook. The CI gate is the authoritative control.

**Log scrubbing infrastructure:** Build a structured logger that applies a configurable redaction policy. The policy specifies field names to redact (password, token, secret, key, authorization, cookie) and redacts their values with a fixed string like `[REDACTED]`. Apply this logger as the default throughout your service. Any engineer who uses the default logger gets redaction for free. Engineers who use `fmt.Println` or `log.Printf` bypass the redaction: configure a linter rule that flags direct use of `fmt` and `log` packages in favor of the structured logger.

**Secrets inventory as a compliance control:** Maintain an inventory of all secrets used by each service. The inventory includes: secret name, rotation schedule, owning team, and expiration date. This inventory is the source of truth for rotation monitoring. When a secret approaches expiration (send an alert 30 days before) or when rotation is overdue (send an alert when the last rotation date exceeds the policy period), the owning team is notified. The inventory turns rotation from a reactive task into a proactive, tracked program.

---
