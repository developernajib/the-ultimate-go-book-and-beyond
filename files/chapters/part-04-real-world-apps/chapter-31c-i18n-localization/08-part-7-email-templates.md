## Part 7: Email Templates

Email templates are stored as paired text and HTML files. The HTML version is rendered with `html/template` (which auto-escapes interpolated values) while the text version uses `text/template`, preventing XSS in HTML email clients. Localization of email content uses the same `message.Printer` infrastructure as HTTP responses, with the recipient's stored locale preference passed to the printer rather than the request's Accept-Language header. Subject lines containing non-ASCII characters are encoded with RFC 2047 Q-encoding by the MIME library before being added to the mail header, ensuring compatibility with legacy email clients.

```go
package email

import (
	"bytes"
	"fmt"
	"html/template"
	"text/template"

	"myapp/internal/i18n"
)

// LocalizedEmailTemplate renders email templates with locale-specific content
type LocalizedEmailTemplate struct {
	bundle    *i18n.Bundle
	templates map[string]*template.Template
}

// TemplateData carries data and i18n functions to templates
type TemplateData struct {
	Data      map[string]any
	Locale    string
	localizer *i18n.Localizer
}

// T is available in templates as {{.T "key"}}
func (d *TemplateData) T(key string) string {
	return d.localizer.T(key)
}

// Tf is available as {{.Tf "key" (dict "name" .User.Name)}}
func (d *TemplateData) Tf(key string, args map[string]any) string {
	return d.localizer.Tf(key, args)
}

// Email template: order_confirmation.html
const orderConfirmationTemplate = `
<!DOCTYPE html>
<html lang="{{.Locale}}" dir="{{dir .Locale}}">
<head>
  <meta charset="UTF-8">
  <title>{{.T "email.order_confirmation.title"}}</title>
</head>
<body style="direction: {{dir .Locale}}; text-align: {{textAlign .Locale}}">
  <h1>{{.Tf "email.order_confirmation.greeting" (dict "name" .Data.CustomerName)}}</h1>
  <p>{{.Tf "email.order_confirmation.body" (dict "order_id" .Data.OrderID)}}</p>
  <table>
    <thead>
      <tr>
        <th>{{.T "email.order_confirmation.item"}}</th>
        <th>{{.T "email.order_confirmation.quantity"}}</th>
        <th>{{.T "email.order_confirmation.price"}}</th>
      </tr>
    </thead>
    <tbody>
      {{range .Data.Items}}
      <tr>
        <td>{{.Name}}</td>
        <td>{{.Quantity}}</td>
        <td>{{formatMoney .PriceCents $.Data.Currency $.Locale}}</td>
      </tr>
      {{end}}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="2">{{$.T "email.order_confirmation.total"}}</td>
        <td>{{formatMoney .Data.TotalCents .Data.Currency .Locale}}</td>
      </tr>
    </tfoot>
  </table>
  <p>{{.T "email.order_confirmation.footer"}}</p>
</body>
</html>
`

func buildFuncMap(locale string) template.FuncMap {
	return template.FuncMap{
		"dir": func(locale string) string {
			return rtl.Direction(locale)
		},
		"textAlign": func(locale string) string {
			return rtl.TextAlign(locale)
		},
		"formatMoney": func(amountCents int64, currency, locale string) string {
			return format.FormatMoneyMinor(amountCents, currency, locale)
		},
	}
}

func RenderOrderConfirmation(bundle *i18n.Bundle, locale string, data map[string]any) (string, error) {
	localizer := bundle.NewLocalizer(i18n.Locale(locale))

	tmpl, err := template.New("order_confirmation").
		Funcs(buildFuncMap(locale)).
		Parse(orderConfirmationTemplate)
	if err != nil {
		return "", fmt.Errorf("parse template: %w", err)
	}

	td := &TemplateData{
		Data:      data,
		Locale:    locale,
		localizer: localizer,
	}

	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, td); err != nil {
		return "", fmt.Errorf("execute template: %w", err)
	}

	return buf.String(), nil
}
```

### Junior to FAANG: email i18n gotchas

Localized email has three bugs you will hit on your first ticket. First, the subject line. RFC 5322 headers are ASCII. A subject like "Bestätigung Ihrer Bestellung" must be MIME-encoded per RFC 2047 before it goes on the wire. Go's `mime.QEncoding.Encode("UTF-8", subject)` handles this. Forget it and major providers quietly mangle your subject in non-English locales.

Second, the recipient locale is not the request locale. The user placing the order in a kiosk at a hotel with the browser set to English might have a profile locale of German because they are German. Send the email in the profile locale, not the session locale. Store the locale on the email-trigger event so async workers (which run hours after the session ended) can reproduce the right rendering.

Third, email clients have inconsistent support for RTL. Gmail on the web handles `dir="rtl"` on `<html>` correctly. Outlook on Windows traditionally needed per-table `dir` attributes because it does not inherit direction through its rendering engine (which is based on Word's HTML engine). Test every email template in Outlook, Gmail, Apple Mail, and a mobile client in both LTR and RTL locales. Use Litmus or Email on Acid for systematic client testing.

Worked example. You send an order confirmation to a Saudi user. The subject is "تأكيد طلبك رقم 12345". The body is RTL but the order number and price are LTR. The template wraps the order number with FSI isolates. The subject is Q-encoded. Outlook renders the body RTL because the outer table has `dir="rtl"`. Gmail renders identically. Mobile Apple Mail renders identically. If any one of those renders wrong, you have a template bug, and the bug will reveal itself only through real-client testing, not in your browser preview.

Interview framing. "How do you send localized email in Go." The answer covers per-recipient locale resolution, the separation of text and HTML templates, RFC 2047 subject encoding, placeholder substitution with locale-aware formatters, and RTL support across major email clients. Mention that you queue locale on the trigger event so async workers have the right context.

### Senior at FAANG: email localization at platform scale

Email is the worst rendering environment i18n ever has to support. CSS support varies by client. JavaScript is forbidden. External stylesheets are unreliable. Images are blocked by default. The only universal primitive is tables and inline styles. Against this backdrop, RTL, dynamic text expansion, and character set correctness are the specific challenges.

Text-first email design is the staff-level policy. Every email has a plain-text alternative that renders cleanly without HTML. The text version handles i18n with no bidi-rendering dependency. The HTML version layers on top for clients that support it. The text version is not optional. Spam filters penalize HTML-only emails, and accessibility law in several jurisdictions requires a text alternative. Your template system generates both from a single source, never hand-maintains them separately.

Font embedding in email does not work reliably. Arabic and Hebrew email must use system-default fonts on the recipient's device, because web fonts via `@font-face` are stripped by most clients. The design implication is that Arabic email may render in a default Arabic font that differs from your brand font. Accept this. Do not fight it with images-of-text (which break accessibility, vary on retina displays, and are blocked by image-loading defaults). The email is not your website. Brand purity is not achievable. Design for the default-fonts reality.

Subject line length is locale-dependent. German subjects run 30 percent longer than English. Japanese subjects may pack more information in fewer characters. Mailbox clients truncate at different points (Gmail at around 50 characters on desktop, fewer on mobile). Your subject-line copywriter writes per-language, not translates-English-to-Japanese. Treat subject lines as native-first localization, not translation. This is a significant ops commitment: for every email template, you have a per-locale subject-line author, not just a translator.

Preview text (the snippet shown below the subject in list view) is a hidden element in the email body (`<div style="display:none">...</div>`). It is localized just like subject lines and has the same length and native-authoring considerations. Most teams forget to localize preview text, and English leaks into non-English inboxes. A simple lint rule on the template catches this.

Deliverability has a locale dimension you may not expect. Sender reputation is maintained per domain. If you send English-language marketing to a Japanese user list, engagement drops and reputation suffers. If you send in the recipient's preferred language, engagement rises. Segment your sending infrastructure by major language cluster (Latin-script, CJK, Arabic-script, Cyrillic) on separate subdomains so a reputation hit in one cluster does not affect others. This is a detail most ESP vendors do not mention.

Compliance text (unsubscribe link, physical address, legal disclaimers) must be localized. CAN-SPAM applies to US recipients and requires English-compliant text. CASL (Canada) has French and English requirements. German competition law has specific wording. France has similar. Your compliance footer is not one string translated six ways. It is a per-locale legal-reviewed block that may differ in structure. Legal review is per-launch-market and non-skippable.

Unsubscribe handling is locale-aware. The unsubscribe page rendered after a click must be in the recipient's locale. The confirmation email (if you send one) is in the recipient's locale. Both respect the same language negotiation as any other page, but with the added constraint that the recipient may have clicked from a different device with different browser locale than their actual preference. Always use the preference stored on the recipient record, not the request headers, for these pages.

Character set handling at the SMTP level is a fossil. Most modern email is 8BITMIME with UTF-8 bodies. Some SMTP relays still require 7-bit quoted-printable encoding. Your mail library handles this transparently if configured correctly. Test your outbound mail with non-BMP characters (emoji, rare CJK) to catch encoding regressions early. A single SMTP hop that does not support 8BITMIME can corrupt emoji in marketing emails, and you may not detect it until a launch into a market that uses emoji heavily in brand voice.

Transactional emails with variable content (order confirmations, shipping notices) have structural i18n concerns beyond string translation. Name formatting varies: "Dear John Smith" in English becomes "Dear Mr Smith" or "Dear Smith-san" (with honorific) in Japanese, "Dear Smith" in some cultures, "Dear John" in informal variants. Your name-formatting layer takes the user's name parts (given, family, honorific if known, display-preference) and a locale, and produces the correctly-formed salutation. This is a per-locale CLDR-backed primitive (personName formatting), which ICU exposes as `PersonName.Formatter` and Go does not yet expose natively. Roll your own or accept simplified salutations until x/text catches up.

AB testing of email copy across locales is a research program. A subject line that lifts open rates 12 percent in English may lift 2 percent in German and depress 5 percent in Japanese, because cultural expectations of email copy differ. Your experimentation platform must support per-locale variants with per-locale statistical power. This is often an order of magnitude more experiment design than a US-only team realizes. Budget for it or do not run the experiments.

---
