## 90G.4 Claude/Anthropic's Three Overlapping Bugs: When AI Infrastructure Fails

### The Incident

Between August and September 2025, Anthropic's Claude AI service experienced a series of overlapping
infrastructure bugs that collectively degraded service quality for weeks. The incident is particularly instructive
because it involved three separate bugs across different hardware platforms (TPUs and GPUs), each producing
different symptoms, creating contradictory diagnostic signals that made root cause analysis exceptionally
difficult.

**Bug A: Context Window Routing Error (August 2025)**

The first bug was a load balancer misconfiguration that routed requests for Claude Sonnet 4 to servers configured
for 1-million-token context windows when the requests only needed standard context. This started at a 0.8%
misrouting rate - low enough to be noise in most monitoring systems. On August 29, a load balancer configuration
change increased the misrouting rate to 16%. Approximately 30% of Claude Code users experienced degraded message
quality because their requests were being processed by infrastructure optimized for a different workload profile.

**Bug B: TPU Misconfiguration - Output Corruption (August-September 2025)**

The second bug was a TPU misconfiguration that caused output corruption. English-language prompts would receive
responses containing unexpected Thai or Chinese characters interspersed with the expected English output.
Code generation requests would produce syntactically invalid code with random character insertions. This affected
Claude Opus 4.1/4 and Sonnet 4 models running on TPU infrastructure.

**Bug C: XLA:TPU Compiler Miscompilation - Token Probability Corruption**

The third bug was the most subtle. A latent compiler bug in the XLA:TPU compiler's implementation of the
approximate top-k operation caused the highest-probability token to vanish from the sampling distribution under
specific conditions. The bug was triggered by mixed bf16/fp32 precision in the top-k operation. The fix was to
switch from approximate top-k to exact top-k.

**Why Detection Was So Difficult:**

```
┌──────────────────────────────────────────────────────────────────────┐
│            Three Overlapping Bugs - Contradictory Signals            │
│                                                                      │
│  Bug A (Routing)          Bug B (TPU Config)     Bug C (Compiler)    │
│  ┌──────────────┐         ┌──────────────┐       ┌──────────────┐    │
│  │ 0.8% → 16%   │         │ Random chars │       │ Best token   │    │
│  │ misrouted    │         │ in output    │       │ vanishes     │    │
│  │ requests     │         │ Thai/Chinese │       │ from top-k   │    │
│  └──────┬───────┘         └──────┬───────┘       └──────┬───────┘    │
│         │                        │                      │            │
│         ▼                        ▼                      ▼            │
│  Affects: Sonnet 4       Affects: Opus 4.1/4    Affects: All TPU     │
│  Platform: GPU+TPU       Platform: TPU only     Platform: TPU only   │
│  Symptom: Degraded       Symptom: Corrupted     Symptom: Subtly      │
│           quality                 output                  wrong      │
│                                                          output      │
│         │                        │                      │            │
│         └────────────┬───────────┘──────────────────────┘            │
│                      ▼                                               │
│  Combined effect: reports of "Claude getting dumber" from users      │
│  Contradictory diagnostics: symptoms change based on which bug       │
│  hits which request. Standard benchmarks don't catch it because      │
│  LLMs recover from isolated bad tokens.                              │
│                                                                      │
│  ADDITIONALLY:                                                       │
│  - Privacy controls limited debugging access to production traces    │
│  - Three bugs across TPUs, GPUs, Trainium produced mixed signals     │
│  - March 2026: Multiple auth outages + DST infinite loop bug         │
└──────────────────────────────────────────────────────────────────────┘
```

### Go Implementation: AI Quality Monitoring System

The key takeaway for Go engineers is that monitoring AI systems requires different approaches than monitoring
traditional services. Standard health checks (is the service returning 200?) miss quality degradation entirely.
You need output quality monitoring.

```go
package aiquality

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"strings"
	"sync"
	"time"
	"unicode"
)

// QualityMonitor continuously validates AI model output quality across
// multiple dimensions, catching the class of bugs Anthropic experienced.
type QualityMonitor struct {
	checks   []QualityCheck
	alerter  func(ctx context.Context, alert QualityAlert) error
	logger   *slog.Logger

	mu       sync.RWMutex
	metrics  map[string]*QualityMetrics
}

// QualityCheck defines a single quality validation function.
type QualityCheck struct {
	Name        string
	Description string
	Check       func(request, response string) *QualityViolation
}

// QualityViolation represents a detected quality issue.
type QualityViolation struct {
	CheckName   string
	Severity    string // "warning", "error", "critical"
	Description string
	Details     map[string]any
}

// QualityMetrics tracks quality statistics over a time window.
type QualityMetrics struct {
	CheckName       string
	TotalChecked    int64
	ViolationCount  int64
	WindowStart     time.Time
	RecentViolations []QualityViolation
}

// QualityAlert is sent when quality thresholds are exceeded.
type QualityAlert struct {
	CheckName      string
	ViolationRate  float64
	Threshold      float64
	SampleSize     int64
	RecentExamples []QualityViolation
	Timestamp      time.Time
}

// NewQualityMonitor creates a monitor with standard AI quality checks.
func NewQualityMonitor(
	alerter func(ctx context.Context, alert QualityAlert) error,
	logger *slog.Logger,
) *QualityMonitor {
	m := &QualityMonitor{
		alerter: alerter,
		logger:  logger,
		metrics: make(map[string]*QualityMetrics),
	}

	m.checks = []QualityCheck{
		m.unexpectedScriptCheck(),
		m.languageMismatchCheck(),
		m.syntaxCorruptionCheck(),
		m.repetitionCheck(),
		m.truncationCheck(),
		m.coherenceCheck(),
	}

	for _, c := range m.checks {
		m.metrics[c.Name] = &QualityMetrics{
			CheckName:   c.Name,
			WindowStart: time.Now(),
		}
	}

	return m
}

// Validate runs all quality checks against a request-response pair.
// This should be called on a sample of production traffic (e.g., 5-10%).
func (m *QualityMonitor) Validate(ctx context.Context, request, response string) []QualityViolation {
	var violations []QualityViolation

	for _, check := range m.checks {
		if v := check.Check(request, response); v != nil {
			violations = append(violations, *v)
			m.recordViolation(ctx, check.Name, *v)
		} else {
			m.recordSuccess(check.Name)
		}
	}

	return violations
}

func (m *QualityMonitor) recordViolation(ctx context.Context, checkName string, v QualityViolation) {
	m.mu.Lock()
	metrics := m.metrics[checkName]
	metrics.TotalChecked++
	metrics.ViolationCount++
	metrics.RecentViolations = append(metrics.RecentViolations, v)
	if len(metrics.RecentViolations) > 100 {
		metrics.RecentViolations = metrics.RecentViolations[1:]
	}

	rate := float64(metrics.ViolationCount) / float64(metrics.TotalChecked)
	m.mu.Unlock()

	// Alert thresholds based on Anthropic's experience:
	// Bug A started at 0.8% and was missed. Alert at 0.5%.
	threshold := 0.005
	if rate > threshold && metrics.TotalChecked >= 1000 {
		m.alerter(ctx, QualityAlert{
			CheckName:     checkName,
			ViolationRate: rate,
			Threshold:     threshold,
			SampleSize:    metrics.TotalChecked,
			Timestamp:     time.Now(),
		})
	}
}

func (m *QualityMonitor) recordSuccess(checkName string) {
	m.mu.Lock()
	m.metrics[checkName].TotalChecked++
	m.mu.Unlock()
}

// unexpectedScriptCheck detects Bug B: unexpected Thai/Chinese characters
// in responses that should be in a specific language.
func (m *QualityMonitor) unexpectedScriptCheck() QualityCheck {
	return QualityCheck{
		Name:        "unexpected_script",
		Description: "Detects unexpected Unicode scripts in output (Thai/Chinese in English responses)",
		Check: func(request, response string) *QualityViolation {
			expectedScript := detectDominantScript(request)
			if expectedScript == "Latin" {
				thaiCount := 0
				cjkCount := 0
				totalAlpha := 0
				for _, r := range response {
					if unicode.IsLetter(r) {
						totalAlpha++
						if unicode.Is(unicode.Thai, r) {
							thaiCount++
						}
						if unicode.Is(unicode.Han, r) || unicode.Is(unicode.Katakana, r) ||
							unicode.Is(unicode.Hiragana, r) {
							cjkCount++
						}
					}
				}
				if totalAlpha > 0 {
					foreignRatio := float64(thaiCount+cjkCount) / float64(totalAlpha)
					if foreignRatio > 0.01 { // more than 1% unexpected script characters
						return &QualityViolation{
							CheckName:   "unexpected_script",
							Severity:    "critical",
							Description: fmt.Sprintf("%.1f%% unexpected script chars in Latin response", foreignRatio*100),
							Details: map[string]any{
								"thai_chars":    thaiCount,
								"cjk_chars":     cjkCount,
								"total_alpha":   totalAlpha,
								"foreign_ratio": foreignRatio,
							},
						}
					}
				}
			}
			return nil
		},
	}
}

// languageMismatchCheck detects when the response language doesn't match
// the request language.
func (m *QualityMonitor) languageMismatchCheck() QualityCheck {
	return QualityCheck{
		Name:        "language_mismatch",
		Description: "Detects language mismatch between request and response",
		Check: func(request, response string) *QualityViolation {
			requestScript := detectDominantScript(request)
			responseScript := detectDominantScript(response)

			if requestScript != "" && responseScript != "" && requestScript != responseScript {
				return &QualityViolation{
					CheckName:   "language_mismatch",
					Severity:    "error",
					Description: fmt.Sprintf("Request in %s but response in %s", requestScript, responseScript),
					Details: map[string]any{
						"request_script":  requestScript,
						"response_script": responseScript,
					},
				}
			}
			return nil
		},
	}
}

// syntaxCorruptionCheck detects code responses with syntax errors that
// indicate corruption rather than model mistakes.
func (m *QualityMonitor) syntaxCorruptionCheck() QualityCheck {
	return QualityCheck{
		Name:        "syntax_corruption",
		Description: "Detects corruption patterns in code output",
		Check: func(request, response string) *QualityViolation {
			if !looksLikeCodeRequest(request) {
				return nil
			}
			// Detect corruption: random character insertions, broken UTF-8,
			// control characters in code
			controlCount := 0
			nullCount := 0
			for _, r := range response {
				if r == unicode.ReplacementChar {
					controlCount++
				}
				if r == 0 {
					nullCount++
				}
				// Unexpected control characters (not newline, tab, carriage return)
				if unicode.IsControl(r) && r != '\n' && r != '\t' && r != '\r' {
					controlCount++
				}
			}
			if controlCount > 0 || nullCount > 0 {
				return &QualityViolation{
					CheckName:   "syntax_corruption",
					Severity:    "critical",
					Description: "Corrupted characters detected in code output",
					Details: map[string]any{
						"control_chars":     controlCount,
						"null_chars":        nullCount,
						"response_length":   len(response),
					},
				}
			}
			return nil
		},
	}
}

// repetitionCheck detects excessive repetition indicating model degeneration.
func (m *QualityMonitor) repetitionCheck() QualityCheck {
	return QualityCheck{
		Name:        "excessive_repetition",
		Description: "Detects repetitive output indicating model degeneration",
		Check: func(request, response string) *QualityViolation {
			if len(response) < 200 {
				return nil
			}
			// Check for repeated n-grams
			words := strings.Fields(response)
			if len(words) < 20 {
				return nil
			}

			// Check trigram repetition rate
			trigrams := make(map[string]int)
			for i := 0; i+2 < len(words); i++ {
				tri := words[i] + " " + words[i+1] + " " + words[i+2]
				trigrams[tri]++
			}

			totalTrigrams := len(words) - 2
			repeatedCount := 0
			for _, count := range trigrams {
				if count > 3 { // same trigram appears 4+ times
					repeatedCount += count - 1
				}
			}

			repetitionRate := float64(repeatedCount) / float64(totalTrigrams)
			if repetitionRate > 0.3 { // more than 30% repetition
				return &QualityViolation{
					CheckName:   "excessive_repetition",
					Severity:    "error",
					Description: fmt.Sprintf("%.1f%% trigram repetition rate", repetitionRate*100),
					Details: map[string]any{
						"repetition_rate": repetitionRate,
						"total_trigrams":  totalTrigrams,
						"repeated":        repeatedCount,
					},
				}
			}
			return nil
		},
	}
}

// truncationCheck detects unexpectedly short responses.
func (m *QualityMonitor) truncationCheck() QualityCheck {
	return QualityCheck{
		Name:        "unexpected_truncation",
		Description: "Detects responses that are unexpectedly short for the request",
		Check: func(request, response string) *QualityViolation {
			// Heuristic: a detailed request should produce a substantial response
			if len(request) > 500 && len(response) < 50 {
				return &QualityViolation{
					CheckName:   "unexpected_truncation",
					Severity:    "warning",
					Description: "Response suspiciously short for detailed request",
					Details: map[string]any{
						"request_length":  len(request),
						"response_length": len(response),
						"ratio":           float64(len(response)) / float64(len(request)),
					},
				}
			}
			return nil
		},
	}
}

// coherenceCheck validates that responses are semantically coherent.
func (m *QualityMonitor) coherenceCheck() QualityCheck {
	return QualityCheck{
		Name:        "coherence",
		Description: "Detects incoherent output mixing unrelated content",
		Check: func(request, response string) *QualityViolation {
			// Simple heuristic: detect mid-sentence language/topic switches
			// that indicate routing errors or context corruption
			sentences := splitSentences(response)
			if len(sentences) < 3 {
				return nil
			}

			scriptChanges := 0
			prevScript := detectDominantScript(sentences[0])
			for _, s := range sentences[1:] {
				currentScript := detectDominantScript(s)
				if currentScript != "" && prevScript != "" && currentScript != prevScript {
					scriptChanges++
				}
				if currentScript != "" {
					prevScript = currentScript
				}
			}

			if scriptChanges > 2 {
				return &QualityViolation{
					CheckName:   "coherence",
					Severity:    "error",
					Description: fmt.Sprintf("Response switches scripts %d times - possible routing/corruption", scriptChanges),
					Details: map[string]any{
						"script_changes": scriptChanges,
						"sentences":      len(sentences),
					},
				}
			}
			return nil
		},
	}
}

// Helper functions

func detectDominantScript(text string) string {
	scripts := map[string]int{
		"Latin":   0,
		"CJK":     0,
		"Arabic":  0,
		"Thai":    0,
		"Cyrillic": 0,
	}

	for _, r := range text {
		if !unicode.IsLetter(r) {
			continue
		}
		switch {
		case unicode.Is(unicode.Latin, r):
			scripts["Latin"]++
		case unicode.Is(unicode.Han, r) || unicode.Is(unicode.Katakana, r) || unicode.Is(unicode.Hiragana, r):
			scripts["CJK"]++
		case unicode.Is(unicode.Arabic, r):
			scripts["Arabic"]++
		case unicode.Is(unicode.Thai, r):
			scripts["Thai"]++
		case unicode.Is(unicode.Cyrillic, r):
			scripts["Cyrillic"]++
		}
	}

	maxScript := ""
	maxCount := 0
	for script, count := range scripts {
		if count > maxCount {
			maxCount = count
			maxScript = script
		}
	}
	return maxScript
}

func looksLikeCodeRequest(request string) bool {
	codeKeywords := []string{
		"function", "code", "implement", "write", "program", "script",
		"class", "method", "algorithm", "\x60\x60\x60", "func ", "def ",
	}
	lower := strings.ToLower(request)
	for _, kw := range codeKeywords {
		if strings.Contains(lower, kw) {
			return true
		}
	}
	return false
}

func splitSentences(text string) []string {
	var sentences []string
	var current strings.Builder
	for _, r := range text {
		current.WriteRune(r)
		if r == '.' || r == '!' || r == '?' {
			s := strings.TrimSpace(current.String())
			if len(s) > 10 {
				sentences = append(sentences, s)
			}
			current.Reset()
		}
	}
	if remaining := strings.TrimSpace(current.String()); len(remaining) > 10 {
		sentences = append(sentences, remaining)
	}
	return sentences
}

// Ensure math import is used
var _ = math.Abs
```

### Key Lessons

**Lesson 1: Standard health checks miss quality degradation.** All three Anthropic bugs returned HTTP 200
responses. Latency metrics were normal. Error rates were near zero. The service appeared healthy by every
traditional metric while producing subtly or obviously wrong output. AI systems require output quality monitoring,
not just availability monitoring.

**Lesson 2: Low-rate bugs escalate.** Bug A started at 0.8% - a rate easily dismissed as noise. It escalated to
16% after a seemingly unrelated load balancer change. The lesson is that any anomaly, no matter how small, should
be investigated and understood. A 0.8% misrouting rate is not "acceptable noise" - it is a bug waiting to
compound.

**Lesson 3: Multiple overlapping bugs create diagnostic chaos.** Three bugs across different hardware platforms
(TPU, GPU, Trainium) produced different symptoms that appeared and disappeared unpredictably. Engineers chasing
one bug would find evidence that contradicted their hypothesis - because the other two bugs were also active.
This is why post-incident analysis must consider the possibility of multiple simultaneous failures.

**Lesson 4: Privacy controls can conflict with debugging.** Anthropic's privacy controls (appropriately)
restricted access to production traces, which slowed debugging. This is a real tension: you need observability
to diagnose bugs, but you also need privacy to protect user data. The solution is to build observability that
provides diagnostic signals without exposing user content - aggregate metrics, anonymized sampling, and synthetic
probe requests.

### Junior → FAANG: Output Quality Monitoring as a System Design Requirement

Standard health checks (HTTP 200, latency, error rate) are insufficient for AI and ML systems. The Anthropic incident demonstrates that a system can appear perfectly healthy by traditional metrics while producing subtly wrong output. When designing an AI system in a FAANG interview, always add a quality monitoring layer in addition to availability monitoring. The specific checks depend on the domain: language detection for multilingual models, repetition rate for generative models, confidence distribution for classifiers. The key is that you are monitoring the correctness of the output, not just the availability of the service.

### Senior @ FAANG: Multi-Bug Hypothesis as a Debugging Discipline

At L6, the three-overlapping-bugs scenario is a diagnostic discipline issue as much as a technical one. Post-mortems that are written after one bug is found often close too early, before the second and third bugs are discovered. The discipline of writing post-mortems that explicitly test the "are there other bugs?" hypothesis is a process improvement that staff engineers should advocate for in their org's incident review process. A post-mortem that closes with "we found one bug and fixed it" may be missing the other bugs that compounded it.

The privacy-versus-debuggability tension is a staff-level architectural decision. The correct resolution is not to weaken privacy controls during incidents but to design observability infrastructure that provides sufficient diagnostic signals without exposing user content. Synthetic probe requests (controlled inputs with known correct outputs) are particularly valuable: they give you an always-on quality signal without touching user data. This is an architectural decision that belongs in the system design doc before the service launches, not after the first incident.

---
