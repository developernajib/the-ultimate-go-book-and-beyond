## Part 12: Locale-Aware Data Formatting - Production Patterns

### Number Formatting: Decimal Separators and Grouping

Different locales use different separators:

| Locale | Example | Decimal sep | Grouping sep |
|--------|---------|-------------|--------------|
| en-US | 1,234,567.89 | `.` | `,` |
| de-DE | 1.234.567,89 | `,` | `.` |
| fr-FR | 1 234 567,89 | `,` | ` ` (narrow no-break space) |
| hi-IN | 12,34,567.89 | `.` | `,` (South Asian grouping) |
| de-CH | 1'234'567.89 | `.` | `'` |

The `golang.org/x/text/number` package handles these differences automatically when used through a locale-specific `message.Printer`. Pass `number.Decimal` to the printer and it applies the correct separators for the locale. The functions below wrap this pattern for common use cases.

```go
package formatting

import (
	"fmt"

	"golang.org/x/text/language"
	"golang.org/x/text/message"
	"golang.org/x/text/number"
)

// FormatNumber formats a float64 according to the locale's number conventions.
func FormatNumber(tag language.Tag, value float64, decimals int) string {
	p := message.NewPrinter(tag)
	format := fmt.Sprintf("%%.%df", decimals)
	return p.Sprintf(format, number.Decimal(value))
}

// FormatInteger formats an integer with locale-appropriate grouping separators.
func FormatInteger(tag language.Tag, value int64) string {
	p := message.NewPrinter(tag)
	return p.Sprintf("%d", number.Decimal(value))
}

// FormatPercent formats a ratio (0.0-1.0) as a percentage.
func FormatPercent(tag language.Tag, ratio float64) string {
	p := message.NewPrinter(tag)
	return p.Sprintf("%v", number.Percent(ratio))
}

func ExampleNumbers() {
	locales := []language.Tag{
		language.English,
		language.German,
		language.French,
		language.Hindi,
	}
	for _, tag := range locales {
		fmt.Printf("%-10s %s\n", tag, FormatNumber(tag, 1234567.89, 2))
	}
	// en         1,234,567.89
	// de         1.234.567,89
	// fr         1 234 567,89
	// hi         12,34,567.89
}
```

### Currency Display: Symbol, ISO Code, and Placement

Currency display varies in three dimensions: the symbol used, whether it appears before or after the amount, and spacing.

```go
package formatting

import (
	"fmt"

	"golang.org/x/text/currency"
	"golang.org/x/text/language"
	"golang.org/x/text/message"
)

// CurrencyDisplayMode controls how currency is rendered.
type CurrencyDisplayMode int

const (
	CurrencySymbol  CurrencyDisplayMode = iota // $, €, £
	CurrencyISOCode                            // USD, EUR, GBP
	CurrencyName                               // US Dollar, Euro, British Pound
)

// FormatCurrencyAmount formats an amount (in minor units, e.g., cents) for display.
// amount is in the currency's minor unit (cents for USD, pence for GBP, fils for AED).
func FormatCurrencyAmount(tag language.Tag, cur currency.Unit, minorUnits int64) string {
	p := message.NewPrinter(tag)
	scale, _ := currency.Cash.Rounding(cur)
	divisor := intPow(10, scale)
	major := float64(minorUnits) / float64(divisor)
	return p.Sprintf("%v", currency.Symbol(cur.Amount(major)))
}

// intPow computes base^exp for small non-negative exponents.
func intPow(base, exp int) int {
	result := 1
	for i := 0; i < exp; i++ {
		result *= base
	}
	return result
}

func ExampleCurrency() {
	amount := int64(123456) // 1234.56 in minor units

	type example struct {
		tag language.Tag
		cur currency.Unit
	}
	examples := []example{
		{language.English, currency.USD},
		{language.German, currency.EUR},
		{language.Arabic, currency.AED},
		{language.Japanese, currency.JPY},
		{language.Hindi, currency.INR},
	}
	for _, ex := range examples {
		fmt.Printf("%-10s: %s\n", ex.tag, FormatCurrencyAmount(ex.tag, ex.cur, amount))
	}
	// en         : $1,234.56
	// de         : 1.234,56 €
	// ar         : ١٬٢٣٤٫٥٦ د.إ.‏
	// ja         : ¥123,456
	// hi         : ₹1,234.56
}
```

### Date and Time Formatting Across Locales

Date formats are a common source of ambiguity (is 01/02/03 January 2nd or February 1st?). The correct approach is always locale-driven formatting.

```go
package formatting

import (
	"fmt"
	"time"

	"golang.org/x/text/language"
	"golang.org/x/text/message"
)

// dateFormats maps locale tags to Go time layout strings.
// These follow each locale's conventional date ordering.
var dateFormats = map[language.Tag]struct {
	ShortDate  string
	LongDate   string
	DateTime   string
	TimeOnly   string
}{
	language.AmericanEnglish: {
		ShortDate: "01/02/2006",            // MM/DD/YYYY
		LongDate:  "January 2, 2006",
		DateTime:  "January 2, 2006 3:04 PM",
		TimeOnly:  "3:04 PM",
	},
	language.BritishEnglish: {
		ShortDate: "02/01/2006",            // DD/MM/YYYY
		LongDate:  "2 January 2006",
		DateTime:  "2 January 2006 15:04",
		TimeOnly:  "15:04",
	},
	language.German: {
		ShortDate: "02.01.2006",            // DD.MM.YYYY
		LongDate:  "2. January 2006",
		DateTime:  "2. January 2006 15:04 Uhr",
		TimeOnly:  "15:04 Uhr",
	},
	language.Japanese: {
		ShortDate: "2006/01/02",            // YYYY/MM/DD
		LongDate:  "2006年1月2日",
		DateTime:  "2006年1月2日 15:04",
		TimeOnly:  "15:04",
	},
	language.Chinese: {
		ShortDate: "2006/01/02",
		LongDate:  "2006年1月2日",
		DateTime:  "2006年1月2日 下午3:04",
		TimeOnly:  "下午3:04",
	},
}

// fallbackDateFormat is used when a specific locale is not in the map.
var fallbackDateFormat = struct{ ShortDate, LongDate, DateTime, TimeOnly string }{
	ShortDate: "2006-01-02", // ISO 8601
	LongDate:  "2 January 2006",
	DateTime:  "2006-01-02 15:04:05",
	TimeOnly:  "15:04",
}

type DateStyle int

const (
	DateShort DateStyle = iota
	DateLong
	DateTimeStyle
	TimeOnlyStyle
)

// FormatDate formats t in the given locale's conventional date format.
// Always pass times with the correct timezone already set.
func FormatDate(tag language.Tag, t time.Time, style DateStyle) string {
	formats, ok := dateFormats[tag]
	if !ok {
		formats.ShortDate = fallbackDateFormat.ShortDate
		formats.LongDate = fallbackDateFormat.LongDate
		formats.DateTime = fallbackDateFormat.DateTime
		formats.TimeOnly = fallbackDateFormat.TimeOnly
	}
	var layout string
	switch style {
	case DateShort:
		layout = formats.ShortDate
	case DateLong:
		layout = formats.LongDate
	case DateTimeStyle:
		layout = formats.DateTime
	case TimeOnlyStyle:
		layout = formats.TimeOnly
	}
	return t.Format(layout)
}

// FormatRelativeTime returns a human-friendly relative time string (locale-aware).
func FormatRelativeTime(tag language.Tag, t time.Time) string {
	now := time.Now()
	diff := now.Sub(t)

	_ = message.NewPrinter(tag)

	switch {
	case diff < time.Minute:
		return localizeRelative(tag, "just_now", 0)
	case diff < time.Hour:
		mins := int(diff.Minutes())
		return localizeRelative(tag, "minutes_ago", mins)
	case diff < 24*time.Hour:
		hours := int(diff.Hours())
		return localizeRelative(tag, "hours_ago", hours)
	case diff < 7*24*time.Hour:
		days := int(diff.Hours() / 24)
		return localizeRelative(tag, "days_ago", days)
	default:
		return FormatDate(tag, t, DateShort)
	}
}

// localizeRelative is a placeholder for your bundle lookup.
func localizeRelative(tag language.Tag, key string, n int) string {
	// In production, delegate to your translation bundle + plural engine.
	return fmt.Sprintf("[%s:%s:%d]", tag, key, n)
}
```

### Phone Number Formatting

Phone number formatting requires carrier and country knowledge. Use `github.com/nyaruka/phonenumbers` (a maintained Go port of Google's libphonenumber).

```go
package formatting

import (
	"fmt"
	"github.com/nyaruka/phonenumbers"
)

// PhoneFormat represents the output format for a phone number.
type PhoneFormat int

const (
	// PhoneFormatInternational: +1 650-253-0000
	PhoneFormatInternational PhoneFormat = iota
	// PhoneFormatNational: (650) 253-0000
	PhoneFormatNational
	// PhoneFormatE164: +16502530000 (for storage/APIs)
	PhoneFormatE164
	// PhoneFormatRFC3966: tel:+1-650-253-0000 (for href="tel:")
	PhoneFormatRFC3966
)

// FormatPhone parses and formats a phone number for the given default region.
// defaultRegion is an ISO 3166-1 alpha-2 code, e.g., "US", "DE", "AE".
func FormatPhone(raw, defaultRegion string, format PhoneFormat) (string, error) {
	num, err := phonenumbers.Parse(raw, defaultRegion)
	if err != nil {
		return "", fmt.Errorf("invalid phone number %q: %w", raw, err)
	}
	if !phonenumbers.IsValidNumber(num) {
		return "", fmt.Errorf("phone number %q is not valid", raw)
	}

	var pf phonenumbers.PhoneNumberFormat
	switch format {
	case PhoneFormatInternational:
		pf = phonenumbers.INTERNATIONAL
	case PhoneFormatNational:
		pf = phonenumbers.NATIONAL
	case PhoneFormatE164:
		pf = phonenumbers.E164
	case PhoneFormatRFC3966:
		pf = phonenumbers.RFC3966
	}
	return phonenumbers.Format(num, pf), nil
}

func ExamplePhones() {
	inputs := []struct{ raw, region string }{
		{"650-253-0000", "US"},
		{"030 901820", "DE"},
		{"04 78 53 00 00", "FR"},
		{"050 555 5555", "AE"},
		{"011 2222 3333", "IN"},
	}
	for _, inp := range inputs {
		intl, _ := FormatPhone(inp.raw, inp.region, PhoneFormatInternational)
		e164, _ := FormatPhone(inp.raw, inp.region, PhoneFormatE164)
		fmt.Printf("%-20s → %-25s %s\n", inp.raw, intl, e164)
	}
	// 650-253-0000         → +1 650-253-0000           +16502530000
	// 030 901820           → +49 30 901820              +4930901820
	// 04 78 53 00 00       → +33 4 78 53 00 00          +33478530000
}
```

### Address Formatting

Address field ordering varies significantly by country. The US puts street before city before state/ZIP. Japan reverses this: postal code → prefecture → city → street → name. Germany puts the recipient name first, then street+number, then postal code+city.

```go
package formatting

import "strings"

// Address is a structured address with all possible fields.
type Address struct {
	GivenName      string
	FamilyName     string
	Organization   string
	StreetLine1    string
	StreetLine2    string
	DependentLocality string // Neighborhood or district (Brazil, Japan)
	Locality       string   // City or town
	AdminArea      string   // State, prefecture, province
	PostalCode     string
	CountryCode    string   // ISO 3166-1 alpha-2
}

// AddressFormatter formats an Address into locale-appropriate lines.
type AddressFormatter func(a Address) []string

var addressFormatters = map[string]AddressFormatter{
	"US": func(a Address) []string {
		// Full Name
		// Street Address Line 1
		// Street Address Line 2 (if present)
		// City, State ZIP
		// COUNTRY
		lines := []string{a.GivenName + " " + a.FamilyName}
		if a.Organization != "" {
			lines = append(lines, a.Organization)
		}
		lines = append(lines, a.StreetLine1)
		if a.StreetLine2 != "" {
			lines = append(lines, a.StreetLine2)
		}
		lines = append(lines, a.Locality+", "+a.AdminArea+" "+a.PostalCode)
		return lines
	},
	"DE": func(a Address) []string {
		// Vorname Nachname
		// Straße Hausnummer
		// PLZ Stadt
		lines := []string{a.GivenName + " " + a.FamilyName}
		lines = append(lines, a.StreetLine1)
		lines = append(lines, a.PostalCode+" "+a.Locality)
		return lines
	},
	"JP": func(a Address) []string {
		// 〒PostalCode
		// Prefecture City
		// Street
		// Organization
		// FamilyName GivenName 様
		lines := []string{
			"〒" + a.PostalCode,
			a.AdminArea + a.Locality,
			a.StreetLine1,
		}
		if a.Organization != "" {
			lines = append(lines, a.Organization)
		}
		lines = append(lines, a.FamilyName+" "+a.GivenName+" 様")
		return lines
	},
	"CN": func(a Address) []string {
		// PostalCode
		// Province City District Street
		// Organization
		// FamilyName GivenName (收)
		lines := []string{a.PostalCode}
		lines = append(lines, a.AdminArea+a.Locality+a.DependentLocality+a.StreetLine1)
		if a.Organization != "" {
			lines = append(lines, a.Organization)
		}
		lines = append(lines, a.FamilyName+a.GivenName+" 收")
		return lines
	},
}

// FormatAddress formats an address for the given country.
func FormatAddress(a Address) string {
	formatter, ok := addressFormatters[a.CountryCode]
	if !ok {
		// Fallback: generic format
		formatter = func(a Address) []string {
			return []string{
				a.GivenName + " " + a.FamilyName,
				a.StreetLine1,
				a.Locality + " " + a.PostalCode,
				a.CountryCode,
			}
		}
	}
	return strings.Join(formatter(a), "\n")
}
```

### Name Ordering: Given Name vs Family Name First

Most Western languages place the given name before the family name ("John Smith"), but Chinese, Japanese, Korean, Hungarian, and Vietnamese place the family name first ("Smith John"). Displaying names in the wrong order is a common localization mistake that signals cultural insensitivity. The `nameOrderMap` below maps language base tags to the correct ordering, and `FormatName` applies it.

```go
package formatting

import (
	"fmt"

	"golang.org/x/text/language"
)

// NameOrder defines whether given or family name comes first.
type NameOrder int

const (
	NameOrderGivenFirst  NameOrder = iota // John Smith (English, most Western)
	NameOrderFamilyFirst                  // Smith John (Chinese, Japanese, Korean, Hungarian)
)

// nameOrderMap maps language tags to their conventional name ordering.
var nameOrderMap = map[language.Base]NameOrder{
	mustParseBase("zh"): NameOrderFamilyFirst, // Chinese
	mustParseBase("ja"): NameOrderFamilyFirst, // Japanese
	mustParseBase("ko"): NameOrderFamilyFirst, // Korean
	mustParseBase("hu"): NameOrderFamilyFirst, // Hungarian
	mustParseBase("vi"): NameOrderFamilyFirst, // Vietnamese
}

func mustParseBase(s string) language.Base {
	tag := language.MustParse(s)
	base, _ := tag.Base()
	return base
}

// GetNameOrder returns the name ordering convention for a language tag.
func GetNameOrder(tag language.Tag) NameOrder {
	base, _ := tag.Base()
	if order, ok := nameOrderMap[base]; ok {
		return order
	}
	return NameOrderGivenFirst
}

// FormatName formats a personal name according to locale conventions.
func FormatName(tag language.Tag, givenName, familyName string) string {
	if GetNameOrder(tag) == NameOrderFamilyFirst {
		return familyName + " " + givenName
	}
	return givenName + " " + familyName
}

func ExampleNames() {
	names := []struct {
		tag    language.Tag
		given  string
		family string
	}{
		{language.English, "John", "Smith"},
		{language.Japanese, "太郎", "山田"},
		{language.Chinese, "伟", "李"},
		{language.Korean, "민준", "김"},
		{language.German, "Hans", "Müller"},
	}
	for _, n := range names {
		fmt.Printf("%-10s: %s\n", n.tag, FormatName(n.tag, n.given, n.family))
	}
	// en         : John Smith
	// ja         : 山田 太郎
	// zh         : 李 伟
	// ko         : 김 민준
	// de         : Hans Müller
}
```

### Junior to FAANG: the formatting details you do not notice until a user complains

Number grouping for Indian locales uses a two-digit group after the first three (`12,34,567.89`). Currency symbol placement differs by locale even for the same currency (`€1,234.56` in some locales, `1.234,56 €` in others). Date ambiguity (`01/02/03`) is the single most dangerous hand-rolled pattern because the string looks valid in every locale but means different dates. These are not edge cases. These are common-path bugs.

Phone number formatting is libphonenumber territory and you should never hand-roll it. Every country has specific rules. Brazil moved mobile numbers from 8 to 9 digits in 2016 and libphonenumber tracked it. The US changed area code rules in various cities. Germany has variable-length numbers. Your code cannot track these changes. The library does.

Addresses are similarly not-yours-to-roll. CLDR publishes postal address formats for every country. Google's libaddressinput is the reference implementation (Java and JavaScript). For Go, you vendor equivalent data or roll with the subset shown. The staff-level answer is "use a library, do not hand-roll."

Name order is the culturally specific case. Japanese, Korean, Chinese, Hungarian, and Vietnamese names put family before given. A product that displays "John Smith" when the user entered "Smith John" in Japanese locale has culturally insulted the user. This is low-effort, high-signal work to get right.

Worked example. A Korean user signs up with family name "김" (Kim) and given name "민준" (Minjun). Your UI displays "민준 김" because you concatenated `givenName + " " + familyName`. A Korean colleague flags this as insulting. You add a name-order helper keyed on locale and fix it. The same helper covers Japanese, Chinese, Hungarian, and Vietnamese. This is a 30-line fix with a large politeness payoff.

Interview framing. "How do you format a user's name across locales." The answer names the ordering difference and mentions CLDR's PersonName formatting as the canonical approach. Bonus: mention that ICU has PersonName.Formatter, Go does not yet, and you would either vendor ICU or implement a subset.

### Senior at FAANG: data formatting as a platform API

The functions in the example are useful building blocks. At staff level, the question is which of these belong in a shared platform library and which belong per-service. The answer is: all of them belong in a shared platform library, maintained by a central team, versioned, documented, and consumed everywhere.

The reason is consistency, not reuse. Two services that implement their own date formatter will diverge over time. A user interacting with both services sees inconsistent date formats across the product. This is the user-facing symptom of a platform maturity gap. The fix is a shared library that every service uses. The budget is a team of two to three engineers dedicated to platform primitives.

The library has specific contract properties. It exposes a stable API that does not change without major version. It vendors CLDR data with an explicit version pin that updates on a release cadence. It emits observability signals for each call (which format was used, which locale, which currency) so the team can measure adoption and migrate deprecated usage. It documents every function with worked examples and links to the CLDR spec. It tests against the full set of launch-blocking locales on every PR.

CLDR skeleton support is the future of date formatting. Instead of mapping locales to hand-rolled format strings (as the example does), you request a skeleton (`yMMMd`, `Hm`, `EEEE MMM d`) and CLDR resolves to the actual pattern per locale. This is how ICU works. Go's `golang.org/x/text` does not yet ship a locale-aware date skeleton formatter, so today you either drive CLDR data yourself or use a CLDR-backed library. If x/text gains stable skeleton support, migrate off hand-rolled patterns.

Address formatting at scale requires a data-driven approach, not the per-country switch shown. The canonical data source is Google's libaddressinput project (now part of the CLDR ecosystem). It publishes JSON for every country with field definitions, ordering rules, formatting rules, and validation patterns. Your service ingests this data and applies it. Hand-rolling per-country (as the example does for illustration) does not scale past 15 countries.

Name formatting has a privacy dimension. A product that captures given name and family name separately can format them correctly, but users in many cultures do not decompose their names this way (mononyms are common in some cultures, compound family names in Spanish-speaking countries, patronymics in Arabic cultures). Your name-capture UX must accept a single "full name" field as an option. Your display must handle mononyms gracefully. Your back-end must not reject valid names. A common bug: regex validation that rejects spaces or non-ASCII characters in name fields, rejecting every non-Western name. The right validation is "not empty, not longer than 256 characters, valid UTF-8" and no more.

Unit formatting (`5 km`, `3 ft`, `72 °F`) has locale conventions that track measurement system rather than language. Canadian French users expect metric. US English users expect imperial. UK English is mixed (miles for driving, kilometers for running). Unit preference is a user profile field, not a locale derivation. Default the field based on country but let the user override. CLDR ships unit formatting data per locale in long, short, and narrow variants.

Weight units, distance units, and temperature units each have independent preferences. A user in Canada might want Celsius for weather, kilometers for navigation, and pounds for personal weight because personal-weight norms in Canada are mixed. Your UX should capture each independently if the domain matters (fitness, health, logistics). Do not force all three to the same metric-or-imperial toggle.

Currency formatting at scale needs a clear currency-versus-locale separation. Locale governs display conventions (grouping, decimal separator, symbol placement). Currency governs the symbol, the minor-unit scale, and the rounding rule. A user in France viewing a USD price sees `19,99 $US` (French locale, US currency). A user in the US viewing a EUR price sees `€19.99` (US locale, EUR currency). The formatter takes both as independent inputs. The UI does not conflate them.

Money arithmetic is a separate layer entirely. Formatting is display. Arithmetic is domain logic. Your money type is an immutable `(amount_minor, currency)` pair. Operations on different currencies are rejected or require explicit FX conversion. The conversion itself is audited with rate and timestamp. Go libraries: `go-money` is widely used but ergonomically limited. `shopspring/decimal` plus a custom wrapper is the staff-preferred approach. Build the wrapper once, use it everywhere.

Internationalized numeric input (parsing user-entered numbers per locale) is the reverse of formatting. A German user types `1.234,56` meaning 1,234.56. A US user types `1,234.56` meaning the same. Your input parser must know the user's locale to disambiguate. `message.Printer.Scan` and related functions in x/text provide locale-aware parsing, but coverage is limited. Production apps often parse by stripping known separators and normalizing, which works for most cases and fails on edge cases (numbers exceeding 999,999 in locales that group unusually). Test with real user input from launch markets.

Sorting by user-visible fields (product titles, user names) uses locale collation from earlier in the chapter. Sorting by system fields (timestamps, IDs) uses byte order. The boundary is whether the sort key is user-facing. If a user sees it and compares items by it, use collation. If a system uses it internally, use byte order. Mixing these produces inconsistent sort orders across services.

Timezone handling interacts with all date formatting. Every time value in a system should carry or be unambiguously associated with a timezone. UTC storage with explicit timezone per display is the correct pattern. The user's preferred timezone is a profile field, with a per-session override and a per-event override where applicable. Display never assumes server timezone. Go's `time.Time` carries a `time.Location`. Use it consistently.

CLDR data pipeline governance closes this section. A mature platform has a CLDR ingestion service that runs on CLDR release cadence (currently twice yearly), diffs the new data against the pinned version, runs regression tests against active locales, surfaces breaking changes to the i18n platform team, and gates adoption on review. A platform that accepts whatever CLDR ships automatically will see production behavior change without notice. A platform that ignores CLDR updates indefinitely will drift and eventually ship stale data that contradicts user expectations. The middle path is governed adoption.

---
