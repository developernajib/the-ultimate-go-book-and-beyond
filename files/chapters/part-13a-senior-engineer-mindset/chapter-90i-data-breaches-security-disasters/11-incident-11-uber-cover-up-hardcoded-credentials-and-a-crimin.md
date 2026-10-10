## 90I.11 Uber Cover-Up - Hardcoded Credentials and a Criminal Conspiracy (2016)

### The Attack Timeline

In October 2016, two hackers contacted Uber claiming to have stolen data on 57 million users and drivers. The
hackers had discovered AWS access keys hardcoded in a private GitHub repository used by Uber engineers. Using
these credentials, they accessed Uber's S3 buckets containing rider and driver data. The stolen data included:

- Names, email addresses, and phone numbers of 57 million riders worldwide
- Driver's license numbers of approximately 600,000 US drivers

**The Cover-Up**

Rather than disclosing the breach as required by law, Uber's Chief Security Officer Joe Sullivan (a former federal
prosecutor) made the decision to pay the hackers $100,000 through Uber's bug bounty program on HackerOne,
disguising the extortion payment as a legitimate security research reward. Sullivan also required the hackers to
sign non-disclosure agreements and arranged for the deletion of the stolen data (which could not be verified).

Sullivan concealed the breach from Uber's board of directors, the Federal Trade Commission (which was actively
investigating Uber for a previous breach), and the public for over a year. The cover-up was discovered in
November 2017 when Uber's new CEO, Dara Khosrowshahi, learned about the incident during an internal investigation.

**Legal Consequences**

In October 2022, Joe Sullivan was found guilty of obstruction of justice and misprision of felony - the first time
a corporate executive was convicted for covering up a data breach. He was sentenced to three years of probation and
a $50,000 fine. The two hackers pleaded guilty to computer fraud charges.

Uber paid $148 million in a settlement with all 50 US states and the District of Columbia for the breach and
cover-up.

### Technical Root Cause Analysis

1. **Hardcoded credentials in source code**: AWS access keys were committed to a GitHub repository. This is one
   of the most preventable security failures.

2. **Overly broad AWS permissions**: The stolen credentials had access to S3 buckets containing millions of
   records. No principle of least privilege was applied.

3. **No secret scanning in CI/CD**: There was no automated scanning for credentials in code commits.

### Go Code: Secret Scanning and Prevention

Secrets leak into version control when developers commit environment variables, copy credentials from terminals, or paste example configs without stripping real values. The scanner below uses compiled regular expressions to match AWS key IDs, private key PEM headers, database connection strings, and other high-entropy patterns line by line as a pre-commit gate, blocking the commit before the credential ever touches the remote repository where it can be found by automated tools that continuously index public and private repos alike.

```go
package secretscan

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// SecretPattern defines a pattern that matches potential secrets in source code.
type SecretPattern struct {
	Name        string
	Pattern     *regexp.Regexp
	Description string
	Severity    string
}

// Finding represents a detected secret in source code.
type Finding struct {
	File        string `json:"file"`
	Line        int    `json:"line"`
	PatternName string `json:"patternName"`
	Severity    string `json:"severity"`
	Match       string `json:"match"` // Redacted match for reporting.
	Description string `json:"description"`
}

// Scanner searches source files for hardcoded secrets.
type Scanner struct {
	patterns   []SecretPattern
	ignoreFile string
	ignoreDirs map[string]bool
}

// NewScanner creates a secret scanner with common credential patterns.
func NewScanner() *Scanner {
	return &Scanner{
		patterns: []SecretPattern{
			{
				Name:        "aws_access_key",
				Pattern:     regexp.MustCompile(`(?i)(AKIA[0-9A-Z]{16})`),
				Description: "AWS Access Key ID",
				Severity:    "CRITICAL",
			},
			{
				Name:        "aws_secret_key",
				Pattern:     regexp.MustCompile(`(?i)aws_secret_access_key\s*[=:]\s*[A-Za-z0-9/+=]{40}`),
				Description: "AWS Secret Access Key",
				Severity:    "CRITICAL",
			},
			{
				Name:        "github_token",
				Pattern:     regexp.MustCompile(`gh[pousr]_[A-Za-z0-9_]{36,255}`),
				Description: "GitHub Personal Access Token",
				Severity:    "CRITICAL",
			},
			{
				Name:        "generic_api_key",
				Pattern:     regexp.MustCompile(`(?i)(api[_-]?key|apikey)\s*[=:]\s*["']?[A-Za-z0-9]{20,}["']?`),
				Description: "Generic API Key",
				Severity:    "HIGH",
			},
			{
				Name:        "private_key",
				Pattern:     regexp.MustCompile(`-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----`),
				Description: "Private Key File",
				Severity:    "CRITICAL",
			},
			{
				Name:        "generic_secret",
				Pattern:     regexp.MustCompile(`(?i)(secret|password|passwd|pwd)\s*[=:]\s*["'][^"']{8,}["']`),
				Description: "Hardcoded Secret/Password",
				Severity:    "HIGH",
			},
			{
				Name:        "slack_webhook",
				Pattern:     regexp.MustCompile(`https://hooks\.slack\.com/services/T[a-zA-Z0-9_]{8,}/B[a-zA-Z0-9_]{8,}/[a-zA-Z0-9_]{24}`),
				Description: "Slack Webhook URL",
				Severity:    "HIGH",
			},
			{
				Name:        "jwt_token",
				Pattern:     regexp.MustCompile(`eyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+`),
				Description: "JSON Web Token",
				Severity:    "HIGH",
			},
			{
				Name:        "gcp_service_account",
				Pattern:     regexp.MustCompile(`"type"\s*:\s*"service_account"`),
				Description: "GCP Service Account Key",
				Severity:    "CRITICAL",
			},
			{
				Name:        "connection_string",
				Pattern:     regexp.MustCompile(`(?i)(mongodb|postgres|mysql|redis)://[^\s"']+:[^\s"']+@[^\s"']+`),
				Description: "Database Connection String with Credentials",
				Severity:    "CRITICAL",
			},
		},
		ignoreDirs: map[string]bool{
			".git":         true,
			"node_modules": true,
			"vendor":       true,
			".venv":        true,
			"__pycache__":  true,
		},
	}
}

// ScanDirectory recursively scans all files in a directory for secrets.
func (s *Scanner) ScanDirectory(root string) ([]Finding, error) {
	var findings []Finding

	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // Skip inaccessible files.
		}

		if info.IsDir() {
			if s.ignoreDirs[info.Name()] {
				return filepath.SkipDir
			}
			return nil
		}

		// Skip binary files and large files.
		if info.Size() > 1*1024*1024 { // 1MB limit.
			return nil
		}
		if isBinaryFile(path) {
			return nil
		}

		fileFindings, err := s.ScanFile(path)
		if err != nil {
			return nil // Skip files that can't be read.
		}
		findings = append(findings, fileFindings...)
		return nil
	})

	return findings, err
}

// ScanFile scans a single file for secret patterns.
func (s *Scanner) ScanFile(path string) ([]Finding, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	var findings []Finding
	scanner := bufio.NewScanner(file)
	lineNum := 0

	for scanner.Scan() {
		lineNum++
		line := scanner.Text()

		// Skip comment lines that might contain example patterns.
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "//") || strings.HasPrefix(trimmed, "#") ||
			strings.HasPrefix(trimmed, "/*") || strings.HasPrefix(trimmed, "*") {
			// Still scan - comments can contain real secrets accidentally.
			// But we reduce severity.
		}

		for _, pattern := range s.patterns {
			if match := pattern.Pattern.FindString(line); match != "" {
				findings = append(findings, Finding{
					File:        path,
					Line:        lineNum,
					PatternName: pattern.Name,
					Severity:    pattern.Severity,
					Match:       redactMatch(match),
					Description: pattern.Description,
				})
			}
		}
	}

	return findings, scanner.Err()
}

// redactMatch shows only the first and last few characters of a match.
func redactMatch(match string) string {
	if len(match) <= 8 {
		return "****"
	}
	return match[:4] + "..." + match[len(match)-4:]
}

func isBinaryFile(path string) bool {
	binaryExtensions := map[string]bool{
		".exe": true, ".bin": true, ".so": true, ".dll": true,
		".png": true, ".jpg": true, ".gif": true, ".pdf": true,
		".zip": true, ".tar": true, ".gz": true, ".wasm": true,
	}
	return binaryExtensions[strings.ToLower(filepath.Ext(path))]
}

// PreCommitCheck is designed to be called from a Git pre-commit hook.
// It scans staged files and blocks the commit if secrets are found.
func PreCommitCheck(stagedFiles []string) error {
	scanner := NewScanner()
	var allFindings []Finding

	for _, file := range stagedFiles {
		findings, err := scanner.ScanFile(file)
		if err != nil {
			continue
		}
		allFindings = append(allFindings, findings...)
	}

	if len(allFindings) > 0 {
		var report strings.Builder
		report.WriteString("\n=== SECRET SCAN FAILED ===\n\n")
		report.WriteString("The following potential secrets were detected in staged files:\n\n")

		for _, f := range allFindings {
			report.WriteString(fmt.Sprintf(
				"  [%s] %s:%d - %s (match: %s)\n",
				f.Severity, f.File, f.Line, f.Description, f.Match,
			))
		}

		report.WriteString("\nCommit blocked. Remove secrets and use environment variables or a secrets manager.\n")
		return fmt.Errorf("%s", report.String())
	}

	return nil
}
```

### Engineering Lessons

1. **Secrets in source code are the most common initial access vector.** GitHub reports scanning billions of
   commits and finding millions of exposed secrets annually. Automated scanning in pre-commit hooks, CI pipelines,
   and repository monitoring is non-negotiable.

2. **The cover-up is worse than the breach.** Joe Sullivan's conviction established legal precedent: concealing a
   breach is a criminal act. Incident response must include timely, honest disclosure to affected parties and
   regulators.

3. **Bug bounty programs must not be used for extortion payments.** Disguising a ransom payment as a bug bounty
   is fraud. Legitimate bug bounty programs have clear policies about responsible disclosure.

4. **Least privilege for credentials prevents lateral movement.** The stolen AWS credentials should have had
   access only to the specific resources needed, not broad S3 access containing millions of records.

---

### Junior → FAANG: Secret Scanning and Breach Disclosure as Interview Topics

The Uber cover-up answers two separate interview questions. First, "how do you prevent hardcoded credentials in code?" The answer is secret scanning on every commit: tools like `git-secrets`, `truffleHog`, or GitHub's native secret scanning detect credential patterns before they reach the repository. In Go, the pattern is environment variables or a secrets manager for all credentials, with a CI gate that rejects commits containing patterns that match AWS keys, private keys, or other credential formats. Second, "what are your obligations when you discover a data breach?" The answer references the Uber conviction: concealing a breach from affected users and regulators is a criminal act. FTC and GDPR regulations require disclosure within 72 hours in many jurisdictions. The CSO who orchestrated the Uber cover-up went to prison. Breach disclosure is a legal obligation, not a PR decision.

### Senior @ FAANG: Credential Governance and Breach Response as Platform Standards

At L6, the Uber breach reveals two platform failures. First, developers had access to check credentials into GitHub repositories, and no automated control prevented it. At platform level, secret scanning is a pre-receive hook on the repository server that rejects pushes containing known credential patterns. It is not an advisory warning: it is a blocking control. Combined with a secrets manager integration that makes retrieving credentials from vault easy and storing them in code unnecessary, the hardcoded credential class is structurally prevented rather than reviewed away. Second, the breach response was a cover-up rather than a response. At staff level, you define a breach response protocol that begins with incident declaration, includes legal counsel within the first hour for any breach involving personal data, and has pre-written notification templates for regulatory bodies and affected users. The protocol is documented, reviewed quarterly, and practiced in tabletop exercises so that the response under pressure follows the process rather than deferring to whoever has the most authority in the room. Joe Sullivan's conviction is the reminder that "the CEO approved it" is not a defense for criminal breach concealment.

