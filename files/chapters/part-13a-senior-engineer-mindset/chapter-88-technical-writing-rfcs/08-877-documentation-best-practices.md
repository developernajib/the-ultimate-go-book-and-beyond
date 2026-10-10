## 88.7 Documentation Best Practices

### The Documentation Quadrant

Not all documentation serves the same purpose, and writing the wrong type of document for the situation is a common source of frustration. The Documentation Quadrant (based on Daniele Procida's Diataxis framework) divides documentation into four types along two axes: whether the reader is studying or working, and whether they need practical steps or theoretical understanding. Tutorials teach beginners through guided exercises, how-to guides solve specific problems, explanations build deep understanding, and reference docs provide quick lookup information. Knowing which quadrant your document belongs to helps you write content that actually serves your reader's needs.

```
┌──────────────────────────────────────────────────────────────────┐
│                DOCUMENTATION TYPES                               │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│           STUDYING ────────────────────────── WORKING            │
│                                                                  │
│       ┌─────────────────┐     ┌─────────────────┐                │
│   P   │   TUTORIALS     │     │  HOW-TO GUIDES  │   P            │
│   R   │                 │     │                 │   R            │
│   A   │ Learning-       │     │ Problem-        │   A            │
│   C   │ oriented        │     │ oriented        │   C            │
│   T   │ "Getting        │     │ "How do I..."   │   T            │
│   I   │  Started"       │     │                 │   I            │
│   C   └─────────────────┘     └─────────────────┘   C            │
│   A                                                  A           │
│   L ─────────────────────────────────────────────── L            │
│       ┌─────────────────┐     ┌─────────────────┐                │
│   T   │  EXPLANATION    │     │   REFERENCE     │   T            │
│   H   │                 │     │                 │   H            │
│   E   │ Understanding-  │     │ Information-    │   E            │
│   O   │ oriented        │     │ oriented        │   O            │
│   R   │ "Why does       │     │ "What are       │   R            │
│   E   │  this work?"    │     │  the options?"  │   E            │
│   T   └─────────────────┘     └─────────────────┘   T            │
│   I                                                  I           │
│   C                                                  C           │
│   A                                                  A           │
│   L                                                  L           │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### README Template

A README is often the first document someone reads when they encounter your project, so it needs to answer the most common questions quickly: what does this project do, how do I run it, and how do I contribute? The template below follows a top-down structure that lets readers get started in seconds (Quick Start) while also providing deeper information (Configuration, Architecture) for those who need it. A good README respects the reader's time by putting the most frequently needed information at the top.

````markdown
# Project Name

One-paragraph description of what this project does.

## Quick Start

A quick-start section exists to collapse the gap between "I just read this RFC" and "I have something running locally." Keeping the path to a single command removes the most common reason engineers skip trying a proposal hands-on, namely the fear of a long, error-prone setup. The command below starts the server with its default configuration, which is sufficient to exercise the core behavior described in this document.

```bash
# How to run this in 30 seconds
go run cmd/server/main.go
```

## Installation

Detailed installation steps.

## Usage

Common usage examples.

## Configuration

Environment variables and configuration options.

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `8080` |
| `DB_URL` | Database URL | required |

## Development

How to set up for development.

```bash
make dev
```

## Testing

Including a single `make test` target in the RFC template enforces the expectation that every proposal ships with a runnable test suite from day one, not as an afterthought. The `Makefile` target abstracts over whatever combination of `go test`, race-detector flags (`-race`), and coverage thresholds the project requires, so contributors don't need to memorize project-specific flags and CI runs the exact same suite as local development.

```bash
make test
```

## Deployment

How to deploy this service.

## Architecture

Brief architecture overview with diagram.

## Contributing

How to contribute.

## License

License information.
````

---
