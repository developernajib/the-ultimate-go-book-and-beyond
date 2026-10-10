## 90I.9 Shellshock - The 25-Year-Old Bash Bug (2014)

### The Attack Timeline

On September 24, 2014, Stéphane Chazelas disclosed CVE-2014-6271, a critical vulnerability in GNU Bash that had
existed undetected for 25 years since Bash 1.03 in 1989. Named "Shellshock," the vulnerability allowed remote
code execution through specially crafted environment variables. Because Bash is the default shell on virtually
every Unix-like system and is invoked (directly or indirectly) by web servers, SSH, DHCP clients, and countless
other services, the attack surface was enormous.

**The Vulnerability**

Bash allowed functions to be exported via environment variables using a special syntax:

```bash
env x='() { :;}; echo VULNERABLE' bash -c "echo test"
```

The bug was in how Bash parsed these function definitions. When Bash started, it scanned environment variables
for function definitions (strings starting with `() {`). When it found one, it parsed and executed the function
definition - but it continued parsing and executing any commands that followed the closing `}` of the function
definition. This meant an attacker could append arbitrary commands after a function definition in an environment
variable, and those commands would execute when any new Bash process started.

**Attack Vectors**

The most immediate attack vector was CGI scripts on web servers. When a web server invoked a CGI script, it
passed HTTP headers as environment variables. An attacker could send an HTTP request with a header like:

```
User-Agent: () { :;}; /bin/cat /etc/passwd
```

When the CGI script ran (via Bash), the command after the function definition would execute with the privileges
of the web server. Other attack vectors included:
- DHCP clients (DHCP servers could set environment variables that were passed to Bash scripts)
- SSH (the `ForceCommand` feature used environment variables)
- qmail (mail processing scripts)
- Any service that set environment variables and then invoked Bash

**Exploitation in the Wild**

Within hours of disclosure, active exploitation was detected globally. Attackers used Shellshock to:
- Install botnets on vulnerable servers
- Launch DDoS attacks
- Steal credentials and sensitive files
- Pivot into internal networks
- Install cryptocurrency miners

Akamai reported blocking over 600,000 Shellshock attack attempts per day in the weeks following disclosure.

**The Patch Saga**

The initial patch for CVE-2014-6271 was incomplete. Over the following days, five additional CVEs were assigned
for related bypass techniques:
- CVE-2014-6277: Incomplete fix for function parsing
- CVE-2014-6278: Another parser vulnerability
- CVE-2014-7169: Bypass of the original fix
- CVE-2014-7186: Off-by-one error in nested redirection
- CVE-2014-7187: Off-by-one error in `for` loop parsing

### Technical Root Cause Analysis

1. **Mixing code and data in environment variables**: Storing executable code (function definitions) in
   environment variables violates the fundamental security principle of separating code from data.

2. **Parsing user-controlled data as code**: Bash interpreted the contents of environment variables as code,
   creating a direct path from attacker-controlled input to code execution.

3. **25 years of undetected presence**: The bug existed since 1989 and was not discovered until 2014, despite
   Bash being one of the most widely used programs on Earth. This illustrates the limits of organic code review.

### Go Code: Safe Environment Variable Handling

Go programs do not invoke Bash to process environment variables. Go's `os` package reads environment variables
as plain strings, never interpreting them as code. Here is a defensive environment handling library:

```go
package safeenv

import (
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
	"unicode"
)

var (
	ErrInvalidName  = errors.New("invalid environment variable name")
	ErrInvalidValue = errors.New("invalid environment variable value")
	ErrDangerousVal = errors.New("environment variable contains dangerous content")
)

// validNameRegex matches safe environment variable names:
// letters, digits, underscores, starting with a letter or underscore.
var validNameRegex = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

// dangerousPatterns detects Shellshock-style payloads and other dangerous
// content in environment variable values.
var dangerousPatterns = []*regexp.Regexp{
	regexp.MustCompile(`\(\)\s*\{`),                    // Bash function export syntax.
	regexp.MustCompile(`;\s*(rm|curl|wget|nc|bash)\b`), // Command injection.
	regexp.MustCompile("`[^`]+`"),                       // Backtick execution.
	regexp.MustCompile(`$\([^)]+\)`),                  // $(command) substitution.
}

// SafeGetenv retrieves an environment variable, validating its name and
// checking its value for dangerous patterns.
func SafeGetenv(name string) (string, error) {
	if !validNameRegex.MatchString(name) {
		return "", fmt.Errorf("%w: %q", ErrInvalidName, name)
	}

	value := os.Getenv(name)
	if err := validateValue(value); err != nil {
		return "", fmt.Errorf("%w for %s: %v", ErrDangerousVal, name, err)
	}

	return value, nil
}

// SafeGetenvDefault returns a default value if the variable is unset or invalid.
func SafeGetenvDefault(name, defaultValue string) string {
	val, err := SafeGetenv(name)
	if err != nil || val == "" {
		return defaultValue
	}
	return val
}

// SafeSetenv sets an environment variable after validating both name and value.
func SafeSetenv(name, value string) error {
	if !validNameRegex.MatchString(name) {
		return fmt.Errorf("%w: %q", ErrInvalidName, name)
	}

	if err := validateValue(value); err != nil {
		return fmt.Errorf("%w for %s: %v", ErrDangerousVal, name, err)
	}

	return os.Setenv(name, value)
}

// validateValue checks an environment variable value for dangerous patterns.
func validateValue(value string) error {
	for _, pattern := range dangerousPatterns {
		if pattern.MatchString(value) {
			return fmt.Errorf("matches dangerous pattern: %s", pattern.String())
		}
	}

	// Check for null bytes (can cause truncation issues in C-based tools).
	if strings.ContainsRune(value, 0) {
		return errors.New("value contains null bytes")
	}

	// Check for non-printable control characters (except common whitespace).
	for _, r := range value {
		if unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t' {
			return fmt.Errorf("value contains control character: U+%04X", r)
		}
	}

	return nil
}

// SanitizeForCommand prepares a string for safe use as a command argument.
// This is NOT shell escaping - it validates that the string does not contain
// shell metacharacters. If you need to invoke external commands, use
// exec.Command which bypasses the shell entirely.
func SanitizeForCommand(arg string) (string, error) {
	shellMetaChars := `;|&$`+"()`"+`\\\"'<>!{}`
	for _, ch := range shellMetaChars {
		if strings.ContainsRune(arg, ch) {
			return "", fmt.Errorf("argument contains shell metacharacter: %c", ch)
		}
	}
	return arg, nil
}

// SafeExecEnv creates a sanitized copy of the current environment suitable
// for passing to exec.Command. It removes dangerous variables and validates
// remaining values.
func SafeExecEnv(allowedPrefixes []string) []string {
	var safe []string

	for _, env := range os.Environ() {
		parts := strings.SplitN(env, "=", 2)
		if len(parts) != 2 {
			continue
		}
		name, value := parts[0], parts[1]

		// Skip variables known to be dangerous when passed to child processes.
		dangerousNames := map[string]bool{
			"LD_PRELOAD":     true,
			"LD_LIBRARY_PATH": true,
			"BASH_ENV":       true,
			"ENV":            true,
			"BASH_FUNC_%":    true,
			"CDPATH":         true,
			"GLOBIGNORE":     true,
			"IFS":            true,
		}
		if dangerousNames[name] {
			continue
		}

		// Skip Bash function exports (the Shellshock vector).
		if strings.HasPrefix(value, "() {") {
			continue
		}

		// If allowlist is specified, only include matching prefixes.
		if len(allowedPrefixes) > 0 {
			allowed := false
			for _, prefix := range allowedPrefixes {
				if strings.HasPrefix(name, prefix) {
					allowed = true
					break
				}
			}
			if !allowed {
				continue
			}
		}

		safe = append(safe, env)
	}

	return safe
}
```

### Engineering Lessons

1. **Go's `os/exec.Command` bypasses the shell entirely.** Unlike `system()` in C or backticks in many
   scripting languages, Go's `exec.Command` passes arguments directly to the target program without shell
   interpretation, eliminating shell injection by design.

2. **Never interpret data as code.** Shellshock happened because Bash treated environment variable values as
   executable code. This principle applies broadly: user input should never be evaluated, executed, or
   interpreted as code in any context.

3. **Long-lived bugs in ubiquitous software are inevitable.** Shellshock existed for 25 years. Assume that
   similar bugs exist in software you depend on today. Defense in depth, sandboxing, and least privilege
   limit the damage when (not if) they are discovered.

4. **Sanitize the environment before spawning child processes.** Remove dangerous variables like `LD_PRELOAD`,
   `BASH_ENV`, and function exports. Use an allowlist, not a blocklist.

---

### Junior → FAANG: Input-as-Code Vulnerabilities and Subprocess Execution Safety

Shellshock is the interview answer to "what is command injection and how do you prevent it?" Bash treated environment variable values as executable code: a variable whose value was `() { :; }; malicious command` caused Bash to execute `malicious command` when it started. The Go defense is to never pass user-controlled data to shell interpreters. When you must spawn subprocesses, use `exec.Command` with separate arguments rather than `exec.Command("sh", "-c", userInput)`. The `sh -c` pattern hands user input to the shell for parsing, which is the Shellshock vulnerability class. Separate arguments (`exec.Command("ls", userInput)`) pass data directly to the executable without shell interpretation. For the environment sanitization, Go's `os/exec` does not inherit the parent process environment by default when `Cmd.Env` is set explicitly, which is the allowlist approach.

### Senior @ FAANG: Long-Lived Bugs and Layered Defense as Platform Standards

At L6, Shellshock is an argument against assuming that "nobody found a bug in 25 years" means "there is no bug." Shellshock existed in every bash installation from 1989 to 2014. It was present in production systems that had passed thousands of security audits. At staff level, the lesson is that defensive architecture cannot be predicated on the assumption that critical dependencies are free of undiscovered vulnerabilities. Defense in depth means that when a 25-year-old bug is discovered in a dependency tomorrow, the blast radius in your systems is limited by independent controls that do not depend on that dependency being bug-free. For any service that executes subprocess commands or processes environment variables, the platform security standard includes: subprocess execution in a sandboxed environment with minimal capabilities, environment variable allowlisting before passing to child processes, and network egress restrictions that limit what an exploited subprocess can reach. These controls do not prevent Shellshock from being triggered, but they ensure that an exploited Bash subprocess cannot access production databases or exfiltrate data.

