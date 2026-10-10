## 17.1 Project Layout Standards

Much of the Go community has settled on a common project layout, usually called the "standard layout" after the popular `golang-standards/project-layout` repository. Be clear about what that repo is: it is a community project, not a Go team artifact, despite the `golang-standards` organization name suggesting otherwise. Go team members including Russ Cox have publicly said it is not a standard and that they had no hand in it, and its own README now carries a caveat saying the same. The closest thing to official guidance is [go.dev/doc/modules/layout](https://go.dev/doc/modules/layout), and it is far more modest: it describes a few small layouts for common cases (a single package, a command, a module with both) and never mentions `pkg/` at all.

So read what follows as the dominant convention, not as a rule. Adopt what fits, skip what does not, and be suspicious of any directory you cannot justify.

### Why Project Structure Matters

The structure of a Go project shapes every aspect of daily development, from how quickly a new engineer can navigate the codebase to how easily bugs can be isolated and fixed. A well-organized layout enforces clear boundaries, reduces cognitive overhead, and keeps teams productive as the project grows.

```
┌──────────────────────────────────────────────────────────────────────┐
│                   Impact of Good vs Bad Structure                    │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Good Structure                      Bad Structure                   │
│  ──────────────                      ─────────────                   │
│                                                                      │
│  ✓ New team members onboard fast     ✗ "Where does this go?"         │
│  ✓ Clear dependency direction        ✗ Circular imports everywhere   │
│  ✓ Easy to test in isolation         ✗ Tests require full system     │
│  ✓ Refactoring is localized          ✗ Changes ripple everywhere     │
│  ✓ Teams can work independently      ✗ Merge conflicts constantly    │
│  ✓ Code review is focused            ✗ PRs touch many packages       │
│  ✓ Fast time to first contribution   ✗ Weeks before a safe first PR  │
│  ✓ Bugs localize to one package      ✗ Bugs could live anywhere      │
└──────────────────────────────────────────────────────────────────────┘
```

### The Community Layout, In Full

The directory tree below is the maximal version of the community convention. It separates executable entry points (`cmd/`), private business logic (`internal/`), and reusable library code (`pkg/`), giving each concern a predictable home. Almost no project needs all of it on day one. Treat it as a menu.

```
project/
├── cmd/                    # Main applications
│   ├── api/
│   │   └── main.go
│   └── worker/
│       └── main.go
├── internal/               # Private code
│   ├── api/
│   │   ├── handler/
│   │   ├── middleware/
│   │   └── router.go
│   ├── domain/
│   │   ├── user/
│   │   └── order/
│   └── platform/
│       ├── database/
│       └── cache/
├── pkg/                    # Public libraries
│   └── validator/
├── api/                    # API definitions
│   └── openapi.yaml
├── configs/                # Configuration files
│   ├── config.yaml
│   └── config.prod.yaml
├── scripts/                # Build/deploy scripts
│   ├── setup.sh
│   └── deploy.sh
├── deployments/            # Deployment configs
│   ├── docker/
│   └── kubernetes/
├── docs/                   # Documentation
├── test/                   # Integration tests
├── .github/                # GitHub workflows
├── go.mod
├── go.sum
├── Makefile
└── README.md
```

### Directory Purposes

**cmd/**: Entry points for each executable. Each subdirectory is one binary:

```go
// cmd/api/main.go
package main

import (
    "myproject/internal/api"
    "myproject/internal/platform/database"
)

func main() {
    db := database.Connect()
    server := api.NewServer(db)
    server.Run()
}
```

**internal/**: the one rule the toolchain enforces. A package under `internal/` can be imported only by code in the directory tree rooted at `internal/`'s parent. For a module with `internal/` at its root, that means the whole module and nothing outside it. Note that the rule is about the import-path tree, not about the module: `internal/` does not have to sit at the module root. A package at `example.com/m/foo/internal/token` is importable from anywhere under `example.com/m/foo/` and nowhere else, which lets you scope privacy to a subtree rather than to the whole module. Use it for business logic:

```go
// internal/domain/user/service.go
package user

type Service struct {
    repo Repository
}

func (s *Service) Create(u *User) error {
    if err := u.Validate(); err != nil {
        return err
    }
    return s.repo.Save(u)
}
```

**pkg/**: code you intend other projects to import. Use sparingly, and see the controversy below:

```go
// pkg/validator/email.go
package validator

import "net/mail"

func IsValidEmail(email string) bool {
    _, err := mail.ParseAddress(email)
    return err == nil
}
```

### When to Use Each Directory

| Directory | Use When |
|-----------|----------|
| `cmd/` | Creating executable binaries |
| `internal/` | Code must not be imported outside its subtree (the only entry here the toolchain enforces) |
| `pkg/` | Rarely. Only if you want a visible public/private split and cannot get it from `internal/` alone |
| `api/` | OpenAPI, protobuf definitions |
| `configs/` | Configuration files (not secrets) |
| `scripts/` | Automation scripts |

### The `pkg/` Controversy

`pkg/` is the part of the community layout with the least to recommend it. The standard library does not use it. Go's own official layout guidance does not mention it. Members of the Go team have argued against it in public: the case is simply that `pkg/` adds a path element that carries no information, since every directory in a Go project holds packages. `github.com/you/proj/pkg/validator` says nothing that `github.com/you/proj/validator` does not, and it is longer. `internal/` earns its element because the toolchain acts on it. `pkg/` does not.

Large projects that use it, Kubernetes most visibly, largely do so for historical reasons predating modules. New Go projects commonly skip `pkg/` and put exported packages at the module root.

When to use `pkg/`:

- The project has both public and internal code, and you want the distinction visible from the directory structure.
- Your org's convention requires it (consistency matters).

When to skip `pkg/`:

- The project is a single application with all code in `internal/`.
- The project is a library where everything is public at the module root.
- You are starting a new project without a strong reason to use `pkg/`.

There is no correct answer. Pick one per org and be consistent.

### Staff Lens: Layout Is a Team Contract

The "correct" layout for your team is the one your team uses consistently. Debating layout religion wastes time. Pick a defensible option, document it, apply it to every service, and update the doc when the convention evolves. The cost of inconsistency across twenty services is far higher than the cost of picking one imperfect layout.

---
