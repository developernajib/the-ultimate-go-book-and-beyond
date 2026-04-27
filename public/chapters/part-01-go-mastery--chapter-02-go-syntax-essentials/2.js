export default `## 2.1 Your First Go Program

Every Go program starts the same way. Create a file called \`main.go\`:

\`\`\`go
package main

import "fmt"

func main() {
    fmt.Println("Hello, World!")
}
\`\`\`

Run it:

\`\`\`bash
\$ go run main.go
Hello, World!
\`\`\`

Three lines of code, three concepts:

**\`package main\`**: Every Go file belongs to a package. The \`main\` package is special. It tells Go "this is an executable program, not a library." Every executable Go program must have exactly one \`main\` package with one \`main\` function.

**\`import "fmt"\`**: This loads Go's formatting package from the standard library. \`fmt\` provides functions for printing text, formatting strings, and reading input. Go's standard library is extensive, and you rarely need third-party packages for basic tasks.

**\`func main()\`**: The entry point. When you run the program, execution starts here. Unlike some languages, Go doesn't need a class or object to contain the main function.

### Setting Up a Go Module

Before writing anything more complex, initialize a Go module. This is how Go manages your project and its dependencies:

\`\`\`bash
\$ mkdir myproject && cd myproject
\$ go mod init myproject
\`\`\`

This creates a \`go.mod\` file that tracks your module name and Go version. Every Go project needs one.

### Go's File Organization

A Go project typically looks like this:

\`\`\`
myproject/
├── go.mod          # Module definition
├── main.go         # Entry point
├── handler.go      # More code in the same package
└── utils/
    └── helpers.go  # A separate package
\`\`\`

Key rules:
- All \`.go\` files in the same directory must have the same \`package\` declaration
- File names don't matter to the compiler. Go compiles all files in a package together
- Capitalized names are exported (visible outside the package). Lowercase names are unexported (private to the package)

\`\`\`go
package utils

func Add(a, b int) int {    // Exported: other packages can call utils.Add()
    return a + b
}

func subtract(a, b int) int { // Unexported: only usable within the utils package
    return a - b
}
\`\`\`

This is Go's access control. No \`public\`, \`private\`, or \`protected\` keywords, just capitalization.

### What \`go run\` Actually Does

\`go run main.go\` looks instant, but it is doing real work behind the scenes. Go compiles your source to a temporary binary in your operating system's temp directory, executes it, and deletes the binary when the process exits. That is why \`go run\` is fine for experimentation but never used in production. For anything you actually ship you use \`go build\` (which produces a binary you can keep, copy, and ship) or \`go install\` (which builds the binary and places it in \`\$GOBIN\` or \`\$GOPATH/bin\`). On a fresh machine the difference matters because \`go run\` recompiles every invocation, while \`go build\` caches compilation results in \`\$GOCACHE\` (default \`~/.cache/go-build\` on Linux, \`%LocalAppData%\\go-build\` on Windows) and reuses them across runs. A repeat \`go build\` on an unchanged 100k-line codebase finishes in well under a second on a 2026-era laptop, which is the build-time experience the original Go authors set out to deliver.

### \`go.mod\` in Three Lines

The \`go.mod\` file \`go mod init\` produces is small but load-bearing. A minimal one looks like this:

\`\`\`
module myproject

go 1.26
\`\`\`

The \`module\` line is the import path other packages will use to reference your code, for example \`import "myproject/utils"\`. For a private project the name is arbitrary. For something you intend to publish to a public registry, use the full import path that matches where the code lives, for example \`github.com/yourname/myproject\`, because the Go tooling resolves dependencies by URL. The \`go 1.26\` line is not just metadata, it tells the toolchain which language version to use for compilation. Setting it to \`1.26\` enables features like range-over-function iterators (1.23) and the loop-variable-per-iteration semantics that became default in 1.22. Older modules pinned to \`go 1.20\` will compile differently on the same machine. As you start importing third-party packages, \`go.mod\` will grow a \`require (...)\` block listing each dependency with a semantic version, and a sibling file \`go.sum\` will appear holding cryptographic checksums to detect supply-chain tampering. You do not edit either by hand. The toolchain manages both.

### Why Capitalisation Instead of Keywords

Beginners reasonably ask why Go ties visibility to identifier case rather than using \`public\` and \`private\` like Java or C#. The answer is consistency at code-review speed. In a Java method body you cannot tell at a glance whether \`helper.process()\` is calling a public, package-private, or protected method without jumping to the declaration. In Go, \`helper.Process()\` is exported and \`helper.process()\` is not, and the distinction is visible in the call site itself. For a code-reviewer scanning a thousand-line PR, that visual cue removes a class of "is this even part of the public API?" questions before they reach the comment field. It also keeps the language smaller. Go has 25 keywords. Java has 67. Every keyword you do not need is a feature you do not have to teach a new hire on day one.

### Code-Review Lens (Senior Track)

Three specific things a staff-level reviewer at a Go-heavy org will flag in a snippet like the one above:

1. **An exported identifier without a doc comment.** Go's convention, enforced by \`go vet\`, \`golint\` (in its earlier form), and the more modern \`revive\` linter, is that every exported identifier should have a doc comment that begins with the identifier name. \`Add(a, b int) int\` should be preceded by \`// Add returns the sum of a and b.\` In a junior PR the missing comment is fine for a learning exercise. In a production PR it blocks the merge. Wire \`revive\` or \`staticcheck\` into CI early so the rule is enforced by tooling, not by reviewer attention.
2. **A \`package main\` file containing reusable logic.** Once a function in \`main.go\` looks like it could be unit-tested in isolation, it belongs in a sub-package, not in \`main\`. The \`main\` package cannot be imported by other packages, including its own tests in another directory, so any logic that lives there is invisible to the rest of the codebase. The senior-track rule is that \`main\` should be a thin orchestration layer (parse flags, build dependencies, call into a \`cmd/\` or \`internal/\` package, exit), nothing more.
3. **The directory layout.** The example layout with \`myproject/utils\` is fine for a tutorial. For a real production service the convention has settled on the \`cmd/\` and \`internal/\` split popularised by the unofficial-but-widely-followed [golang-standards/project-layout](https://github.com/golang-standards/project-layout) repository, with executables under \`cmd/<servicename>/main.go\` and non-importable code under \`internal/\`. The \`internal/\` directory is enforced by the toolchain, not just convention. Nothing outside the parent of \`internal/\` can import it. That single mechanism gives you free encapsulation at the directory level, and it is the easiest way to keep a multi-team monorepo from accidentally taking dependencies on another team's private code.

### Migration Lens for Engineers from Other Languages

If you arrived from Python, the closest analogue to \`package main\` and \`func main()\` is \`if __name__ == "__main__":\`. The difference is that Go enforces the entry-point structure at the language level, so there is no ambiguity about whether a file is a script, a module, or a library. If you arrived from Java, the closest analogue is \`public static void main(String[] args)\` inside a class. The difference is that Go has no class wrapper, so \`func main()\` lives directly inside \`package main\`, and command-line arguments are read from \`os.Args\` rather than passed in. If you arrived from Node.js, there is no direct analogue. Node treats every file as a CommonJS or ES module and the entry point is whatever file you pass to \`node\`. Go, by contrast, makes the entry-point package an explicit declaration. The first time you write \`package main\` it feels like ceremony. By the tenth Go program you write, the explicitness has become a feature, because you can open any unfamiliar Go file and tell within one line whether it is a library or an executable.
`;
