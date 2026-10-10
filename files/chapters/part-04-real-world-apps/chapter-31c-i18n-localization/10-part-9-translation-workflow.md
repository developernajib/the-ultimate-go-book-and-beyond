## Part 9: Translation Workflow

A reliable translation workflow starts with automated key extraction. The extractor below walks Go source files using the `go/ast` package, finds all calls to `.T()`, `.Tf()`, and `.Plural()`, and collects the string literal passed as the first argument. Running this tool in CI ensures that every new translation key in the codebase is detected and sent to translators before it reaches production untranslated. The output - a sorted list of keys - can be diffed against existing locale files to identify missing entries per language.

```go
// cmd/extract-keys/main.go
// Extracts all translation keys from Go source code for translator review

package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

func extractTranslationKeys(rootDir string) ([]string, error) {
	keySet := make(map[string]bool)
	fset := token.NewFileSet()

	err := filepath.Walk(rootDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(path, ".go") {
			return err
		}

		f, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			return nil // skip unparseable files
		}

		ast.Inspect(f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}

			// Find .T("key") and .Tf("key", ...) calls
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}

			if sel.Sel.Name != "T" && sel.Sel.Name != "Tf" && sel.Sel.Name != "Plural" {
				return true
			}

			if len(call.Args) == 0 {
				return true
			}

			lit, ok := call.Args[0].(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				return true
			}

			key := strings.Trim(lit.Value, `"`)
			keySet[key] = true

			return true
		})

		return nil
	})

	if err != nil {
		return nil, err
	}

	keys := make([]string, 0, len(keySet))
	for k := range keySet {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys, nil
}

// MissingKey represents a translation key missing in a specific locale.
type MissingKey struct {
	Key    string
	Locale string
}

// CheckMissingTranslations verifies all keys are present in all locale files.
// This function requires a project-local i18n.Bundle type (see earlier sections).
//
//	func CheckMissingTranslations(keys []string, bundle *i18n.Bundle) []MissingKey {
//	    var missing []MissingKey
//	    for _, key := range keys {
//	        for _, locale := range bundle.SupportedLocales() {
//	            if bundle.GetRaw(locale, key) == "" {
//	                missing = append(missing, MissingKey{Key: key, Locale: string(locale)})
//	            }
//	        }
//	    }
//	    return missing
//	}

func main() {
	keys, err := extractTranslationKeys(".")
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Found %d translation keys:\n", len(keys))
	for _, k := range keys {
		fmt.Println(" ", k)
	}
}
```

### Junior to FAANG: the translation workflow as a day-job

The workflow above looks simple. Extract keys. Diff against locale files. Flag missing keys. In practice, this is where a shipping team spends most of its i18n time, and where most localization programs fail silently.

The first reality is that keys are not extracted from literal strings alone. A call like `loc.T(buildKey(resource))` has a non-literal first argument. Your extractor misses it. Production extractors handle common patterns: string concatenation with constants, known helper functions, and variables defined in adjacent const blocks. They also miss everything else, and the compensation is a strict lint rule that rejects non-literal translation keys in new code. Legacy code that uses dynamic keys is grandfathered, documented, and migrated over time.

The second reality is the handoff to translators. Your CI detects a missing key. What happens next? If the answer is "someone files a ticket to the localization team and waits two weeks," your launch velocity will be gated on translation throughput. If the answer is "the CAT tool polls our repository hourly, detects the new key, assigns it to translators with SLA, and merges the translation back via a bot PR," your launch velocity is unaffected by translation. The goal is the second. The gap between them is multi-engineer-quarter work.

The third reality is translator context. A translator receiving just a key (`product.cart.checkout.button`) and a source string (`Checkout`) does not know whether this is a verb (the action of checking out) or a noun (the checkout page title). The translation may differ. Context must travel with the string: source file, surrounding strings, a screenshot if available, a comment from the engineer. CAT tools accept this metadata. Your extraction pipeline must emit it.

Worked example. An engineer adds a new string `account.password.reset.sent` with source `"Reset email sent to %s"` and a comment `// Shown after clicking 'Forgot password' and submitting a valid email`. The extractor captures the key, the source, the file path, the surrounding function name, and the adjacent comment. It serializes to XLIFF with all metadata. The CAT tool ingests. A German translator sees "Reset email sent to {0}" with the comment and translates it as "Rücksetz-E-Mail an {0} gesendet". The bot opens a PR with the German entry. CI validates placeholder parity. The PR auto-merges.

Interview framing. "Describe a translation workflow from engineer-writes-code to user-sees-translation." The answer walks through extraction, CAT tool integration, translation SLA, import validation, and deploy gating. Mention that your CI fails builds with missing launch-blocking translations and say "continuous localization" as a term. Mention pseudo-localization as a CI gate.

### Senior at FAANG: continuous localization as a platform investment

Continuous localization is the staff-level target. The pipeline runs on every PR, not on release branches. A string added to the codebase is in translators' queues within minutes. Translations land in the codebase within hours or days depending on urgency. The deploy is gated on translation completeness. No one on the product team is "blocked on localization" because the platform removes blocking.

The components of a continuous-localization platform: key extractor (AST-based, handles dynamic key patterns with a whitelist), metadata enricher (adds source file, surrounding context, design-system component name, screenshot URL), CAT tool connector (pushes new strings, pulls completed translations, reconciles keys that change or move), validation layer (placeholder parity, plural category completeness, pseudo-expansion budget, no injected script, no bidi override), bot automation (opens PRs, monitors CI, merges green), observability (translation coverage dashboard, SLA tracking per vendor, missing-key alerting in production), and fallback governance (who decides the interim copy when a translator is late).

The metadata enricher is the part most teams underinvest in. A CAT tool's output quality scales with the context a translator has. A screenshot showing where the string renders, the design-system component it belongs to, and a glossary that encodes product-specific terminology (your product's name for "feed" versus "stream," your brand voice for "we" versus formal "you") each remove a class of guessing, and localization vendors consistently rank missing context as the top cause of translation defects. The enrichment pipeline is where these signals are captured. Mature localization platforms capture UI screenshots automatically at build time for every string. The equivalent investment at your scale might be a browser extension that translators use to capture in-production context.

Translation memory as a platform asset compounds over time. Every string translated is leveraged against future similar strings. A 75 to 99 percent match reduces translator effort substantially. A 100 percent match is free. The platform decision is how aggressively to leverage TM across products. Full cross-product leveraging maximizes savings but risks semantic drift (the word "share" means different things in a social product and a file-sharing product). Segmented TM by semantic domain is the production compromise. Your ADR documents the segmentation.

Glossary and terminology management is a separate system. A glossary entry locks a term to a specific translation across all content. "Airbnb Plus" may remain as English across all locales (brand policy). "Privacy" must translate consistently across all locales (legal policy). "Host" has specific per-locale translations to avoid cultural mistranslations. The CAT tool enforces the glossary at translation time. CI validates that glossary-covered terms in source strings produce glossary-approved terms in translations. Glossary violations block merge.

Pseudo-localization in CI is the highest-ROI practice. Every build passes the English catalog through a transformer that: replaces ASCII with accented equivalents (`e` becomes `é`, `a` becomes `ä`), expands strings 30 to 40 percent by prefix and suffix padding, wraps with bracket sentinels, and optionally reverses direction for RTL readiness. A visual regression suite renders key flows in the pseudo-locale. Failures include text truncation, container overflow, sentinel bracket escaping (which means the layout broke out of its container), and misaligned components. This catches the bulk of layout-class localization bugs before a translator ever touches the string. The ROI pays back in one launch. Staff-level work owns the pseudo-locale generator, the visual regression harness, and the CI gating policy.

Launch-blocking translation policy is a governance item. Not every string is launch-blocking. Promotional copy may ship English-only for a soft launch. Navigation chrome is launch-blocking. Error messages are launch-blocking. Legal text is launch-blocking. Your catalog carries a priority tag per string (blocking, high, medium, low). CI fails builds with missing blocking translations in target locales. It warns on missing high-priority translations. It tolerates missing lower-priority translations. The policy is documented, reviewed quarterly, and visible in the translation dashboard.

Missing-key production handling is a separate tier. Despite all CI discipline, strings will slip through. A string added hotfix-style, a catalog import that fails silently, a new locale added without all keys covered. The production behavior is: log the missing key with locale and request correlation ID, emit a metric tagged with the key name, fall back to the English value, rate-limit the metric emission so a storm does not flood logs. Alert on missing-key rate above a threshold per locale. Target: less than 0.01 percent of requests emit a missing-key event, and when they do, the key is fixed within one business day.

Machine translation with human post-edit is the cost-reduction lever for 2026 and beyond. DeepL, Google Translate, and GPT-based translation engines produce good first drafts for most content. Human post-edit is faster than full translation, yielding cost savings of 40 to 70 percent on high-volume content. The trade-off: MT quality varies by language pair (excellent for major European languages, degraded for low-resource languages, poor for brand-specific terminology). Your platform decision is which content gets MT, which gets full human translation, and which hybridizes. Product marketing: full human. UI chrome: MT + post-edit. Help-center articles: MT only with human review on complaint. Document the tiers.

In-context translation is the quality-improvement lever. Translators working in a web-based CAT tool with live previews of their work in the actual product UI produce better translations than translators working in a spreadsheet. Smartling's Global Delivery Network captures context automatically. Lokalise and Phrase require screenshot uploads. Building a screenshot service that ties into your CAT tool is a two-quarter project with a measurable quality lift. Budget for it.

Vendor SLA and escalation is a procurement detail that becomes engineering's problem. A translation vendor with a 48-hour SLA for standard translations and 24-hour SLA for urgent work requires your platform to tag urgency and route accordingly. A vendor who misses SLA requires an escalation path (internal linguist bench, MT fallback, or delayed launch). Define the escalation. Practice it. A launch that fails because a vendor missed an SLA and no one had a runbook is a recoverable ops failure once, and a career-limiting pattern twice.

Translation metrics and dashboards close the loop. The metrics: per-locale coverage percentage (translated keys / total keys), per-locale freshness (age of oldest untranslated key), SLA adherence per vendor, pseudo-expansion budget compliance, missing-key rate in production, glossary violation rate, and translation-cost-per-word trend. Dashboards are visible to product, engineering, and localization ops jointly. Weekly review. Quarterly deep-dive. If the dashboard does not exist, the program is not mature.

---
