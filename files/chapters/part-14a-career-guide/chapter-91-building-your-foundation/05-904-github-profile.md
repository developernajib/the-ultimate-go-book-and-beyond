## 91.4 GitHub Profile

### Making GitHub Work for You

Your GitHub profile is the one place where hiring managers and technical interviewers can see your actual code before they ever meet you. Unlike your resume, which describes what you did, GitHub shows how you think, how you write code, and how you communicate technical decisions through documentation and commit messages. A well-curated GitHub profile with a few excellent repositories is far more impressive than a profile with dozens of abandoned or undocumented projects.

```
┌──────────────────────────────────────────────────────────────────┐
│                  GITHUB PROFILE OPTIMIZATION                     │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  PROFILE README (github.com/username/username)                   │
│  • Brief intro                                                   │
│  • What you're working on                                        │
│  • Technologies you use                                          │
│  • How to reach you                                              │
│                                                                  │
│  PINNED REPOSITORIES (Choose 6)                                  │
│  • Your best work                                                │
│  • Complete, documented projects                                 │
│  • Variety of technologies                                       │
│  • Include description for each                                  │
│                                                                  │
│  CONTRIBUTION GRAPH                                              │
│  • Shows activity (consistency matters)                          │
│  • Private contributions count (enable in settings)              │
│                                                                  │
│  REPOSITORY QUALITY                                              │
│  • Meaningful commit messages                                    │
│  • Clear README files                                            │
│  • Proper documentation                                          │
│  • Tests included                                                │
│  • License specified                                             │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Sample Profile README

GitHub supports a special repository (named the same as your username) whose README.md appears directly on your profile page. This is prime real estate for making a strong first impression. The example below shows how to introduce yourself, highlight your best work, list your technologies, and provide contact information in a format that is both visually appealing and easy to scan quickly.

```markdown
# Hi, I'm Alex Chen 👋

Senior Software Engineer at Stripe, passionate about distributed
systems and developer tools.

## What I'm working on
- 🔨 Building payment infrastructure at scale
- 📝 Writing about Go and system design on my [blog](link)
- 🌱 Learning Rust in my spare time

## Tech I love
![Go](https://img.shields.io/badge/-Go-00ADD8?style=flat&logo=go&logoColor=white)
![Kubernetes](https://img.shields.io/badge/-Kubernetes-326CE5?style=flat&logo=kubernetes&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/-PostgreSQL-336791?style=flat&logo=postgresql&logoColor=white)

## Featured Projects
- **[distributed-cache](link)** - Redis-compatible cache in Go
- **[ratelimiter](link)** - Production-ready rate limiter library

## Get in touch
- LinkedIn: [alexchen](link)
- Email: alex@email.com
- Blog: [alexchen.dev](link)
```

### Projects That Impress

Not all GitHub projects carry equal weight with hiring managers. The projects that make the strongest impression are ones that demonstrate real engineering judgment: complete implementations with proper documentation, tests, error handling, and evidence of thoughtful design decisions. Tutorial follow-alongs and incomplete experiments actually hurt your profile because they signal a lack of follow-through. Focus your energy on a small number of polished, purposeful projects rather than a large number of rough drafts.

```
GOOD PORTFOLIO PROJECTS:

1. PRODUCTION-QUALITY TOOLS
   ✓ Complete documentation
   ✓ Test coverage
   ✓ CI/CD pipeline
   ✓ Proper error handling
   Example: Rate limiter library with Redis backend

2. SYSTEM DESIGN IMPLEMENTATIONS
   ✓ Working versions of interview classics
   ✓ Shows you understand the concepts
   Example: Distributed key-value store, URL shortener

3. OPEN SOURCE CONTRIBUTIONS
   ✓ Contributions to real projects
   ✓ Merged PRs to notable repos
   Example: Bug fixes or features in Go ecosystem projects

4. SIDE PROJECTS THAT SOLVE REAL PROBLEMS
   ✓ Tools you actually use
   ✓ Demonstrates end-to-end thinking
   Example: CLI tool for your workflow, monitoring dashboard

AVOID:
✗ Tutorial follow-alongs (every bootcamp grad has these)
✗ Incomplete projects
✗ Projects without READMEs
✗ Copy-pasted code
```

### Junior → FAANG: GitHub as a Finished Work Portfolio

The biggest GitHub mistake junior engineers make is confusing activity with quality. A profile full of commits to unfinished projects, tutorial follow-alongs, and forked repositories with no original contributions signals that you start things without finishing them. This is the opposite of what a hiring manager wants to see.

The goal is not to have a lot of repositories. It is to have two or three repositories that demonstrate you can take a problem from idea to a finished, documented, deployable solution. For Go specifically: the project should use idiomatic Go patterns (no unnecessary frameworks, table-driven tests, proper error handling, a Makefile or `go generate` usage), have a README that explains the problem and design decisions, and show evidence of real usage (even if that means you actually used it yourself).

Pinned repositories are the most important part of the profile. Pin exactly the repositories you want a hiring manager to evaluate. Unpin everything else. The six pinned slots should tell a coherent story about your technical focus, not display everything you have ever built.

For Go roles specifically: a small but complete CLI tool, a well-tested HTTP service with middleware and proper shutdown handling, or a library with a clean API and full test coverage will all read as stronger signals than a large but messy web application in a language you are not targeting.

### Senior @ FAANG: GitHub as a Record of Technical Judgment

At senior and staff level, GitHub is evaluated differently. Hiring managers are not looking to verify that you can write code. They are looking for evidence of how you think about design, documentation, and collaboration at scale.

The most compelling senior GitHub profiles share a few characteristics. First, they include at least one project with meaningful documentation beyond a basic README: architecture decision records, design documents, contributor guides, or API documentation that reflects genuine thought about how others will use and extend the system. Second, they show evidence of code review discipline in open-source contributions: PR comments that raise substantive design concerns, not just style corrections. Third, they demonstrate restraint: a well-maintained, purposeful set of pinned repositories with clear purpose rather than a sprawling collection of experiments.

For Go engineers at senior level, contributing meaningfully to ecosystem projects carries significant weight. A PR to the Go standard library, a well-maintained package with real users and a thoughtful changelog, or contributions to a CNCF project in Go all signal that your technical judgment has been validated by a community, not just by your own team. This is a qualitatively different signal than solo projects, because it demonstrates that peers with no obligation to be kind have reviewed your work and found it worth merging.

The ADR pattern applies to GitHub at senior level: if you have made significant architectural decisions in a project, write them down in the repository as decision records. A hiring committee reviewer who opens your repository and finds a `/docs/decisions/` directory with three well-reasoned ADRs will immediately understand that this is a person who thinks at the right level of abstraction for staff-level work.

---
