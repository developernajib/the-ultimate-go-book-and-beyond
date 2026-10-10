## Part 10: Advanced Pluralization & Gender Rules

Pluralization is one of the most under-engineered areas of i18n. English has two plural forms (one/other), but Arabic has six, Russian has four, Polish has four, and Japanese has one. The CLDR (Common Locale Data Repository) defines these exhaustively. Getting it wrong means "1 items left" or "21 файлов" instead of "21 файл" in Russian - a clear signal that the product was not built with care.

### CLDR Plural Categories

CLDR defines six plural categories:

| Category | Typical usage |
|----------|--------------|
| `zero` | Languages like Arabic that have a special zero form |
| `one` | Singular in English. Applies to more numbers in other languages |
| `two` | Languages like Arabic/Welsh with a dual form |
| `few` | Slavic languages: 2-4 in Russian/Polish |
| `many` | Arabic 11-99. Polish genitive plural |
| `other` | The catch-all / default form |

English uses only `one` and `other`. Arabic uses all six. Russian uses `one`, `few`, `many`, and `other`. This is why a lookup table of `{1: "singular", N: "plural"}` is insufficient.

### Implementing a CLDR Plural Engine in Go

The implementation below uses `golang.org/x/text/feature/plural` to evaluate CLDR rules at runtime. The `PluralForms` struct holds a template string for each of the six categories, and `selectForm` calls `plural.Cardinal.MatchPlural` to determine which form applies for a given count and locale. If a locale's catalog omits a category (e.g., English has no `few` form), the code falls back to `other`.

```go
package plural

import (
	"strconv"
	"strings"

	"golang.org/x/text/feature/plural"
	"golang.org/x/text/language"
	_ "golang.org/x/text/message"
	_ "golang.org/x/text/message/catalog"
)

// PluralForms holds all six CLDR plural forms for a single message key.
type PluralForms struct {
	Zero  string
	One   string
	Two   string
	Few   string
	Many  string
	Other string
}

// pluralData maps locale tags to their message catalogs.
var pluralData = map[language.Tag]map[string]PluralForms{
	language.English: {
		"items": {
			One:   "{{.Count}} item",
			Other: "{{.Count}} items",
		},
		"files_deleted": {
			One:   "{{.Count}} file deleted",
			Other: "{{.Count}} files deleted",
		},
	},
	language.Russian: {
		"items": {
			One:  "{{.Count}} элемент",  // 1, 21, 31 ...
			Few:  "{{.Count}} элемента", // 2-4, 22-24 ...
			Many: "{{.Count}} элементов", // 5-20, 11-19, 25-30 ...
		},
		"files_deleted": {
			One:  "{{.Count}} файл удалён",
			Few:  "{{.Count}} файла удалено",
			Many: "{{.Count}} файлов удалено",
		},
	},
	language.Arabic: {
		"items": {
			Zero:  "لا عناصر",
			One:   "عنصر واحد",
			Two:   "عنصران",
			Few:   "{{.Count}} عناصر",   // 3-10
			Many:  "{{.Count}} عنصراً",  // 11-99
			Other: "{{.Count}} عنصر",    // 100+
		},
	},
}

// Localizer uses golang.org/x/text/feature/plural for rule evaluation.
type Localizer struct {
	tag  language.Tag
	data map[string]PluralForms
}

// NewLocalizer creates a Localizer for the given locale tag.
func NewLocalizer(tag language.Tag) *Localizer {
	forms, ok := pluralData[tag]
	if !ok {
		// Fallback to English
		forms = pluralData[language.English]
	}
	return &Localizer{tag: tag, data: forms}
}

// selectForm picks the correct CLDR plural form string for a count.
func (l *Localizer) selectForm(count int, forms PluralForms) string {
	// golang.org/x/text/feature/plural provides Form() which evaluates
	// CLDR rules for the registered language tag.
	form := plural.Cardinal.MatchPlural(l.tag, count, 0, 0, 0, 0)

	switch form {
	case plural.Zero:
		if forms.Zero != "" {
			return forms.Zero
		}
	case plural.One:
		if forms.One != "" {
			return forms.One
		}
	case plural.Two:
		if forms.Two != "" {
			return forms.Two
		}
	case plural.Few:
		if forms.Few != "" {
			return forms.Few
		}
	case plural.Many:
		if forms.Many != "" {
			return forms.Many
		}
	}
	return forms.Other
}

// Pluralize returns the localized plural string for key with count.
func (l *Localizer) Pluralize(key string, count int) string {
	forms, ok := l.data[key]
	if !ok {
		return key // Fallback to key itself
	}
	template := l.selectForm(count, forms)
	return applyCount(template, count)
}

// applyCount replaces {{.Count}} with the actual number.
func applyCount(template string, count int) string {
	return strings.ReplaceAll(template, "{{.Count}}", strconv.Itoa(count))
}
```

```go
// Usage example
func ExamplePluralizer() {
	en := NewLocalizer(language.English)
	ru := NewLocalizer(language.Russian)
	ar := NewLocalizer(language.Arabic)

	counts := []int{0, 1, 2, 5, 11, 21, 100}
	for _, n := range counts {
		fmt.Printf("EN: %s\n", en.Pluralize("items", n))
		fmt.Printf("RU: %s\n", ru.Pluralize("items", n))
		fmt.Printf("AR: %s\n", ar.Pluralize("items", n))
		fmt.Println()
	}
	// EN: 0 items
	// RU: 0 элементов
	// AR: لا عناصر

	// EN: 1 item
	// RU: 1 элемент
	// AR: عنصر واحد

	// EN: 2 items
	// RU: 2 элемента
	// AR: عنصران

	// EN: 5 items
	// RU: 5 элементов
	// AR: 5 عناصر
}
```

### Polish: Four-Form Plural (A Common Edge Case)

Polish is a frequent stumbling block. The rules for Polish nouns are:
- `one`: n == 1
- `few`: n % 10 in 2..4 AND n % 100 NOT in 12..14
- `many`: n % 10 == 0 OR n % 10 == 1 (and n != 1) OR n % 10 in 5..9 OR n % 100 in 12..14
- `other`: everything else

```go
// Polish plural rule implemented manually (for illustration of complexity)
func polishPluralForm(n int) string {
	if n == 1 {
		return "one"
	}
	mod10 := n % 10
	mod100 := n % 100
	if mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20) {
		return "few"
	}
	return "many"
}

// Test cases
// 1  → one  → "1 plik"
// 2  → few  → "2 pliki"
// 5  → many → "5 plików"
// 12 → many → "12 plików"
// 22 → few  → "22 pliki"
// 25 → many → "25 plików"
```

### Gender-Sensitive Translations in Go

Some languages inflect nouns, adjectives, and verbs based on grammatical gender. French, Spanish, German, Russian, and Arabic all require this. The pattern is to use separate message keys per gender or embed gender as a placeholder.

```go
package gender

import "fmt"

// Gender represents grammatical gender.
type Gender int

const (
	GenderMasculine Gender = iota
	GenderFeminine
	GenderNeuter
	GenderUnknown
)

// GenderedForms holds masculine/feminine/neuter variants.
type GenderedForms struct {
	Masculine string
	Feminine  string
	Neuter    string
}

// French example: "le nouveau utilizateur" vs "la nouvelle utilizatrice"
var frenchWelcome = GenderedForms{
	Masculine: "Bienvenu, {{.Name}} !",
	Feminine:  "Bienvenue, {{.Name}} !",
}

// Russian example: verb agreement changes with subject gender
var russianLoggedIn = GenderedForms{
	Masculine: "{{.Name}} вошёл в систему",
	Feminine:  "{{.Name}} вошла в систему",
}

type GenderLocalizer struct {
	forms map[string]GenderedForms
}

func NewGenderLocalizer() *GenderLocalizer {
	return &GenderLocalizer{
		forms: map[string]GenderedForms{
			"welcome":   frenchWelcome,
			"logged_in": russianLoggedIn,
		},
	}
}

func (g *GenderLocalizer) Translate(key, name string, gender Gender) string {
	forms, ok := g.forms[key]
	if !ok {
		return key
	}
	var template string
	switch gender {
	case GenderFeminine:
		template = forms.Feminine
	case GenderNeuter:
		if forms.Neuter != "" {
			template = forms.Neuter
		} else {
			template = forms.Masculine // fallback
		}
	default:
		template = forms.Masculine
	}
	return strings.ReplaceAll(template, "{{.Name}}", name)
}

func ExampleGender() {
	loc := NewGenderLocalizer()
	fmt.Println(loc.Translate("welcome", "Marie", GenderFeminine))
	// Bienvenue, Marie !
	fmt.Println(loc.Translate("welcome", "Pierre", GenderMasculine))
	// Bienvenu, Pierre !
}
```

### Ordinal Numbers

Ordinal numbers (1st, 2nd, 3rd, 4th…) follow language-specific rules entirely different from cardinal plurals.

```go
package ordinal

import (
	"fmt"
	"golang.org/x/text/feature/plural"
	"golang.org/x/text/language"
)

// OrdinalSuffix returns the English ordinal suffix for n.
func OrdinalSuffix(n int) string {
	// Special case: 11th, 12th, 13th
	mod100 := n % 100
	if mod100 >= 11 && mod100 <= 13 {
		return "th"
	}
	switch n % 10 {
	case 1:
		return "st"
	case 2:
		return "nd"
	case 3:
		return "rd"
	default:
		return "th"
	}
}

// FormatEnglishOrdinal formats an English ordinal: 1st, 2nd, 3rd, 4th...
func FormatEnglishOrdinal(n int) string {
	return fmt.Sprintf("%d%s", n, OrdinalSuffix(n))
}

// FormatFrenchOrdinal formats a French ordinal: 1er, 2ème, 3ème...
func FormatFrenchOrdinal(n int) string {
	if n == 1 {
		return "1er"
	}
	return fmt.Sprintf("%dème", n)
}

// OrdinalFormatter dispatches to the correct locale implementation.
type OrdinalFormatter func(n int) string

var ordinalFormatters = map[language.Tag]OrdinalFormatter{
	language.English: FormatEnglishOrdinal,
	language.French:  FormatFrenchOrdinal,
	// Spanish: 1.º, 2.º, 3.º
	language.Spanish: func(n int) string { return fmt.Sprintf("%d.º", n) },
}

func FormatOrdinal(tag language.Tag, n int) string {
	if fn, ok := ordinalFormatters[tag]; ok {
		return fn(n)
	}
	// Default: plain number
	return fmt.Sprintf("%d.", n)
}

func ExampleOrdinals() {
	for _, n := range []int{1, 2, 3, 4, 11, 12, 13, 21, 22} {
		fmt.Printf("EN: %-5s  FR: %-6s  ES: %s\n",
			FormatOrdinal(language.English, n),
			FormatOrdinal(language.French, n),
			FormatOrdinal(language.Spanish, n),
		)
	}
	// EN: 1st    FR: 1er    ES: 1.º
	// EN: 2nd    FR: 2ème   ES: 2.º
	// EN: 3rd    FR: 3ème   ES: 3.º
	// EN: 4th    FR: 4ème   ES: 4.º
	// EN: 11th   FR: 11ème  ES: 11.º
}
```

### Junior to FAANG: CLDR categories are not what your intuition says

The first thing to internalize: CLDR category names are labels, not meanings. `one` does not mean "the number one." In English, `one` matches the count `1`. In French, `one` matches both `0` and `1` (zero is treated grammatically as singular). In Filipino, `one` matches `1`, `2`, and `3`. The label `one` means "the first plural category as defined by CLDR for this locale." Reading more into the name is the source of most plural bugs.

Second, the categories a locale uses are a function of the locale. Japanese uses only `other`. English uses `one` and `other`. Russian uses `one`, `few`, `many`, `other`. Arabic uses all six. You cannot ship a catalog without knowing per-locale which categories are required. The category names are stable across CLDR versions, but the rules that select them can change.

Worked example. The string "5 new messages" in English maps to `items.other` with count 5. In Russian, the rule for count 5 selects `many`, mapping to `items.many`. In Arabic, the rule for count 5 selects `few`, mapping to `items.few`. Same count, three different categories, three distinct catalog entries required. Your UI shows the correct grammatical form in each locale.

Interview framing. "How does Russian pluralize." The expected answer: Russian has four categories, the rule considers `count mod 10` and `count mod 100`, `one` matches 1 21 31 excluding teens, `few` matches 2 3 4 22 23 24 excluding teens, `many` matches everything else. Name `golang.org/x/text/feature/plural.Cardinal.MatchPlural` as the implementation. If you try to recite the rule from memory you will miss an edge case. The correct answer is "delegate to CLDR, never hand-roll."

Gender and ordinals are separate concerns from cardinal plurals. Gender is a property of the subject or the translated object, not of the count. Ordinals have their own CLDR ruleset (`plural.Ordinal`, not `plural.Cardinal`). Confusing the three is a common beginner mistake.

### Senior at FAANG: pluralization, gender, and the selector explosion

Real messages combine plural, gender, and sometimes additional selectors. A message like "John sent Mary 3 photos" has variables: sender name, sender gender, recipient name, recipient gender, photo count. Translators in some languages need all five to produce a grammatically correct sentence. ICU MessageFormat 1 supports nested selectors (a `plural` inside a `select` inside another `select`), but the nesting is syntactically painful and difficult for translators to edit without breaking. MessageFormat 2, which reached Stable status in 2025 (CLDR 47), replaces nested selectors with a matrix-style `.match` block that treats all selectors as peers. This is a significant authoring improvement.

The platform-level concern is selector explosion. A message with two gender selectors and one plural selector in Russian expands to roughly `2 * 2 * 4 = 16` variants. In Arabic it expands to `2 * 2 * 6 = 24`. Translators face every variant. Your platform either supports this with MF2 matrix syntax or imposes a copy policy that limits selector depth (e.g., "no message has more than one plural plus one gender selector"). Staff-level ADRs on this boundary save translation cost and reduce translator errors.

Gender-inflected content is harder than it looks because gender is a property of the referent, not only of the string. "Your friend" needs a gender in many languages. If the friend's gender is unknown, you need a gender-neutral form. Gender-neutral is often grammatically awkward. Some languages (Spanish, French) have seen increasing use of neopronouns and gender-neutral pluralization that is not standardized in CLDR. Your platform decision: which neutral forms to support, which to avoid as still-contested, how to handle unknown-gender users without grammatical errors. This is a product policy call, not a technical one, but it lands on the i18n platform.

Polish and Slovak four-form plurals are the canonical stress test. Polish rules involve both `count mod 10` and `count mod 100` with exceptions for teens. A naive implementation produces `22 pliki` (correct, `few`) and `12 plików` (correct, `many`) but will fail on edge cases like `122` (should be `few` per rule). Always delegate to CLDR. If you are forced to hand-roll (for an embedded system or a constrained environment), fuzz-test against `plural.Cardinal.MatchPlural` with 10,000 randomly generated counts.

Fractional and operand-sensitive plurals are the depth beyond simple integer counts. CLDR plural rules have six operands: `n` (absolute value), `i` (integer digits), `v` (visible fraction digits), `w` (visible fraction digits without trailing zeros), `f` (value of fraction digits), `t` (value of fraction digits without trailing zeros). For `1.0`, the rule can select differently than for `1`. This matters for expressions like "1.0 hour" versus "1 hour." The `plural.Cardinal.MatchPlural` signature takes five of these operands (`i, v, w, f, t`) - `n` is derived from them internally. The wrapper code in the example above passes zeros for `v, w, f, t`, which is fine for integer counts but wrong for fractional. If you format fractional quantities (currency, distance, temperature), pass the real operands.

Ordinal rules are a different ruleset. English ordinals use `one` for `1st` and `21st`, `two` for `2nd` and `22nd`, `few` for `3rd` and `23rd`, `other` for `4th` through `20th` and `24th` onward. The logic handles the `11th`, `12th`, `13th` exception. French uses `one` only for `1er` and `other` for everything else (`2ème`, `3ème`). `plural.Ordinal.MatchPlural` implements the full ruleset. Never use cardinal rules for ordinals.

Collective nouns and uncountables are a class of strings plural rules cannot fix. "Milk" is uncountable in English. "Water" is uncountable. "Information" is uncountable in English, countable in French (`information` plural `informations`). A count-less message like "Water is cold" has no plural selector. A message like "2 liters of milk" has a plural on the unit, not on the substance. Translators handle this per language, but your catalog must not force a plural selector on strings that do not vary by count.

Gender-aware personal-name formatting is a CLDR feature stabilized in CLDR 43 and later. `PersonName` formatting takes a structured name (given, family, honorific, informal, formal) and produces a locale-appropriate display. Japanese swaps order (family given), uses honorific suffixes (`-san`, `-sama`) contextually. Hungarian puts family before given. Spanish can use two family names. ICU `PersonName.Formatter` exposes this. Go does not yet have a native equivalent. For production name formatting, either vendor ICU via CGO or implement a subset from CLDR data. This is staff-level infrastructure, not a feature every product needs.

MF2 MessageFormat for plural and gender combines selectors in a flat block. A single `.match` on `$count` and `$gender` produces a table of variants. Translators edit the table, not nested braces. The translation memory model is cleaner because each variant is a translation unit. The catalog format is human-readable. Migration from MF1 to MF2 for plural-and-gender messages is one of the highest-ROI migration targets: the translator quality lift is immediate, and the bugs that happen when a translator edits MF1's nested braces incorrectly disappear.

Testing plural and gender coverage requires generated test cases. Your test framework enumerates every locale and every message with plural or gender selectors. For each, it generates a test case per CLDR category and per gender form. The assertion is that the resolved message is not the key itself (missing translation) and that the placeholder substitution produces a well-formed string. This catches both incomplete catalogs and broken placeholder syntax. Property-based testing over random counts and genders is the extension that catches edge cases the enumeration misses.

---
