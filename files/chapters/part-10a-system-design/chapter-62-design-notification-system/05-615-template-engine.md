## 62.5 Template Engine

The template engine renders notification content by combining stored templates with per-notification data, supporting both plain text and HTML variants for email notifications. Go's `text/template` and `html/template` packages are used appropriately, `html/template` for HTML content to auto-escape user-provided data and prevent XSS, `text/template` for plain text variants. Template sources are fetched from the repository once and cached in a sync-protected map, avoiding a database round trip per delivery. A production engine additionally caches the parsed template objects, parsing on every render is pure CPU waste.

```go
// template/engine.go
package template

import (
    "bytes"
    "context"
    "fmt"
    htmltemplate "html/template"
    "strings"
    "sync"
    "text/template"
)

// TemplateEngine renders notification templates
type TemplateEngine struct {
    repo      TemplateRepository
    cache     sync.Map // cacheKey -> *Template (source records)
    funcs     template.FuncMap
}

// Template represents a notification template
type Template struct {
    ID       string
    Name     string
    Channel  string
    Subject  string
    Body     string
    HTML     string
    Locale   string
    Version  int
}

// NewTemplateEngine creates a new template engine
func NewTemplateEngine(repo TemplateRepository) *TemplateEngine {
    return &TemplateEngine{
        repo: repo,
        funcs: template.FuncMap{
            "formatDate": formatDate,
            "formatMoney": formatMoney,
            "truncate": truncate,
            "upper": strings.ToUpper,
            "lower": strings.ToLower,
        },
    }
}

// Render renders a template with data
func (e *TemplateEngine) Render(ctx context.Context, templateName string, channel string, locale string, data map[string]any) (*RenderedContent, error) {
    // Get template
    tmpl, err := e.getTemplate(ctx, templateName, channel, locale)
    if err != nil {
        return nil, err
    }

    // Render subject
    var subjectBuf bytes.Buffer
    subjectTmpl, err := template.New("subject").Funcs(e.funcs).Parse(tmpl.Subject)
    if err != nil {
        return nil, fmt.Errorf("parse subject: %w", err)
    }
    if err := subjectTmpl.Execute(&subjectBuf, data); err != nil {
        return nil, fmt.Errorf("render subject: %w", err)
    }

    // Render body
    var bodyBuf bytes.Buffer
    bodyTmpl, err := template.New("body").Funcs(e.funcs).Parse(tmpl.Body)
    if err != nil {
        return nil, fmt.Errorf("parse body: %w", err)
    }
    if err := bodyTmpl.Execute(&bodyBuf, data); err != nil {
        return nil, fmt.Errorf("render body: %w", err)
    }

    // Render HTML (if available). html/template is aliased because
    // both template packages share the name, and it must be the one
    // used here: it auto-escapes interpolated data against XSS.
    var htmlBuf bytes.Buffer
    if tmpl.HTML != "" {
        htmlTmpl, err := htmltemplate.New("html").Funcs(htmltemplate.FuncMap(e.funcs)).Parse(tmpl.HTML)
        if err != nil {
            return nil, fmt.Errorf("parse html: %w", err)
        }
        if err := htmlTmpl.Execute(&htmlBuf, data); err != nil {
            return nil, fmt.Errorf("render html: %w", err)
        }
    }

    return &RenderedContent{
        Subject: subjectBuf.String(),
        Body:    bodyBuf.String(),
        HTML:    htmlBuf.String(),
    }, nil
}

func (e *TemplateEngine) getTemplate(ctx context.Context, name, channel, locale string) (*Template, error) {
    cacheKey := fmt.Sprintf("%s:%s:%s", name, channel, locale)

    // Check cache
    if cached, ok := e.cache.Load(cacheKey); ok {
        return cached.(*Template), nil
    }

    // Load from database
    tmpl, err := e.repo.GetTemplate(ctx, name, channel, locale)
    if err != nil {
        // Fallback to default locale
        tmpl, err = e.repo.GetTemplate(ctx, name, channel, "en")
        if err != nil {
            return nil, err
        }
    }

    // Cache template
    e.cache.Store(cacheKey, tmpl)

    return tmpl, nil
}

// InvalidateCache clears the template cache
func (e *TemplateEngine) InvalidateCache(templateName string) {
    e.cache.Range(func(key, value any) bool {
        if strings.HasPrefix(key.(string), templateName+":") {
            e.cache.Delete(key)
        }
        return true
    })
}
```

### Junior -> FAANG: Template Safety and Cache Design

The most important distinction in the template engine is between `html/template` (which automatically escapes interpolated values) and `text/template` (which does not). Using `text/template` to render HTML email content is a security vulnerability: a user whose name contains `<script>alert(1)</script>` will have that script injected into the email body, potentially affecting email clients that render HTML. The template engine in this chapter uses `html/template` for HTML content and `text/template` for plain text, which is the correct distinction.

The `sync.Map`-based cache in the template engine stores parsed templates after the first load, so the database round trip and template parsing cost is paid once per template per process lifetime. Know when to invalidate: `InvalidateCache` should be called whenever a template is updated in the database, and the update flow must ensure the cache is cleared on all instances (not just the instance that processed the update).

Template versioning via the `Version int` field on `Template` is a production necessity. When a template is updated, in-flight notifications that were already rendered with the old version will still deliver correctly, but new notifications will use the updated template. If you store rendered content in the notification record (recommended), you have an audit trail of exactly what each user received.

The locale fallback to `"en"` is a defensive pattern: if a template for `fr-CA` does not exist, fall back to `en` rather than returning an error that blocks delivery. The better production pattern adds a locale hierarchy (`fr-CA` -> `fr` -> `en`) so Canadian French users get French before falling back to English.

### Senior @ FAANG: Template Engine Governance and Content Security at Scale

**Template management as a platform governance concern**

When a notification platform serves 20 product teams, template management becomes a governance problem. Who can create templates? Who reviews them for tone, legal compliance (no misleading claims), and brand consistency? At FAANG, templates typically go through a review workflow: draft, legal review, brand review, activation. The template engine must support template states, and the active template version is the only one the engine serves.

Template A/B testing is a related concern. Duolingo's streak notification system (mentioned in the chapter introduction) runs continuous A/B tests on notification copy and timing. This requires the template engine to route a percentage of traffic to a variant template based on a consistent hash of the user ID (so the same user always sees the same variant), and to record which variant was used in the notification record for downstream analysis.

**Custom functions are an attack surface**

The `FuncMap` registered on the template engine exposes `formatDate`, `formatMoney`, `truncate`, and string functions. Every function in the `FuncMap` is callable from template content. If template authors are not the same people who defined the `FuncMap`, a malicious or careless template author could call a function with unexpected inputs and panic the rendering process (for example, passing a string to a function that expects a time.Time). The production defense is: validate all template function inputs with type assertions and recover panics in the rendering path, logging them as errors rather than crashing the worker.

**Template rendering is a CPU-intensive operation at scale**

At 1M notifications per minute, template rendering is not free. A complex HTML template with multiple conditional blocks and format calls can take 1-5ms to render. Rendering in the worker (per-message) means 1M render operations per minute. At 5ms per render, that is 83 seconds of CPU per minute across all workers, requiring roughly 2 cores devoted exclusively to rendering. An optimization is to render in a pre-processing step before queuing, store the rendered content in the queue message, and have the worker skip rendering entirely. This trades queue message size for worker CPU. A bar-raiser candidate can quantify this trade-off and recommend the right approach based on the system's CPU vs network bandwidth constraints.

**Caching templates in a multi-instance deployment**

The `sync.Map` cache in the template engine is per-instance. When a template is updated, the `InvalidateCache` call only clears the local instance's cache. Other instances continue serving the old template until their TTL-less cache entries are naturally replaced (which, with no TTL, means never until the process restarts). The production fix is event-driven invalidation: publish a cache invalidation event to a Redis Pub/Sub channel, and all instances subscribe to clear their local cache. Alternatively, add a short TTL to cached template entries (e.g., 5 minutes) so the propagation window is bounded even without explicit invalidation.

---
