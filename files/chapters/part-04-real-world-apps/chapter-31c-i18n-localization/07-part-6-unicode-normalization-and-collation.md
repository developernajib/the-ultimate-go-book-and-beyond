## Part 6: Unicode, Normalization, and Collation

Unicode defines four normalization forms. Two are canonical, preserving visual and semantic equivalence: **NFC** (canonical composition) produces the shortest precomposed form and is the correct choice for storage, serialization, and display. **NFD** (canonical decomposition) splits composed characters into base + combining marks and is handy as an intermediate form when stripping accents. The other two are compatibility forms: **NFKC** and **NFKD** additionally fold compatibility-equivalent characters (e.g. full-width `Ａ` → `A`, ligature `ﬁ` → `fi`, superscript `²` → `2`). NFKC is the right normalization for identifier comparison, search matching, and spam/abuse detection because it collapses visually confusable variants. Never use NFKC for display because it destroys author-intended styling. Collation for locale-aware sorting uses `golang.org/x/text/collate`, which applies CLDR collation rules to order strings according to the locale's alphabet and case conventions rather than Unicode code point order. Normalization is performed at input boundaries (user submissions, external API responses) so the normalized form is stored once and all subsequent comparisons use plain byte equality.

```go
package unicode_util

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/cases"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"
	"golang.org/x/text/runes"
	"golang.org/x/text/transform"
	"golang.org/x/text/unicode/norm"
)

// Normalizer normalizes Unicode strings for comparison and storage
type Normalizer struct{}

// NFC normalizes to NFC (Canonical Decomposition + Canonical Composition)
// Use for storage and display
func (n *Normalizer) NFC(s string) string {
	return norm.NFC.String(s)
}

// NFD normalizes to NFD (Canonical Decomposition)
// Useful as an intermediate step when stripping accents for search.
func (n *Normalizer) NFD(s string) string {
	return norm.NFD.String(s)
}

// NFKC normalizes to NFKC (Compatibility Composition).
// Use for identifier comparison, abuse detection, and search matching,
// where full-width, small-form, and ligature variants must collapse to
// their base ASCII/Latin equivalents. Do NOT use for display.
func (n *Normalizer) NFKC(s string) string {
	return norm.NFKC.String(s)
}

// RemoveAccents removes diacritical marks (accents)
// "café" → "cafe", "über" → "uber", "naïve" → "naive"
func RemoveAccents(s string) string {
	t := transform.Chain(norm.NFD, runes.Remove(runes.In(unicode.Mn)), norm.NFC)
	result, _, _ := transform.String(t, s)
	return result
}

// FoldCase performs Unicode-aware, locale-sensitive case folding for
// equality comparisons. Prefer this over strings.ToLower, which does NOT
// handle Turkish dotted/dotless I (i <-> I vs i <-> İ) correctly and
// can silently corrupt case comparisons for Turkish, Azeri, and
// Lithuanian text.
//
//   import "golang.org/x/text/cases"
//   import "golang.org/x/text/language"
//
//   var trFold = cases.Fold(cases.HandleFinalSigma(false))
//   var trLower = cases.Lower(language.Turkish)
func FoldCase(s string) string {
	return cases.Fold().String(s)
}

// NormalizeForSearch applies all normalizations for search indexing
func NormalizeForSearch(s string) string {
	s = norm.NFC.String(s)
	s = RemoveAccents(s)
	s = strings.ToLower(s)
	return s
}

// Collator provides locale-aware string comparison
type Collator struct {
	col *collate.Collator
}

func NewCollator(locale string) *Collator {
	tag, _ := language.Parse(locale)
	return &Collator{
		col: collate.New(tag, collate.IgnoreCase, collate.IgnoreDiacritics),
	}
}

// Compare compares two strings according to locale rules
// Returns negative if a < b, 0 if equal, positive if a > b
func (c *Collator) Compare(a, b string) int {
	return c.col.CompareString(a, b)
}

// Sort sorts strings according to locale collation rules
func (c *Collator) Sort(strs []string) {
	c.col.SortStrings(strs)
}

// IsValidUTF8 checks if a string is valid UTF-8
func IsValidUTF8(s string) bool {
	return utf8.ValidString(s)
}

// TruncateByRune truncates a string to n runes (not bytes)
// Safe for multibyte characters
func TruncateByRune(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n]) + "…"
}

// RuneLength returns the number of characters (not bytes)
func RuneLength(s string) int {
	return utf8.RuneCountInString(s)
}

// ByteLength returns the number of bytes (important for database columns)
func ByteLength(s string) int {
	return len(s)
}

// Example: Japanese text
// "こんにちは世界" → 7 runes, 21 bytes (3 bytes each in UTF-8)

// SortByLocale sorts a slice of structs by a string field using locale collation
func SortStringsByLocale(strs []string, locale string) []string {
	result := make([]string, len(strs))
	copy(result, strs)
	collator := NewCollator(locale)
	collator.Sort(result)
	return result
}
```

### Junior to FAANG: why your user lookups sometimes fail

The first time Unicode normalization bites you, a user will complain they cannot log in. You will check the database, find their email exactly as typed. You will check the login form, find the submitted email exactly as typed. They will look identical on the screen. They will not be equal byte-for-byte. This is normalization drift. The email was stored in NFC on registration (because your server normalized) and submitted in NFD on login (because the macOS client produced NFD). The bytes differ. The equality check fails.

The fix is to normalize at every input boundary to the same form. Pick NFC. Apply it in middleware before any equality check. Apply it before database writes. Apply it to incoming API payloads. After this discipline, all comparisons can be byte equality. Never compare raw user input.

The second surprise is case folding. `strings.ToLower` does the wrong thing in Turkish. In Turkish, `I` lowercases to `ı` (dotless i), not `i`. And `İ` (capital I with a dot) lowercases to `i`. If you implement a username uniqueness check with `strings.ToLower` and your user base includes Turkish speakers, you will create collisions and miss collisions simultaneously. Use `cases.Fold()` for equality and `cases.Lower(language.Turkish)` for display to Turkish users. The same issue affects Azeri and to a lesser extent Lithuanian.

Worked example. Your user registration accepts the username `Istanbul`. Your duplicate check lowercases to `istanbul` and stores. Later, a Turkish user registers `İstanbul` (with the dot on the capital I). Your check lowercases with the default (non-Turkish) rules to `i̇stanbul` (with a combining dot). The stored value is `istanbul`. The check says "not a duplicate" and creates a new account. Now you have two accounts with visually indistinguishable usernames. The correct approach is `cases.Fold()` which produces a canonical form that treats both variants as equal, combined with NFC normalization on the input.

Interview framing. "What is Unicode normalization and why do you care." The answer names NFC and NFD as the canonical forms (visually equivalent), NFKC and NFKD as compatibility forms (visually distinct but semantically related), and the policy of normalizing at input boundaries. The senior-adjacent follow-up is "when would you use NFKC" and the answer is identifier matching, search, and abuse detection. Never for display.

### Senior at FAANG: normalization and collation as security and correctness concerns

NFKC with case folding (`nfkc_cf` in ICU terminology, often called `nfkc_casefold`) is the correct normalization for identifier equality when the identifier has a security or uniqueness guarantee. Usernames, email local parts (with caveats), subdomain names, and any namespace that must prevent impersonation need NFKC with case folding applied at comparison time. This collapses full-width ASCII (`ｇｏｏｇｌｅ` maps to `google`), compatibility ligatures (`ﬁ` maps to `fi`), superscript and subscript digits (`²` maps to `2`), and case variants into a single canonical form. A malicious user registering `ｇｏｏｇｌｅ.com` as a subdomain on a platform that does not normalize will successfully impersonate `google.com` in any UI that does not also normalize.

The equivalent primitive in Go is `precis.UsernameCaseMapped.String(s)` from `golang.org/x/text/secure/precis`, which implements RFC 8265 for username comparison and RFC 8266 for free-form strings. Use PRECIS for security-relevant identifiers. Use raw NFC for free-form display content. Use NFKC with case folding only when you consciously want to collapse visually confusable variants, because NFKC destroys author-intended formatting.

Mixed-script detection is the companion to NFKC for abuse prevention. A username mixing Latin and Cyrillic scripts (like `gооgle` where the two `о` characters are Cyrillic `U+043E`) looks identical to `google` but encodes differently. NFKC does not collapse these because they are distinct code points with distinct semantic identity. You must run a mixed-script check on top of normalization. `golang.org/x/text/unicode/rangetable` and the IDNA2008 rules in `golang.org/x/net/idna` give you primitives. Major platforms (Google, Twitter, Cloudflare) apply confusable-detection policies on registration of security-sensitive identifiers. The ICU `UScriptCode` and `uspoof_*` APIs are the ground truth but not natively available in Go. Staff-level work is building or vendoring a confusable detector calibrated to your policy.

Collation tailoring per locale is deeper than "sort strings." CLDR defines collation tables per locale with tailoring rules that override the default Unicode Collation Algorithm (UCA) ordering. Turkish tailoring makes `i` and `ı` (dotless) distinct letters, sorting in their own positions. German has two tailorings: dictionary order (`ä` sorts as `a`, `ß` as `ss`) and phonebook order (`ä` sorts between `a` and `b`). Spanish historically treated `ch` and `ll` as distinct letters until 1994. Swedish sorts `å`, `ä`, `ö` at the end of the alphabet, not between `a` and `b`. Chinese sorts by stroke count, pinyin, or radical depending on use case. Your sort function takes a locale and a tailoring variant, not just a list of strings.

`golang.org/x/text/collate` implements UCA with CLDR tailorings. Turn off case and diacritic sensitivity for case-insensitive search (`collate.IgnoreCase`, `collate.IgnoreDiacritics`). Turn them on for display-order sorting. Internally, UCA compares at four levels: Level 1 (primary) ignores case and diacritics, Level 2 (secondary) considers diacritics, Level 3 (tertiary) considers case, Level 4 (quaternary) considers punctuation. In `x/text/collate` you select this behavior through the option variables (`IgnoreCase`, `IgnoreDiacritics`, `IgnoreWidth`) rather than a named level constant: drop to primary-only for user-facing search, keep case and diacritics for exact comparisons.

UTF-8 validation cost at the edge is a performance concern at high QPS. Every incoming string from an untrusted source should be validated, but `utf8.ValidString` is a linear scan. At 100k QPS with average payload size 4KB, that is 400 MB/s of UTF-8 validation work per server. Profile this. If it is a meaningful share of CPU, batch validation per request (once on ingress, not per field) and skip re-validation downstream. The worst-case bug is trusting incoming strings without validation and getting a multi-byte sequence split across a buffer boundary, which corrupts the output and may be exploitable depending on the downstream consumer.

Filename and path normalization is a cross-platform landmine. macOS historically stored filenames in NFD on HFS+, which was surfaced to userspace in NFD. APFS (since 2017) normalizes transparently but preserves the stored form in `readdir`. Linux ext4 and NTFS pass bytes through unchanged. A macOS user uploading a file named `café.pdf` to your Linux server stores NFD. The same user downloading the file back expects the same name. If your server re-encodes to NFC on any round trip, the downloaded file has a different byte representation than the original, and file-integrity checksums fail. Decide: normalize at ingress or preserve exactly. Document it.

Database collation settings often surprise engineers migrating to i18n. PostgreSQL defaults to locale-sensitive collation based on the database's `LC_COLLATE`. MySQL uses per-column collation (commonly `utf8mb4_unicode_ci` or `utf8mb4_0900_ai_ci`). SQLite uses binary comparison by default. If your database is configured with a Turkish collation, queries like `WHERE username = 'Istanbul'` can match `istanbul`, `İstanbul`, and `ıstanbul` unpredictably. Pick explicit binary collation for identifier columns. Pick locale-aware collation only for display-sorted columns. Index behavior depends on collation, so the decision affects query plans.

Search across locales requires per-language analyzers. Elasticsearch with the ICU analyzer plugin tokenizes and normalizes correctly per language. A German search index tokenizes compound words. A Japanese index tokenizes with Kuromoji or a similar morphological analyzer. A Chinese index uses ICU segmentation. Your indexing layer knows the language of each document and picks the analyzer accordingly. Query analyzers must match index analyzers. Cross-language search (one query matching documents in multiple languages) needs either per-language indexes with federated query or a multilingual embedding model. The latter is increasingly common in 2026 with multilingual sentence-transformer models served via vector search.

Email local-part normalization is a specific trap. RFC 5321 says the local part is case-sensitive, but in practice providers like Gmail treat it as case-insensitive and ignore dots. If you store email addresses verbatim and compare byte-for-byte, you will create duplicate accounts when the same user registers with `John.Doe@gmail.com` and `johndoe@gmail.com`. The policy decision is provider-specific: normalize Gmail addresses by lowercasing and removing dots, normalize other providers by lowercasing only, preserve the original form for display and outgoing mail. This is an abuse-prevention item as well, because case and dot variation is used in account-creation fraud.

---
