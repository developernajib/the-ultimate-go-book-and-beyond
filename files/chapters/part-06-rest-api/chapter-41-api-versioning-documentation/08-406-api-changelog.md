## 41.6 API Changelog

### Changelog Management

The changelog is modeled as typed `ChangeType` constants (`added`, `deprecated`, `removed`) so the JSON output carries machine-readable categories that tooling can filter (for example, to alert on `breaking` changes in CI). Storing entries in code rather than a markdown file keeps the history queryable via the `/changelog` endpoint and co-located with the release tags that drove the changes.

```go
// ... imports omitted for brevity (encoding/json, fmt, net/http, strings, unicode)

// ChangeType represents the type of API change
type ChangeType string

const (
    ChangeTypeAdded      ChangeType = "added"
    ChangeTypeChanged    ChangeType = "changed"
    ChangeTypeDeprecated ChangeType = "deprecated"
    ChangeTypeRemoved    ChangeType = "removed"
    ChangeTypeFixed      ChangeType = "fixed"
    ChangeTypeSecurity   ChangeType = "security"
)

// Change represents a single API change
type Change struct {
    Type        ChangeType `json:"type"`
    Description string     `json:"description"`
    Endpoint    string     `json:"endpoint,omitempty"`
    Breaking    bool       `json:"breaking"`
}

// Release represents an API version release
type Release struct {
    Version     string    `json:"version"`
    Date        string    `json:"date"`
    Description string    `json:"description,omitempty"`
    Changes     []Change  `json:"changes"`
}

// Changelog holds all API releases
type Changelog struct {
    Title    string    `json:"title"`
    Releases []Release `json:"releases"`
}

// APIChangelog stores the changelog
var APIChangelog = Changelog{
    Title: "API Changelog",
    Releases: []Release{
        {
            Version:     "2.0.0",
            Date:        "2024-03-01",
            Description: "Major release with breaking changes",
            Changes: []Change{
                {
                    Type:        ChangeTypeChanged,
                    Description: "User response now returns first_name and last_name instead of name",
                    Endpoint:    "GET /users/{id}",
                    Breaking:    true,
                },
                {
                    Type:        ChangeTypeChanged,
                    Description: "Posts endpoint renamed to articles",
                    Endpoint:    "/posts -> /articles",
                    Breaking:    true,
                },
                {
                    Type:        ChangeTypeAdded,
                    Description: "Added user roles field to response",
                    Endpoint:    "GET /users",
                    Breaking:    false,
                },
                {
                    Type:        ChangeTypeAdded,
                    Description: "Added PATCH method for partial updates",
                    Endpoint:    "PATCH /users/{id}",
                    Breaking:    false,
                },
            },
        },
        {
            Version:     "1.2.0",
            Date:        "2024-02-15",
            Description: "Minor release with new features",
            Changes: []Change{
                {
                    Type:        ChangeTypeAdded,
                    Description: "Added pagination support",
                    Endpoint:    "GET /users",
                    Breaking:    false,
                },
                {
                    Type:        ChangeTypeAdded,
                    Description: "Added filtering by role",
                    Endpoint:    "GET /users",
                    Breaking:    false,
                },
                {
                    Type:        ChangeTypeDeprecated,
                    Description: "name field deprecated, use first_name and last_name",
                    Endpoint:    "GET /users/{id}",
                    Breaking:    false,
                },
            },
        },
        {
            Version:     "1.1.0",
            Date:        "2024-01-15",
            Description: "Security and bug fixes",
            Changes: []Change{
                {
                    Type:        ChangeTypeSecurity,
                    Description: "Fixed SQL injection vulnerability in search",
                    Endpoint:    "GET /users",
                    Breaking:    false,
                },
                {
                    Type:        ChangeTypeFixed,
                    Description: "Fixed pagination returning incorrect total count",
                    Endpoint:    "GET /users",
                    Breaking:    false,
                },
            },
        },
        {
            Version: "1.0.0",
            Date:    "2024-01-01",
            Changes: []Change{
                {
                    Type:        ChangeTypeAdded,
                    Description: "Initial API release",
                    Breaking:    false,
                },
            },
        },
    },
}

// ServeChangelog returns HTTP handler for changelog
func ServeChangelog() http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(APIChangelog)
    }
}

// ServeMarkdownChangelog returns changelog as markdown
func ServeMarkdownChangelog() http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Type", "text/markdown; charset=utf-8")

        var md strings.Builder
        md.WriteString("# " + APIChangelog.Title + "\n\n")

        for _, release := range APIChangelog.Releases {
            md.WriteString(fmt.Sprintf("## [%s] - %s\n\n", release.Version, release.Date))

            if release.Description != "" {
                md.WriteString(release.Description + "\n\n")
            }

            // Group changes by type
            grouped := groupByType(release.Changes)
            for _, changeType := range []ChangeType{
                ChangeTypeAdded, ChangeTypeChanged, ChangeTypeDeprecated,
                ChangeTypeRemoved, ChangeTypeFixed, ChangeTypeSecurity,
            } {
                if changes, ok := grouped[changeType]; ok {
                    md.WriteString(fmt.Sprintf("### %s\n\n", titleCase(string(changeType))))
                    for _, change := range changes {
                        prefix := "-"
                        if change.Breaking {
                            prefix = "- **BREAKING:**"
                        }
                        if change.Endpoint != "" {
                            md.WriteString(fmt.Sprintf("%s %s (`%s`)\n", prefix, change.Description, change.Endpoint))
                        } else {
                            md.WriteString(fmt.Sprintf("%s %s\n", prefix, change.Description))
                        }
                    }
                    md.WriteString("\n")
                }
            }
        }

        w.Write([]byte(md.String()))
    }
}

func groupByType(changes []Change) map[ChangeType][]Change {
    grouped := make(map[ChangeType][]Change)
    for _, c := range changes {
        grouped[c.Type] = append(grouped[c.Type], c)
    }
    return grouped
}

// titleCase uppercases the first rune. Deliberately not strings.Title, which
// has been deprecated since Go 1.18 because its word-boundary rule mishandles
// Unicode punctuation. For a fixed set of ASCII category names this is all
// that is needed. If you ever title-case user-supplied or localized text,
// reach for golang.org/x/text/cases with an explicit language tag instead.
func titleCase(s string) string {
    if s == "" {
        return s
    }
    r := []rune(s)
    r[0] = unicode.ToUpper(r[0])
    return string(r)
}
```

### Junior -> FAANG: what a changelog is for and how to keep it honest

A changelog answers one question for your API consumers. "What changed since I last integrated, and do I need to do anything." Every other decision about format, storage, and publication flows from that single purpose. The code above stores entries in Go, which is convenient for serving JSON and markdown from the same source. The common alternative is a `CHANGELOG.md` file at the repo root in the Keep a Changelog format, which groups entries under Added, Changed, Deprecated, Removed, Fixed, Security headings per version. Pick one and stick with it. Do not fork the changelog into a wiki, a Notion page, the README, and a Slack channel. Consumers will find the wrong one and file angry tickets.

Keep a Changelog (keepachangelog.com) is the baseline format every junior should read. The rules are short. Each entry belongs to a released version. Each version has a date. Entries are grouped by the six standard headings. Unreleased changes live under an `[Unreleased]` section at the top that becomes the next release when you tag. Breaking changes are called out explicitly. That is the whole format. The `ChangeType` constants in the code above map directly to those headings.

Semantic versioning (semver) interacts with the changelog in a specific way. Major version bumps (1.x.x -> 2.x.x) are reserved for breaking changes. Minor bumps are new backwards-compatible features. Patch bumps are bug fixes. For APIs, "breaking" means "an existing client would stop working after the change," which is stricter than it sounds. Adding a required request field is breaking. Removing any response field is breaking. Changing the type of a response field is breaking. Adding a new enum value is arguably breaking (strict parsers reject unknown values, loose parsers accept them). Document your policy. Stripe's policy in practice is that breaking changes never land within a pinned version, and versions are dated rather than numbered. GitHub's REST API takes the header-versioning route with dated versions and long overlap windows. Do not copy either number without checking their current published policy. Copy the shape: a written, public commitment that tells consumers exactly what you will and will not do to them, and pick the one matching your audience's tolerance.

Worked example. You are on-call and a customer reports their integration broke this morning. You check the changelog endpoint. The latest release at 3 AM says "Fixed: corrected pagination total_count to exclude soft-deleted records." Not flagged as breaking. But the customer's dashboard was reading `total_count` to compute billing. You now own a P1 incident. The lesson is that "bug fix" is not the same as "non-breaking." Any change to response semantics, even a correction of a previous bug, can break downstream consumers who encoded the old behavior as truth. The guardrail is to run every proposed change through the question "could a reasonable client break on this." If yes, flag it breaking and gate it behind a version bump or a feature flag, regardless of whether you consider it a fix.

First-job context. You will be asked to "update the changelog for this release." The right workflow is to look at every PR merged since the last tag, classify each one (Added / Changed / Deprecated / Removed / Fixed / Security), mark breaking changes, and group them. Conventional Commits (feat, fix, docs, chore, BREAKING CHANGE footer) makes this mechanical. Tools like `git-cliff`, `release-please`, and `semantic-release` consume Conventional Commits and generate the changelog automatically. Most teams at FAANG scale use one of those three. Learn the commit format and the automation follows.

Interview entry-point. Expect "walk me through how you would announce a breaking change," "what is the difference between deprecation and removal," and "how do you decide when to bump the major version." The deprecation-versus-removal answer is the meaningful one. Deprecation is a signal sent at least one full release cycle before removal, accompanied by a migration guide, a `Deprecation` HTTP response header per RFC 9745, a `Sunset` header per RFC 8594 giving the removal date, and ideally usage telemetry that you share with affected consumers. Removal is the final act. If you remove without deprecating, you are breaking trust, and trust in an API is the product.

### Senior @ FAANG: changelog governance, release notes as a product, and automation in 2026

Staff-level framing. The changelog is not a markdown file. It is a governance contract between the API team and its consumers. Running it well requires four layers. A classification taxonomy that is enforced in CI. An authoring workflow that produces entries as part of each PR. A publication pipeline that distributes the changelog to multiple audiences through multiple channels. A feedback loop that measures whether consumers actually read and act on it. Miss any layer and the changelog decays into theater.

Classification taxonomy. Keep a Changelog gives you six categories. Add a seventh axis orthogonal to those six: breaking versus non-breaking. The combination is your classification matrix. Enforce it in CI with a PR template that requires the author to pick a category and flag breaking status before the merge button is enabled. Danger.js, Renovate, and custom GitHub Actions can implement this. The reason to enforce is that authors systematically under-classify breaking changes when left to their judgment. Tooling that asks "does this PR change response shapes, add required fields, remove fields, tighten validation, or change status codes" catches cases where the author did not think of it.

The real definition of breaking depends on your strictness contract with clients. If your public contract says "we add enum values freely, please use loose parsers," then adding an enum value is non-breaking. If your public contract says nothing, you must assume strict parsers and treat it as breaking. Document the contract explicitly in a "Compatibility" section of your API reference. This single sentence prevents more incidents than most other engineering effort combined.

Authoring workflow. Three patterns dominate. Pattern one, inline in-PR: each PR adds a `.changes/` fragment file (YAML or markdown) describing the entry, and a release tool concatenates them at tag time. Tools that implement this are `changie`, `towncrier`, and `git-cliff` in fragment mode. Pattern two, commit-message driven: Conventional Commits plus `release-please` (Google-maintained, very mature) or `semantic-release` (node-based, widely used). The release bot opens a release PR with the generated changelog and bumped version. Merge the PR, the tag goes out, the changelog publishes. Pattern three, code-first like the example above: entries live as Go structs committed alongside the release. Rare in practice because it couples the changelog to the service binary. Patterns one and two dominate production use at scale. Pick pattern one if your team is comfortable with explicit fragments and wants full prose control. Pick pattern two if your team already uses Conventional Commits and trusts automation.

Publication pipeline. A single markdown file in the repo is the minimum viable output. The next tier adds a rendered changelog page in the docs portal (Bump.sh builds this natively, Redocly and Scalar render it, Mintlify and Readme have first-class changelog products). The tier above that adds an RSS or Atom feed at a stable URL so automation in consumer systems can subscribe and file internal tickets on breaking changes. Stripe publishes an RSS feed. Twilio does too. Cloudflare publishes both RSS and a public JSON file. Adding RSS is a twenty-line job and a disproportionate win for enterprise consumers who have internal compliance processes triggered by API changes. The tier above RSS is email notifications targeted by API surface area. A customer subscribed to `/users/*` gets a different email than a customer subscribed to `/billing/*`. Segment and Readme support targeted changelog emails. Building this in-house is a month of work and almost always worth it once you cross a hundred customers.

Breaking-change classification, formalized. Use `oasdiff` (github.com/oasdiff/oasdiff, formerly under the Tufin org, which still redirects) or `openapi-diff` in CI on every PR. The tool compares the current spec against the last released spec and emits a list of changes with severity (breaking, non-breaking, warning). Fail the build on breaking changes unless the PR has a `breaking-change-approved` label. Require the label to come from a CODEOWNERS-approved reviewer. Pair this with `buf breaking` for any protobuf contracts. The combination makes it mechanically impossible to ship a breaking change without human awareness, which is the whole point.

Migration guides. Every breaking change ships with a migration guide. That guide lives at a stable URL. It contains a before-and-after code example in every language with a first-party SDK. It lists the deprecation date and the removal date. It explains the reason for the change. It links to a support channel. Stripe's migration guides are the gold standard here too. They read like product documentation, not release notes. The cost of writing a good migration guide is hours. The cost of not writing one is thousands of support tickets and a long tail of unmigrated customers who eventually churn. Never cut this corner.

Deprecation mechanics via HTTP. RFC 9745 defines the `Deprecation` response header, whose value is an `@`-prefixed Unix timestamp marking when deprecation began, not the string `true`. RFC 8594 defines the `Sunset` response header, whose value is an HTTP-date for the removal. Emit both on every response from a deprecated endpoint. Log the caller's User-Agent and a hash of their API key (never the key itself) so you can proactively reach out to the heaviest users. For pointing at the migration guide, skip the invented `X-Deprecation-Link` and use the `Link` header (RFC 8288) with the `deprecation` relation defined by RFC 8631. `Sunset` likewise has its own `sunset` link relation registered by RFC 8594, so `Link: <https://.../guide>; rel="deprecation"` and a `sunset` relation are the standards-compliant spellings. A custom `X-` header is one more thing every client must special-case, and registered relations already exist precisely so they do not have to.

SDK regeneration automation. Every changelog entry that affects the API surface triggers SDK regeneration. The pipeline looks like: spec change merges to main -> spec is tagged -> Stainless or Fern receives a webhook -> SDKs are regenerated across all target languages -> SDKs open PRs in their own repos -> CI runs contract tests -> on green, SDKs auto-publish to npm, PyPI, Go module proxy, Maven Central, RubyGems, and Packagist with a matching version. The changelog entry for the service release should include a line "SDK versions released: typescript@3.2.0, python@3.2.0, go@v3.2.0" so consumers can pin exactly. This is the closed loop most mid-tier companies never fully build, and it is the single largest factor in whether an API feels professional to integrators.

Release notes as a first-class artifact. The changelog is machine-readable. Release notes are human-readable. They are different artifacts serving different audiences. Release notes are narrative. They explain why a feature was built, who it is for, what the migration story looks like, and what is coming next. They are written by a product manager or technical writer, not auto-generated from commits. Stripe, Linear, GitHub, and Vercel all publish release notes as a product surface separate from their raw changelog. This is worth emulating for any externally-consumed API past the prototype phase.

Landscape note. A modern production tooling stack for changelog governance looks roughly like this. Conventional Commits as the authoring convention. `release-please` or `changie` for generation. `oasdiff` in CI for breaking-change detection. Bump.sh, Readme, or Mintlify for the rendered portal with RSS. Stainless or Fern for SDK regeneration on release. A status page (Statuspage, Instatus, Better Stack) linked from every changelog entry that caused a behavioral change. A support-ticket tracker that auto-links to the relevant changelog entry when a customer files an incident citing a date range. That pipeline is what "operational maturity around API changes" looks like at L5 and above. Anything less is technical debt you will eventually pay with incident hours and customer churn.

---
