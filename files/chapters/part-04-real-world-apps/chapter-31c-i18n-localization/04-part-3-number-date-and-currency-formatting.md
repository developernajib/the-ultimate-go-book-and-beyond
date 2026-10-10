## Part 3: Number, Date, and Currency Formatting

Number, date, and currency formatting delegates to `golang.org/x/text/message` and `golang.org/x/text/currency`, which use CLDR data to apply locale-specific decimal separators, digit grouping, and currency symbol placement. A `message.Printer` is created per locale rather than per request to avoid repeated BCP 47 parsing and catalog lookup. The printer is stored in the request context after locale negotiation. Currency amounts are represented as integer minor units (cents for USD, pence for GBP, fils for AED) or a `decimal.Decimal` type to avoid floating-point rounding errors before formatting. A critical rule: never hardcode `2` decimal places. Fractional digits vary by currency, JPY and KRW use 0, most currencies use 2, BHD and KWD use 3. Always derive the scale from `currency.Cash.Rounding(unit)` or `unit.Rounding(...)` so accounting ledgers never silently lose or fabricate sub-unit precision.

```go
package format

import (
	"fmt"
	"math"
	"strings"
	"time"

	"golang.org/x/text/currency"
	"golang.org/x/text/language"
	"golang.org/x/text/message"
	"golang.org/x/text/number"
)

// NumberFormatter formats numbers for a locale
type NumberFormatter struct {
	printer *message.Printer
	tag     language.Tag
}

func NewNumberFormatter(locale string) *NumberFormatter {
	tag, _ := language.Parse(locale)
	return &NumberFormatter{
		printer: message.NewPrinter(tag),
		tag:     tag,
	}
}

// FormatInteger formats an integer with locale-appropriate thousands separators
func (f *NumberFormatter) FormatInteger(n int64) string {
	return f.printer.Sprint(number.Decimal(n))
}

// FormatFloat formats a float with specified decimal places
func (f *NumberFormatter) FormatFloat(n float64, decimals int) string {
	scale := math.Pow10(decimals)
	return f.printer.Sprint(number.Decimal(
		math.Round(n*scale)/scale,
		number.MaxFractionDigits(decimals),
		number.MinFractionDigits(decimals),
	))
}

// FormatPercent formats a percentage (0.0 to 1.0 → "45.2%")
func (f *NumberFormatter) FormatPercent(n float64, decimals int) string {
	return f.printer.Sprint(number.Percent(n,
		number.MaxFractionDigits(decimals),
		number.MinFractionDigits(decimals),
	))
}

// FormatCurrency formats a monetary amount
func (f *NumberFormatter) FormatCurrency(amount float64, currencyCode string) string {
	cur, err := currency.ParseISO(currencyCode)
	if err != nil {
		return fmt.Sprintf("%s %.2f", currencyCode, amount)
	}
	return f.printer.Sprint(currency.Symbol(cur.Amount(amount)))
}

// Examples:
// en-US: 1,234,567.89  → 1,234,567.89
// de-DE: 1,234,567.89  → 1.234.567,89
// fr-FR: 1,234,567.89  → 1 234 567,89
// ja-JP: 1,234,567.89  → 1,234,567.89 (no decimal grouping difference)

// DateTimeFormatter formats dates for a locale
type DateTimeFormatter struct {
	locale string
	tag    language.Tag
	tz     *time.Location
}

func NewDateTimeFormatter(locale string, tz *time.Location) *DateTimeFormatter {
	tag, _ := language.Parse(locale)
	if tz == nil {
		tz = time.UTC
	}
	return &DateTimeFormatter{locale: locale, tag: tag, tz: tz}
}

// Format patterns by locale (simplified - production code uses a CLDR-backed date formatter such as go-i18n rather than hand-rolled patterns)
var dateFormats = map[string]struct {
	Date     string
	Time     string
	DateTime string
}{
	"en-US": {"1/2/2006", "3:04 PM", "1/2/2006, 3:04 PM"},
	"en-GB": {"02/01/2006", "15:04", "02/01/2006 15:04"},
	"de-DE": {"02.01.2006", "15:04", "02.01.2006 15:04"},
	"fr-FR": {"02/01/2006", "15:04", "02/01/2006 15:04"},
	"ja-JP": {"2006年01月02日", "15時04分", "2006年01月02日 15時04分"},
	"zh-CN": {"2006/01/02", "15:04", "2006/01/02 15:04"},
	"ar-SA": {"02/01/2006", "15:04", "02/01/2006 15:04"},
}

// FormatDate formats a date according to locale
func (f *DateTimeFormatter) FormatDate(t time.Time) string {
	t = t.In(f.tz)
	if fmt, ok := dateFormats[f.locale]; ok {
		return t.Format(fmt.Date)
	}
	return t.Format("2006-01-02") // ISO fallback
}

// FormatTime formats a time according to locale
func (f *DateTimeFormatter) FormatTime(t time.Time) string {
	t = t.In(f.tz)
	if fmt, ok := dateFormats[f.locale]; ok {
		return t.Format(fmt.Time)
	}
	return t.Format("15:04")
}

// FormatDateTime formats a full datetime according to locale
func (f *DateTimeFormatter) FormatDateTime(t time.Time) string {
	t = t.In(f.tz)
	if fmt, ok := dateFormats[f.locale]; ok {
		return t.Format(fmt.DateTime)
	}
	return t.Format("2006-01-02 15:04")
}

// RelativeTime returns a human-readable relative time string
func (f *DateTimeFormatter) RelativeTime(t time.Time, loc *Localizer) string {
	now := time.Now()
	diff := now.Sub(t)

	switch {
	case diff < time.Minute:
		return loc.T("date.relative.just_now")
	case diff < time.Hour:
		minutes := int(diff.Minutes())
		return loc.Plural("date.relative.minutes_ago", minutes)
	case diff < 24*time.Hour:
		hours := int(diff.Hours())
		return loc.Plural("date.relative.hours_ago", hours)
	case diff < 48*time.Hour:
		return loc.T("date.relative.yesterday")
	default:
		days := int(diff.Hours() / 24)
		return loc.Plural("date.relative.days_ago", days)
	}
}

// FormatMoney formats a monetary amount with the correct symbol,
// placement, and fractional digits for the target locale. Fractional
// digits are derived from CLDR (via currency.Cash.Rounding) rather than
// hardcoded to 2, so JPY renders as "¥1,234" (0 fraction digits), USD as
// "$1,234.56" (2), and BHD as "BHD 1,234.567" (3).
//
// amount is expressed in the currency's major unit (e.g. dollars, not cents).
// If you store minor units (recommended), divide by the rounding scale
// before calling this function.
func FormatMoney(amount float64, currencyCode string, locale string) string {
	tag, err := language.Parse(locale)
	if err != nil {
		tag = language.English
	}
	cur, err := currency.ParseISO(strings.ToUpper(currencyCode))
	if err != nil {
		return fmt.Sprintf("%s %.2f", currencyCode, amount)
	}
	scale, _ := currency.Cash.Rounding(cur)
	p := message.NewPrinter(tag)
	return p.Sprint(currency.Symbol(cur.Amount(amount).Kind(currency.Cash).Rounding()),
		number.Decimal(amount,
			number.MinFractionDigits(scale),
			number.MaxFractionDigits(scale),
		),
	)
}

// FormatMoneyMinor is the preferred entry-point when you store money as
// integer minor units (the pattern every production accounting system
// should use). It looks up the correct scale from CLDR and converts.
func FormatMoneyMinor(minorUnits int64, currencyCode string, locale string) string {
	tag, err := language.Parse(locale)
	if err != nil {
		tag = language.English
	}
	cur, err := currency.ParseISO(strings.ToUpper(currencyCode))
	if err != nil {
		return fmt.Sprintf("%s %d", currencyCode, minorUnits)
	}
	scale, _ := currency.Cash.Rounding(cur)
	divisor := math.Pow10(scale)
	major := float64(minorUnits) / divisor
	p := message.NewPrinter(tag)
	return p.Sprint(currency.Symbol(cur.Amount(major)))
}
```

### Junior to FAANG: the formatting bugs that look trivial but are not

Three bugs will bite you on your first real i18n ticket. First, you will format a price as `fmt.Sprintf("$%.2f", amount)`. It will work in en-US and break everywhere else. Germans expect `1.234,56 EUR`. Japanese expect `￥1,234` with no decimals. The fix is to route every currency format through `currency.Symbol(cur.Amount(x))` via a `message.Printer` bound to the locale, and to never hardcode `2` as the decimal count. JPY and KRW use 0 decimals. BHD and KWD use 3.

Second, you will store money as `float64`. Floating-point arithmetic rounds in ways accounting systems cannot tolerate. `0.1 + 0.2` is not `0.3`. Use integer minor units (store cents, not dollars). When you need fractional precision that minor units cannot express (forex rates, oil prices per barrel), use `shopspring/decimal`. Never use `float64` for money in a path that writes to a ledger.

Third, you will format a date as `t.Format("01/02/2006")` because Go's reference date looks American. This produces `04/22/2026` for Americans and `04/22/2026` for Europeans, and Europeans will assume `04/22` is day 4 month 22, which does not exist. They read the date as broken. The fix is to never hand-roll format patterns. Use locale skeletons (`yMMMd` for "year, abbreviated month, day") through a CLDR-aware formatter. The canonical Go approach is to build per-locale pattern maps from CLDR data or adopt a CLDR-backed date library, since neither the standard library nor `golang.org/x/text` currently ships a locale-aware date skeleton formatter.

Worked example for currency. A user in France buys a product priced at USD 19.99. Your backend stores the price as `1999` (minor units) with currency code USD. You render the product page in French locale. The correct render is `19,99 $US` (French uses a comma as decimal separator and places the currency symbol after the amount with a locale-specific form of "US dollar"). The wrong render is `$19.99` with an American format regardless of locale. The key architectural decision embedded in that single render is that currency (USD) is a property of the product, locale (fr-FR) is a property of the user, and they are independent dimensions. Do not let them collapse.

Interview framing. "How do you format money in a multi-currency multi-locale app." The correct answer has four parts. Store as integer minor units (or decimal). Keep currency code and user locale as separate fields. Resolve display-time using CLDR-backed formatter. Derive decimal count from the currency, not from a constant. If you can articulate those four parts you pass. If you reach for `fmt.Sprintf` you fail.

### Senior at FAANG: locale-aware data formatting beyond the basics

At scale, number and date formatting is not the interesting part. The interesting part is the data model that feeds the formatter. A production platform has at least four distinct contexts where formatting matters. Display (user-facing text). Export (CSV, XLSX, PDF destined for download, often read by accounting software that expects a specific format). Exchange (JSON APIs that partner systems consume, always in canonical ISO form regardless of user locale). Archival (database values, always in canonical form with locale preference stored separately). Confusing these is the source of roughly half of the cross-border financial-integration bugs I have audited.

The invariant: data at rest and in motion is locale-independent. Data on screen is locale-specific. The transformation happens exactly at the display boundary, never earlier. If your API returns `"price": "19,99 $US"` as a formatted string, your platform is broken. The API returns `"price_minor": 1999, "currency": "USD"`. The client applies the user's locale.

Currency is not locale. This deserves repeating because it is the single most common architectural error in multi-currency systems. A user in France can hold a USD balance in a European neobank. A user in the US can pay a Brazilian freelancer in BRL. The transaction currency is a property of the transaction, determined by business rules (merchant category, origination country, account currency, partner preference). The user's locale governs only the display format. Your schema separates them. Your UI lets them diverge. Your reporting aggregates by currency, then applies a per-user display locale on read.

CLDR date skeletons are the only correct way to format dates cross-locale. A skeleton is a pattern like `yMMMd` that means "year, abbreviated month, day." CLDR resolves it per-locale into the actual pattern (`Apr 22, 2026` in en-US, `22 avr. 2026` in fr-FR, `2026年4月22日` in ja-JP). Hand-rolled patterns per locale (as in the `dateFormats` map above) work for a small set of locales and break the moment you add the sixth. Production code uses ICU `DateTimeFormat` with skeletons or the equivalent CLDR-backed Go library. If `golang.org/x/text` gains stable skeleton support (a long-requested feature tracked in its issue tracker), migrate off hand-rolled patterns immediately.

Time zone handling intersects with locale but is distinct. A user in New York on business in Tokyo wants to see meeting times in JST (the conference schedule) but numeric formats in English (the user preference). Locale and time zone must be independent request-scoped values. The display layer composes them. Storing a time as `time.Time` in UTC is correct. Storing it with a `time.Location` derived from the event, not the user, is correct. The user's time zone is a display preference that can override the event time zone or not, per product decision.

Relative time (`3 minutes ago`, `yesterday`, `last Tuesday`) uses CLDR relative time patterns, which are separate from absolute date patterns and have their own plural categories. English says `1 minute ago` / `2 minutes ago`. Arabic has six plural forms of the same expression. Russian has three. Do not implement relative time with hand-rolled strings. Use CLDR relative time data through ICU or a CLDR-ingesting library. Large legacy terminal and trading systems have repeatedly gotten this wrong because relative-time strings were hardcoded in English in an older codebase, and later internationalization audits tend to find relative-time bugs concentrated in exactly the code paths that route non-English users.

Rounding in currency formatting has a regulatory dimension. CHF cash rounds to 0.05. Some CAD contexts round to 0.05 after 2013. Bitcoin does not round at all. Oil trades in 1/8 dollar increments on some venues. Your formatter does not know the context. The caller provides the rounding scale. CLDR provides cash rounding defaults (`currency.Cash.Rounding`) and numeric rounding defaults (`currency.Standard.Rounding`). Cash and standard can differ (CHF is 0.05 cash, 0.01 standard). The distinction matters when you render an invoice total for a Swiss customer paying cash versus card. Model it explicitly.

Number formatting precision and bankers-rounding are distinct concerns. `0.5` rounds to `0` in bankers-rounding (round-half-to-even), to `1` in school-rounding (round-half-up). Financial systems in Europe default to bankers-rounding per IEEE 754. The US is mixed. Your formatter must expose the rounding mode explicitly. `golang.org/x/text/number` does not yet expose all IEEE 754 rounding modes. If your domain requires a specific mode, do the rounding in a decimal library before handing the value to the formatter.

Unit formatting (`5.2 km`, `3 ft`, `12 °C`) is the extension territory of i18n. CLDR ships unit display patterns for every supported locale in long, short, and narrow forms. US users expect imperial by default, metric users expect metric, Canadian users expect metric for temperature and either for distance. Unit preference is a locale-adjacent signal, not a strict locale property, because a French user in Montreal might prefer miles when driving. Store unit preference as a per-user field, not derived from locale. Render through `unit.Unit` helpers in x/text or the equivalent ICU unit formatter. This is also where accessibility bites: unit abbreviations (`km`, `mi`) must be read aloud correctly by screen readers, and ARIA `lang` tags on the enclosing element matter.

Export formats (CSV, XLSX) have format expectations that diverge from display. Excel in a German locale expects CSV with semicolon delimiters because comma is the decimal separator. A user in Germany downloading a CSV from your dashboard expects the file to open correctly in their local Excel. The correct behavior is to detect the user locale, generate a CSV with locale-appropriate delimiters and decimal separators, write a BOM so Excel treats it as UTF-8, and name the file with a locale hint. All four of those are distinct decisions and all four have bitten me in production. Document your export format policy per locale.

---
