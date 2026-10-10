## 118D.2 AI for Architecture & Design Discussions

### Using AI as a Rubber Duck on Steroids

The rubber duck debugging technique, explaining your problem to an inanimate object to force clarity of thought, is one of the most effective debugging and design techniques in software engineering. AI turns the duck from a passive listener into an active participant that asks clarifying questions, identifies gaps in your reasoning, and suggests alternatives you had not considered.

Keep hold of why the original duck works, though, because it explains both the upside and the risk. The duck helps because *you* do the thinking out loud - the value was never in the duck. A duck that talks back is more useful and also more dangerous, because it can now supply an answer that ends your thinking prematurely. The goal of these conversations is to sharpen your reasoning, not to outsource it.

The key insight is that AI is most valuable for architecture discussions *before* you write code, not after. Changing a design on a whiteboard costs minutes. Changing a design in production costs weeks.

### Prompting AI to Challenge Your Design Decisions

The single most valuable prompt pattern for architecture discussions is the **adversarial review**. Instead of asking AI to validate your design, ask it to attack it.

**Template: Architecture Challenge Prompt**

```
I'm designing [system/component] for [context]. Here's my current design:

[Describe your architecture in 3-10 sentences]

Key constraints:
- [Constraint 1: e.g., "must handle 10K requests/second"]
- [Constraint 2: e.g., "team of 3 engineers, no dedicated DevOps"]
- [Constraint 3: e.g., "must integrate with existing PostgreSQL database"]

Please act as a senior staff engineer reviewing this design. I want you to:
1. Identify the 3 most likely failure modes in production
2. Point out any scalability bottlenecks I'm not seeing
3. Challenge my assumptions: what am I taking for granted that might be wrong?
4. Suggest one alternative architecture I should consider
5. If you were betting your production SLA on this design, what would keep you up at night?

Be direct and specific. I'd rather hear hard truths now than discover them in production.
```

### Getting AI to Explore Trade-offs You Haven't Considered

**Template: Trade-off Exploration Prompt**

```
I need to decide between [Option A] and [Option B] for [specific component].

Context:
- Current traffic: [X requests/second]
- Expected growth: [Y over Z months]
- Team size: [N engineers]
- Existing infrastructure: [what you already have]
- Budget constraints: [if relevant]

For each option, analyze:
1. Implementation complexity (time to build, test, deploy)
2. Operational complexity (monitoring, debugging, on-call burden)
3. Scaling characteristics (what breaks first as traffic grows 10x)
4. Failure modes (what happens when this component fails)
5. Migration path (can we switch later if we choose wrong?)

I'm specifically worried about [your specific concern]. Address that directly.
```

### Example: Designing a Rate Limiter, a Full Conversation with AI

Here is a realistic architecture discussion. Notice how the engineer drives the conversation while AI provides analysis.

```
ENGINEER: I need to add rate limiting to our Go API. We have about 50
endpoints, 200 requests/second average, 2000/second peak. Currently
running 3 instances behind an AWS ALB. I'm thinking of implementing
a token bucket per API key, stored in Redis.

AI: Good starting point. A few questions before I analyze:

1. Do you need rate limiting per-endpoint or just per-API-key globally?
   (Per-endpoint is more complex but prevents one heavy endpoint from
   consuming the entire quota)

2. What's your Redis setup? Single node, sentinel, or cluster? This
   matters for the consistency model of your rate limiter.

3. What should happen when Redis is unavailable? Fail open (allow all
   requests) or fail closed (reject all requests)?

4. Do you need burst handling? Token bucket naturally supports bursts
   up to the bucket size, but you might want stricter burst control.

ENGINEER: Good questions.
1. Per API key globally for now, per-endpoint later.
2. Single Redis node, ElastiCache.
3. Fail open. We'd rather serve than reject during a Redis outage.
4. Yes, we want to allow short bursts up to 2x the normal rate.

AI: Here's my analysis of your design:

STRENGTHS:
- Token bucket is the right algorithm for your burst requirement
- Redis gives you consistent rate limiting across your 3 instances
- Per-API-key is the right starting granularity

CONCERNS:
1. Single Redis node is a SPOF for your rate limiter. If ElastiCache
   fails, you fail open (your choice), but you have NO rate limiting
   during that window. An attacker could exploit this. Consider:
   local in-memory rate limiting as a fallback (imprecise but better
   than nothing).

2. At 2000 req/sec peak, each rate limit check is a Redis round trip
   (~1ms). That's 2 seconds of cumulative latency per second across
   all requests. Consider using a Lua script to make the token bucket
   check-and-decrement atomic in a single round trip.

3. You said "per-endpoint later", so design your Redis key schema now
   to support it: `ratelimit:{api_key}:{endpoint}` even if you only
   use `ratelimit:{api_key}:*` initially. Migrating key schemas in
   production Redis is painful.

4. What's your response when rate limited? Return 429 with
   Retry-After header. Include rate limit headers on ALL responses
   (X-RateLimit-Remaining, X-RateLimit-Reset) so clients can
   self-throttle.

ALTERNATIVE TO CONSIDER:
Have you looked at a sliding window counter instead of token bucket?
For your traffic pattern (moderate volume, bursty), sliding window
gives more predictable behavior and is simpler to implement. The
trade-off is less burst tolerance, but you can tune the window size.

ENGINEER: The fallback idea is great. I hadn't considered the Redis
failure window as an attack vector. Let me implement with both Redis
token bucket (primary) and local sliding window (fallback).
```

### Go Code: Building an AI-Powered Architecture Review Tool

This tool reads a Go project's structure and uses an LLM to provide architecture feedback.

```go
// Package archreview analyzes a Go project's structure and asks an LLM to
// review it. Wire it up from your own main package.
package archreview

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// ArchitectureReview holds the structured output of an AI architecture review.
type ArchitectureReview struct {
	ProjectName     string          `json:"project_name"`
	ReviewDate      time.Time       `json:"review_date"`
	PackageCount    int             `json:"package_count"`
	Findings        []ReviewFinding `json:"findings"`
	Recommendations []string        `json:"recommendations"`
	RiskScore       int             `json:"risk_score"` // 1-10
}

// ReviewFinding represents a single finding from the architecture review.
type ReviewFinding struct {
	Category    string `json:"category"` // "coupling", "complexity", "naming", "security"
	Severity    string `json:"severity"` // "critical", "warning", "info"
	Package     string `json:"package"`
	Description string `json:"description"`
	Suggestion  string `json:"suggestion"`
}

// ProjectStructure captures the high-level shape of a Go project.
type ProjectStructure struct {
	Packages     []PackageInfo    `json:"packages"`
	Dependencies []DependencyInfo `json:"dependencies"`
	Interfaces   []InterfaceInfo  `json:"interfaces"`
	EntryPoints  []string         `json:"entry_points"`
}

// PackageInfo describes a single Go package.
type PackageInfo struct {
	Name       string   `json:"name"`
	Path       string   `json:"path"`
	Files      int      `json:"file_count"`
	Functions  int      `json:"function_count"`
	Types      int      `json:"type_count"`
	Imports    []string `json:"imports"`
	Exported   int      `json:"exported_symbols"`
	Unexported int      `json:"unexported_symbols"`
}

// DependencyInfo captures import relationships between packages.
type DependencyInfo struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// InterfaceInfo describes a Go interface definition.
type InterfaceInfo struct {
	Package string   `json:"package"`
	Name    string   `json:"name"`
	Methods []string `json:"methods"`
}

// LLMClient abstracts the AI provider for architecture review.
type LLMClient interface {
	Complete(ctx context.Context, prompt string) (string, error)
}

// AnthropicClient implements LLMClient for Claude.
type AnthropicClient struct {
	apiKey     string
	model      string
	httpClient *http.Client
}

// NewAnthropicClient creates a client configured for Claude.
func NewAnthropicClient(apiKey, model string) *AnthropicClient {
	return &AnthropicClient{
		apiKey: apiKey,
		model:  model,
		httpClient: &http.Client{
			Timeout: 120 * time.Second,
		},
	}
}

// Complete sends a prompt to Claude and returns the response.
func (c *AnthropicClient) Complete(ctx context.Context, prompt string) (string, error) {
	reqBody := map[string]any{
		"model":      c.model,
		"max_tokens": 4096,
		"messages": []map[string]string{
			{"role": "user", "content": prompt},
		},
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return "", fmt.Errorf("marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://api.anthropic.com/v1/messages", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", c.apiKey)
	// The anthropic-version header pins the wire contract. "2023-06-01" is the
	// Messages API version - it is a contract identifier, not a "use the latest
	// release" dial, so it does not track the current year. Inventing a
	// plausible-looking date here (2024-01-01, say) gets the request rejected.
	req.Header.Set("anthropic-version", "2023-06-01")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		// Include the body. "API returned status 400" with no detail turns a
		// one-line fix into a debugging session.
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
		return "", fmt.Errorf("API returned status %d: %s", resp.StatusCode, body)
	}

	var result struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("decode response: %w", err)
	}

	// Concatenate text blocks rather than returning Content[0].Text: with
	// thinking enabled the first block is a thinking block and [0].Text is "".
	var sb strings.Builder
	for _, block := range result.Content {
		if block.Type == "text" {
			sb.WriteString(block.Text)
		}
	}
	if sb.Len() == 0 {
		return "", fmt.Errorf("no text content in API response")
	}

	return sb.String(), nil
}

// AnalyzeProject walks a Go project directory and extracts its structure.
//
// Note on go/parser.ParseDir: it is deprecated (it ignores build tags when
// grouping files into packages, so a file behind //go:build linux lands in the
// same package as its darwin counterpart). It is used here because it keeps the
// example short and self-contained, and because for a structural overview the
// inaccuracy is tolerable. For anything that must be correct about the build,
// use golang.org/x/tools/go/packages, which runs the real go command and
// resolves build constraints, imports, and types properly.
func AnalyzeProject(root string) (*ProjectStructure, error) {
	structure := &ProjectStructure{}
	fset := token.NewFileSet()

	// WalkDir rather than Walk: it avoids an os.Lstat per entry.
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}

		if !d.IsDir() {
			return nil
		}

		// Skip vendor and hidden directories, but never the root itself:
		// a project at "." has Name() == ".", which HasPrefix(".") matches,
		// and returning SkipDir there would silently analyze nothing.
		name := d.Name()
		if path != root && (name == "vendor" || name == "testdata" || strings.HasPrefix(name, ".")) {
			return filepath.SkipDir
		}

		pkgs, parseErr := parser.ParseDir(fset, path, nil, parser.ParseComments)
		if parseErr != nil {
			return nil // Skip unparseable directories.
		}

		{

			for pkgName, pkg := range pkgs {
				pkgInfo := PackageInfo{
					Name: pkgName,
					Path: path,
				}

				for _, file := range pkg.Files {
					pkgInfo.Files++

					for _, imp := range file.Imports {
						importPath := strings.Trim(imp.Path.Value, `"`)
						if !slices.Contains(pkgInfo.Imports, importPath) {
							pkgInfo.Imports = append(pkgInfo.Imports, importPath)
						}
					}

					for _, decl := range file.Decls {
						switch d := decl.(type) {
						case *ast.FuncDecl:
							pkgInfo.Functions++
							if d.Name.IsExported() {
								pkgInfo.Exported++
							} else {
								pkgInfo.Unexported++
							}

							// Check for main function as entry point.
							if d.Name.Name == "main" && pkgName == "main" {
								structure.EntryPoints = append(
									structure.EntryPoints, path)
							}

						case *ast.GenDecl:
							for _, spec := range d.Specs {
								if ts, ok := spec.(*ast.TypeSpec); ok {
									pkgInfo.Types++
									if ts.Name.IsExported() {
										pkgInfo.Exported++
									} else {
										pkgInfo.Unexported++
									}

									// Extract interface information.
									if iface, ok := ts.Type.(*ast.InterfaceType); ok {
										ifaceInfo := InterfaceInfo{
											Package: pkgName,
											Name:    ts.Name.Name,
										}
										for _, method := range iface.Methods.List {
											for _, name := range method.Names {
												ifaceInfo.Methods = append(
													ifaceInfo.Methods, name.Name)
											}
										}
										structure.Interfaces = append(
											structure.Interfaces, ifaceInfo)
									}
								}
							}
						}
					}
				}

				structure.Packages = append(structure.Packages, pkgInfo)
			}
		}

		// Return nil, NOT filepath.SkipDir.
		//
		// This was the bug. Returning SkipDir after parsing a directory tells
		// WalkDir to skip that directory's *entire subtree*, so the walk parsed
		// the root package and then stopped. Every nested package went
		// unanalyzed. The tool still produced a confident review, of one
		// package, describing itself as a review of the project. A reviewer
		// reading the output has no way to tell that most of the code was never
		// looked at, which is the worst property a review tool can have.
		return nil
	})

	if err != nil {
		return nil, fmt.Errorf("walk project: %w", err)
	}

	// Build dependency graph from imports.
	for _, pkg := range structure.Packages {
		for _, imp := range pkg.Imports {
			structure.Dependencies = append(structure.Dependencies, DependencyInfo{
				From: pkg.Name,
				To:   imp,
			})
		}
	}

	return structure, nil
}

// BuildReviewPrompt constructs the architecture review prompt.
func BuildReviewPrompt(structure *ProjectStructure) string {
	var sb strings.Builder

	sb.WriteString(`You are a senior Go architect reviewing a project's structure.
Analyze the following project and provide:
1. Architecture findings (coupling, complexity, naming, security concerns)
2. Specific recommendations for improvement
3. A risk score from 1-10

Project Structure:
`)

	sb.WriteString(fmt.Sprintf("Packages: %d\n", len(structure.Packages)))
	sb.WriteString(fmt.Sprintf("Interfaces: %d\n", len(structure.Interfaces)))
	sb.WriteString(fmt.Sprintf("Entry Points: %d\n\n", len(structure.EntryPoints)))

	for _, pkg := range structure.Packages {
		sb.WriteString(fmt.Sprintf("Package: %s (%s)\n", pkg.Name, pkg.Path))
		sb.WriteString(fmt.Sprintf("  Files: %d, Functions: %d, Types: %d\n",
			pkg.Files, pkg.Functions, pkg.Types))
		sb.WriteString(fmt.Sprintf("  Exported: %d, Unexported: %d\n",
			pkg.Exported, pkg.Unexported))
		sb.WriteString(fmt.Sprintf("  Imports: %s\n\n",
			strings.Join(pkg.Imports, ", ")))
	}

	sb.WriteString("\nInterfaces defined:\n")
	for _, iface := range structure.Interfaces {
		sb.WriteString(fmt.Sprintf("  %s.%s: %s\n",
			iface.Package, iface.Name, strings.Join(iface.Methods, ", ")))
	}

	sb.WriteString(`

Respond in JSON format:
{
  "findings": [
    {
      "category": "coupling|complexity|naming|security",
      "severity": "critical|warning|info",
      "package": "package_name",
      "description": "what you found",
      "suggestion": "how to fix it"
    }
  ],
  "recommendations": ["recommendation 1", "recommendation 2"],
  "risk_score": 5
}
`)

	return sb.String()
}

// extractJSON pulls a JSON object out of a model response.
//
// Asking for "respond in JSON format" gets you a bare object most of the time,
// a Markdown-fenced object much of the rest of the time, and occasionally a
// "Here's the review:" preamble first. json.Unmarshal rejects everything except
// the first form, so a parser that assumes a bare object passes in testing and
// fails intermittently in production. That reads to the team as "the AI is
// flaky" when the truth is that the format was requested but never enforced.
//
// This is a pragmatic fallback. The real fix, where the provider supports it,
// is a structured-output or tool-call mode that constrains generation to your
// schema, so the response cannot be prose in the first place. Prefer that, and
// keep this for models and providers that lack it.
func extractJSON(s string) string {
	s = strings.TrimSpace(s)

	// Strip a Markdown code fence if present.
	fence := strings.Repeat("`", 3)
	if i := strings.Index(s, fence); i != -1 {
		rest := s[i+len(fence):]
		if nl := strings.IndexByte(rest, '\n'); nl != -1 {
			rest = rest[nl+1:] // drop the language-tag line
		}
		if end := strings.Index(rest, fence); end != -1 {
			s = strings.TrimSpace(rest[:end])
		}
	}

	// Fall back to the outermost braces.
	start := strings.IndexByte(s, '{')
	end := strings.LastIndexByte(s, '}')
	if start != -1 && end > start {
		return s[start : end+1]
	}
	return s
}

// ReviewProject orchestrates the full architecture review.
func ReviewProject(ctx context.Context, projectPath string, llm LLMClient) (*ArchitectureReview, error) {
	slog.Info("analyzing project structure", "path", projectPath)

	structure, err := AnalyzeProject(projectPath)
	if err != nil {
		return nil, fmt.Errorf("analyze project: %w", err)
	}

	slog.Info("project analyzed",
		"packages", len(structure.Packages),
		"interfaces", len(structure.Interfaces),
	)

	prompt := BuildReviewPrompt(structure)

	slog.Info("sending to AI for review")
	response, err := llm.Complete(ctx, prompt)
	if err != nil {
		return nil, fmt.Errorf("AI review: %w", err)
	}

	var reviewData struct {
		Findings        []ReviewFinding `json:"findings"`
		Recommendations []string        `json:"recommendations"`
		RiskScore       int             `json:"risk_score"`
	}

	if err := json.Unmarshal([]byte(extractJSON(response)), &reviewData); err != nil {
		return nil, fmt.Errorf("parse AI response: %w", err)
	}

	// Validate the score rather than trusting it. The model was asked for 1-10
	// and will usually comply, but "usually" is not a range check, and an
	// out-of-range value silently corrupts any dashboard built on this field.
	if reviewData.RiskScore < 1 || reviewData.RiskScore > 10 {
		return nil, fmt.Errorf("risk_score %d out of range 1-10", reviewData.RiskScore)
	}

	review := &ArchitectureReview{
		ProjectName:     filepath.Base(projectPath),
		ReviewDate:      time.Now(),
		PackageCount:    len(structure.Packages),
		Findings:        reviewData.Findings,
		Recommendations: reviewData.Recommendations,
		RiskScore:       reviewData.RiskScore,
	}

	return review, nil
}
```

> **What AI Gets Wrong**: When discussing architecture, AI tends to suggest overengineered solutions. If you describe a small service handling 100 requests per second, AI might suggest Kafka, Redis clusters, and sharded databases. Always ground the discussion in your actual scale: "We have 3 engineers and 100 req/sec. What is the simplest architecture that works?"

> **Pro Tip**: The best architecture prompts include constraints. "Design a rate limiter" produces generic output. "Design a rate limiter for a team of 2, running on a single EC2 instance, handling 500 req/sec, with no Redis budget" produces practical output.

### Junior → FAANG: AI Architecture Discussions as System Design Practice

Using AI as an architecture design partner is the most effective system design interview practice tool available to junior engineers. Run design sessions where you describe a system design problem to AI, propose a solution, and ask AI to challenge your design ("what are the weaknesses in this approach?", "what happens when the database is unavailable?", "how does this scale to 10x the current load?"). This practice develops the design defense skill that FAANG system design interviews require: you will be asked to defend your design choices against exactly these types of challenges.

The "overengineered solutions" warning is the most important calibration point for architecture design discussions with AI. When AI suggests Kafka, Redis clusters, and sharded databases for a service with 100 req/sec, the correct response is not to implement those suggestions but to ask: "Given that this is a 3-engineer team with 100 req/sec, is there a simpler solution that avoids operational overhead?" This follow-up prompt, with the specific constraints, produces practical output that matches the actual requirements. Practice including constraints in every architecture prompt until it becomes automatic.

The "constraints make better outputs" principle applies directly to system design interviews: always state your constraints before proposing solutions. "Given that this is a read-heavy workload with 100:1 read-to-write ratio, here is my caching strategy" is a better framing than jumping directly to the solution. AI practice trains this framing discipline because you see the quality difference between constrained and unconstrained prompts immediately.

### Senior @ FAANG: AI Architecture Partner as Design Review Accelerator

At senior level, AI as an architecture design partner accelerates the design review process by enabling pre-reviews before the formal review. Before presenting a design to the team, run it through AI with the prompt "critique this architecture design from the perspective of a senior engineer who prioritizes simplicity, operational reliability, and cost efficiency." The AI critique will identify the obvious issues, allowing you to address them before the team review, which then focuses on the genuinely complex design questions that require human judgment. This two-phase review process (AI pre-review plus human review) produces better designs in less total review time.

The "rubber duck on steroids" framing has an organizational implication: AI architecture discussions scale to every engineer on the team, not just those with access to senior engineers for impromptu design conversations. A junior engineer who wants to discuss an architecture decision at 11pm before their morning presentation can have that discussion with AI rather than waiting until the next day. This democratization of design discussion access is one of the most valuable effects of AI tools on engineering team dynamics, and senior engineers can accelerate it by sharing effective architecture discussion prompts and workflows.

---
