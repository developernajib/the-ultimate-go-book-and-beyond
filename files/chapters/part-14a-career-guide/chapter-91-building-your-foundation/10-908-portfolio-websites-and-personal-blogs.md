## 91.9 Portfolio Websites and Personal Blogs

### Why Build a Personal Website

A personal website gives you a platform you fully control, where you can present your work, your writing, and your story without the constraints of any third-party platform. Most candidates do not have one, which means having even a simple, well-maintained site immediately sets you apart. It also serves as proof that you can build and deploy something on your own, which is a signal hiring managers notice even if they never say it explicitly.

```
┌───────────────────────────────────────────────────────────────────┐
│              PERSONAL WEBSITE VALUE PROPOSITION                   │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  DIFFERENTIATION:                                                 │
│  ├── Most candidates don't have one                               │
│  ├── Shows technical ability (you built it)                       │
│  ├── Demonstrates initiative                                      │
│  └── Provides space for depth that resume can't show              │
│                                                                   │
│  CONTROL:                                                         │
│  ├── You own your content (not LinkedIn/Medium)                   │
│  ├── Full customization of presentation                           │
│  ├── SEO for your name                                            │
│  └── No platform algorithm dependencies                           │
│                                                                   │
│  CREDIBILITY:                                                     │
│  ├── Technical writing demonstrates communication                 │
│  ├── Project showcases show depth                                 │
│  ├── "About" page tells your story your way                       │
│  └── Contact form makes you reachable                             │
│                                                                   │
│  ROI FOR CAREER:                                                  │
│  ├── Inbound recruiter contacts                                   │
│  ├── Conference talk invitations                                  │
│  ├── Consulting opportunities                                     │
│  └── Industry recognition                                         │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### Building Your Developer Portfolio

A strong developer portfolio website needs a clear structure that guides visitors from your introduction to your best work to a way to contact you. Each page serves a distinct purpose in telling your professional story, and the architecture below covers what to include on each one. You do not need to build everything at once. Start with a home page and projects page, then expand as you create more content.

```markdown
# Portfolio Website Architecture

## Essential Pages:

### 1. HOME PAGE
Purpose: Hook and quick intro
Content:
- Your name and title
- One-line value proposition
- Featured work (2-3 highlights)
- Navigation to other sections

Example:
"""
Alex Chen
Senior Go Engineer | Distributed Systems

I build payment systems that handle billions of dollars reliably.
Currently at Stripe, previously Uber.

Featured: Payment Routing Engine | Real-time Fraud Detection
"""

### 2. ABOUT PAGE
Purpose: Tell your story
Content:
- Professional journey
- What you're passionate about
- What you're looking for
- Human elements (hobbies, interests)

Structure:
"""

## Who I Am
[Professional identity and expertise]

## My Journey
[Career narrative - how you got here]

## What Drives Me
[Values, interests, what you care about]

## Currently
[What you're working on now]
"""

### 3. PROJECTS PAGE
Purpose: Showcase your work
For each project:
- Title and one-line description
- Problem it solves
- Technologies used
- Key metrics or outcomes
- Link to GitHub/demo

### 4. BLOG/WRITING PAGE
Purpose: Demonstrate expertise
- Technical deep dives
- Problem-solving stories
- Industry perspectives
- Tutorial content

### 5. CONTACT PAGE
Purpose: Make it easy to reach you
- Email (or contact form)
- LinkedIn link
- GitHub link
- Twitter/X (if professional)
```

### Technical Implementation Options

As a Go engineer, building your portfolio site in Go is both practical and a great signal to potential employers. The example below shows a simple static site generator that reads Markdown blog posts and renders them with Go templates. You can extend this to suit your needs, or use established tools like Hugo (which is itself written in Go). The key point is that your portfolio site doubles as a portfolio project, so make it clean and well-structured.

```go
// Example: Simple Go-based personal site with static generation

package main

import (
    "html/template"
    "log"
    "net/http"
    "os"
    "path/filepath"

    "github.com/russross/blackfriday/v2"
)

// Site configuration
type Site struct {
    Title       string
    Description string
    Author      string
    BaseURL     string
    Posts       []Post
    Projects    []Project
}

type Post struct {
    Title     string
    Slug      string
    Date      string
    Content   template.HTML
    Summary   string
    Tags      []string
}

type Project struct {
    Name        string
    Description string
    URL         string
    GitHub      string
    Tech        []string
    Featured    bool
}

// Render markdown to HTML
func renderMarkdown(content []byte) template.HTML {
    html := blackfriday.Run(content)
    return template.HTML(html)
}

// Load posts from markdown files
func loadPosts(dir string) ([]Post, error) {
    var posts []Post

    err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
        if err != nil {
            return err
        }
        if filepath.Ext(path) != ".md" {
            return nil
        }

        content, err := os.ReadFile(path)
        if err != nil {
            return err
        }

        // Parse frontmatter and content
        // (simplified - use a proper frontmatter parser in production)
        post := Post{
            Title:   info.Name(),
            Slug:    filepath.Base(path[:len(path)-3]),
            Content: renderMarkdown(content),
        }
        posts = append(posts, post)
        return nil
    })

    return posts, err
}

func main() {
    // Load site content
    posts, _ := loadPosts("content/posts")

    site := Site{
        Title:       "Alex Chen",
        Description: "Senior Go Engineer building distributed systems",
        Author:      "Alex Chen",
        BaseURL:     "https://alexchen.dev",
        Posts:       posts,
        Projects: []Project{
            {
                Name:        "distributed-cache",
                Description: "Redis-compatible distributed cache in Go",
                GitHub:      "https://github.com/alexchen/distributed-cache",
                Tech:        []string{"Go", "Redis Protocol", "Raft"},
                Featured:    true,
            },
        },
    }

    // Load templates
    tmpl := template.Must(template.ParseGlob("templates/*.html"))

    // Routes
    http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        tmpl.ExecuteTemplate(w, "home.html", site)
    })

    http.HandleFunc("/blog/", func(w http.ResponseWriter, r *http.Request) {
        slug := r.URL.Path[len("/blog/"):]
        for _, post := range site.Posts {
            if post.Slug == slug {
                tmpl.ExecuteTemplate(w, "post.html", post)
                return
            }
        }
        http.NotFound(w, r)
    })

    log.Println("Starting server on :8080")
    log.Fatal(http.ListenAndServe(":8080", nil))
}
```

### Hosting Options for Developers

Where you host your portfolio site matters both practically and as a signal to employers. Free options like GitHub Pages and Vercel are perfectly appropriate for most engineers, while self-hosting on cloud infrastructure demonstrates deeper DevOps skills. The decision matrix below compares the most popular options by cost, ease of use, and the impression they make on hiring managers at different career levels.

```markdown
# Portfolio Hosting Decision Matrix

## FREE OPTIONS:

### GitHub Pages
Best for: Static sites, developers familiar with Git
Pros:
- Free with custom domain
- Deploys from Git push
- Great for Jekyll/Hugo sites
- Shows you know Git

Cons:
- Static only (no server-side)
- Build limitations

### Vercel
Best for: React/Next.js sites
Pros:
- Generous free tier
- Automatic deploys from Git
- Edge functions available
- Great DX

Cons:
- Tied to their platform

### Netlify
Best for: Static sites with forms/functions
Pros:
- Easy setup
- Forms handling
- Functions support
- CDN included

Cons:
- Can get expensive at scale

### Cloudflare Pages
Best for: Performance-focused sites
Pros:
- Fast CDN
- Workers integration
- Generous limits

Cons:
- Newer, less ecosystem

## PAID OPTIONS:

### DigitalOcean/AWS/GCP
Best for: Learning infrastructure
Pros:
- Full control
- Can host anything
- Resume signal ("I can deploy")

Cons:
- More work to set up
- Costs money (but cheap)

### fly.io / Render
Best for: Go applications
Pros:
- Easy container deployment
- Good free tiers
- Shows modern tooling

Cons:
- Can scale in cost

## RECOMMENDATION BY LEVEL:

Junior: GitHub Pages or Netlify (show you can deploy)
Mid: Vercel or fly.io (show you know modern tooling)
Senior: Self-hosted on AWS/GCP (show infrastructure skills)
```

### Junior → FAANG: What a Portfolio Site Actually Needs to Do

The goal of a portfolio site at early career is to provide a coherent landing page that a recruiter or hiring manager reaches after seeing your LinkedIn or GitHub. It does not need to be elaborate. It needs to load quickly, present your name and focus area immediately, link to your two or three best projects with brief descriptions of the problem solved and the outcome, and include your contact information.

The most common mistake is spending two weeks building the portfolio site instead of the actual portfolio content. A simple static site built in a weekend that links to two finished, documented projects is more effective than a beautifully designed site built over a month that showcases unfinished work. Build the content first. Build the site second.

One practical signal for Go engineers: deploy your portfolio site using a Go-based static site generator or a small Go HTTP server, and document that choice in the site itself. This turns the portfolio site itself into a portfolio artifact.

### Senior @ FAANG: Portfolio as Technical Narrative Architecture

At senior level, a portfolio site serves a fundamentally different purpose. It is not a landing page for recruiters. It is the canonical location for the long-form technical reasoning that demonstrates staff-level judgment. This means the site should host your most substantive writing: architectural case studies from your career (appropriately anonymized), technical positions you have taken publicly and defended, and design analyses of systems you have designed or evaluated.

The blog component of a senior portfolio site is where ADR-style reasoning becomes public. A post that walks through a significant technical decision you made, the alternatives you considered, the criteria you used to evaluate them, and what you learned after shipping, is one of the strongest possible signals of staff-level thinking. It demonstrates that you can articulate complex tradeoffs for a broad technical audience, which is exactly what staff engineers do internally for their organizations.

Infrastructure choice for the senior site is itself a signal. Running a small Go service on a real cloud provider with proper observability (structured logging, metrics, health endpoints) and a documented deployment process is a stronger signal than a hosted static site. It demonstrates that you practice what you advocate, that you treat your own infrastructure with the same care you would apply to production systems.

---
