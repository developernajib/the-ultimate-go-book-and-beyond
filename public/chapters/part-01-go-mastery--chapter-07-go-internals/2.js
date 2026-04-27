export default `## 7.1 From Source to Binary

### The Compilation Pipeline

When you run \`go build\`, your code passes through several distinct stages:

\`\`\`
Source Code → Lexer → Parser → Type Checker → SSA → Machine Code → Linker → Binary
\`\`\`

**Google's Perspective**: The Go team at Google designed this pipeline for fast compilation. Unlike C++ which can take hours to compile large projects, Go compiles millions of lines of code in seconds. This was a key design goal because Google engineers were spending significant time waiting for builds.

### 1. Lexical Analysis (Lexer)

The lexer converts source text into tokens, the atomic units of the language:

\`\`\`go
// Source code
x := 42 + y
\`\`\`

Becomes: \`IDENT(x)\`, \`DEFINE(:=)\`, \`INT(42)\`, \`ADD(+)\`, \`IDENT(y)\`

You can inspect tokenization programmatically:

\`\`\`go
package main

import (
    "fmt"
    "go/scanner"
    "go/token"
)

func main() {
    src := []byte(\`package main

func main() {
    x := 42 + y
}\`)

    fset := token.NewFileSet()
    file := fset.AddFile("", fset.Base(), len(src))

    var s scanner.Scanner
    s.Init(file, src, nil, scanner.ScanComments)

    for {
        pos, tok, lit := s.Scan()
        if tok == token.EOF {
            break
        }
        fmt.Printf("%s\\t%s\\t%q\\n", fset.Position(pos), tok, lit)
    }
}

// Output:
// 1:1     package "package"
// 1:9     IDENT   "main"
// 3:1     func    "func"
// 3:6     IDENT   "main"
// 3:10    (       ""
// 3:11    )       ""
// 3:13    {       ""
// 4:2     IDENT   "x"
// 4:4     :=      ""
// 4:7     INT     "42"
// 4:10    +       ""
// 4:12    IDENT   "y"
// 5:1     }       ""
\`\`\`

### 2. Parsing (AST Generation)

The parser consumes the token stream and builds an Abstract Syntax Tree (AST) representing the program's hierarchical structure. The AST captures relationships between declarations, statements, and expressions that the flat token stream cannot represent. Go's \`go/parser\` package exposes this AST, making it the foundation for static analysis tools, code generators, and refactoring utilities.

\`\`\`go
package main

import (
    "fmt"
    "go/ast"
    "go/parser"
    "go/token"
)

func main() {
    src := \`
package main

func add(a, b int) int {
    return a + b
}

func main() {
    result := add(1, 2)
    fmt.Println(result)
}
\`

    fset := token.NewFileSet()
    node, err := parser.ParseFile(fset, "example.go", src, parser.ParseComments)
    if err != nil {
        panic(err)
    }

    // Print the AST
    ast.Print(fset, node)

    // Walk the AST to find all function declarations
    ast.Inspect(node, func(n ast.Node) bool {
        if fn, ok := n.(*ast.FuncDecl); ok {
            fmt.Printf("Function: %s\\n", fn.Name.Name)
            fmt.Printf("  Parameters: ")
            if fn.Type.Params != nil {
                for _, field := range fn.Type.Params.List {
                    for _, name := range field.Names {
                        fmt.Printf("%s ", name.Name)
                    }
                }
            }
            fmt.Println()
        }
        return true
    })
}
\`\`\`

**Production Use Case**: At Uber, AST manipulation is used for:
- **Code generation**: Generating boilerplate code, mock implementations
- **Static analysis**: Custom linters that enforce Uber's Go style guide
- **Refactoring tools**: Automated code transformations across thousands of files

### 3. Type Checking

After parsing, the type checker walks the AST to verify type correctness, resolve identifiers, infer types for short variable declarations, and annotate every expression with its resolved type. This pass catches type mismatches, undeclared names, and unused imports before code generation begins. The \`go/types\` package provides programmatic access to type information, which is the basis for tools like \`gopls\` and custom linters.

\`\`\`go
package main

import (
    "fmt"
    "go/ast"
    "go/importer"
    "go/parser"
    "go/token"
    "go/types"
)

func main() {
    src := \`
package main

func main() {
    x := 42
    y := "hello"
    z := x + 1
    _ = y
    _ = z
}
\`

    fset := token.NewFileSet()
    file, _ := parser.ParseFile(fset, "example.go", src, 0)

    conf := types.Config{
        Importer: importer.Default(),
    }

    info := &types.Info{
        Types: make(map[ast.Expr]types.TypeAndValue),
        Defs:  make(map[*ast.Ident]types.Object),
        Uses:  make(map[*ast.Ident]types.Object),
    }

    pkg, err := conf.Check("main", fset, []*ast.File{file}, info)
    if err != nil {
        panic(err)
    }

    fmt.Printf("Package: %s\\n\\n", pkg.Name())

    // Show type information for all expressions
    fmt.Println("Expression types:")
    for expr, tv := range info.Types {
        fmt.Printf("  %s: %s\\n", fset.Position(expr.Pos()), tv.Type)
    }

    // Show all definitions
    fmt.Println("\\nDefinitions:")
    for ident, obj := range info.Defs {
        if obj != nil {
            fmt.Printf("  %s: %s\\n", ident.Name, obj.Type())
        }
    }
}
\`\`\`

### 4. SSA Generation

Static Single Assignment (SSA) form is an intermediate representation where each variable is assigned exactly once. This enables powerful optimizations:

\`\`\`go
// Original code
func calculate(n int) int {
    x := n + 1
    x = x * 2
    x = x - 3
    return x
}

// Conceptual SSA form
func calculate(n int) int {
    x_1 := n + 1
    x_2 := x_1 * 2
    x_3 := x_2 - 3
    return x_3
}
\`\`\`

View SSA with:

\`\`\`bash
GOSSAFUNC=calculate go build -gcflags="-S" main.go
# Creates ssa.html in current directory
\`\`\`

The SSA HTML shows optimization passes:
- **deadcode**: Removes unreachable code
- **opt**: General optimizations
- **prove**: Proves bounds checks can be eliminated
- **lower**: Converts to machine-specific form
- **regalloc**: Allocates registers

**Cloudflare's Usage**: Cloudflare engineers analyze SSA output to understand why certain hot paths do not optimize as expected, particularly in their edge computing runtime.

### 5. Machine Code Generation

After SSA optimization, the compiler lowers the intermediate representation to platform-specific machine instructions. You can inspect the generated assembly to understand exactly what the CPU executes, which is useful for verifying that bounds-check elimination or inlining happened as expected.

\`\`\`bash
# View assembly output
go build -gcflags="-S" main.go 2>&1 | head -50

# More readable with objdump
go build -o myprogram main.go
go tool objdump -s main.calculate myprogram
\`\`\`

The assembly for a simple addition function shows Go's calling convention, where arguments and return values are passed on the stack:

\`\`\`asm
TEXT main.add(SB), NOSPLIT, \$0-24
    MOVQ    "".a+8(SP), AX
    ADDQ    "".b+16(SP), AX
    MOVQ    AX, "".~r2+24(SP)
    RET
\`\`\`

### 7. Linking

The linker combines compiled object files, resolves symbol references across packages, and produces the final executable. The \`-ldflags\` flag controls linker behavior, including debug information stripping and compile-time variable injection.

\`\`\`bash
# See what the linker does
go build -ldflags="-v" main.go

# Strip debug info for smaller binary
go build -ldflags="-s -w" main.go

# Inject build information
go build -ldflags="-X main.version=1.0.0 -X main.buildTime=\$(date -u +%Y%m%d%H%M%S)" main.go
\`\`\`

### Build Cache and Reproducibility

Go caches compiled packages so that unchanged code is not recompiled on subsequent builds. This cache is content-addressed: if the source, compiler flags, and dependencies have not changed, the cached artifact is reused.

\`\`\`bash
# Check cache location
go env GOCACHE
# /home/user/.cache/go-build

# View cache statistics
go env GOCACHE
ls -la \$(go env GOCACHE)

# Clean cache
go clean -cache

# Force rebuild
go build -a main.go
\`\`\`

**Netflix's Build System**: Netflix uses Go's reproducible builds for their microservices. They checksum binaries to verify that identical source produces identical output, important for security and compliance.

### Build Modes

The \`go build -buildmode\` flag controls how the output is structured: as an executable, shared library, C archive, or plugin. Each mode targets a different deployment scenario with different runtime constraints.

\`\`\`bash
# Default: standalone executable
go build -buildmode=exe main.go

# Go plugin (Linux/macOS only)
go build -buildmode=plugin -o myplugin.so plugin.go

# C shared library
go build -buildmode=c-shared -o libmylib.so lib.go

# C archive (static library)
go build -buildmode=c-archive -o libmylib.a lib.go

# Position Independent Executable (for ASLR)
go build -buildmode=pie main.go
\`\`\`

### Cross-Compilation

Go cross-compiles by setting \`GOOS\` and \`GOARCH\` environment variables. No separate toolchain or SDK is required. The Go compiler natively emits code for all supported targets.

\`\`\`bash
# Build for Linux from macOS
GOOS=linux GOARCH=amd64 go build -o myapp-linux main.go

# Build for Windows
GOOS=windows GOARCH=amd64 go build -o myapp.exe main.go

# Build for ARM (Raspberry Pi)
GOOS=linux GOARCH=arm GOARM=7 go build -o myapp-arm main.go

# Build for Apple Silicon
GOOS=darwin GOARCH=arm64 go build -o myapp-m1 main.go
\`\`\`

**Stripe's Approach**: Stripe builds their Go services for multiple architectures from CI, ensuring their payment processing systems can run on various cloud providers and architectures.

### Why the Compile Pipeline Matters for Senior Engineers

Knowing the stages of compilation gives you diagnostic tools. Three cases where the pipeline knowledge pays off:

1. **Escape analysis surprises.** When \`-gcflags="-m"\` says a variable escapes and you did not expect it, the pipeline view tells you where to look. The escape decision happens after SSA generation based on the function's complete data flow. If your mental model stops at the source, you are guessing.
2. **Linker-related binary bloat.** A binary that grew 40 MB on a small code change is a linker question. \`go tool nm -size\` and \`go tool objdump\` are the investigation tools. Understanding that the linker does dead-code elimination helps you reason about what grew and why.
3. **Plugin and build-mode decisions.** \`buildmode=plugin\`, \`buildmode=c-shared\`, and \`buildmode=pie\` have different loader, initialisation, and security properties. Choose by understanding the cost, not by trial and error.

### Code-Review Lens (Senior Track)

Three patterns to flag in build-related PRs:

1. **Missing strip flags for production.** Debug symbols add ~30% to binary size. \`go build -ldflags="-s -w"\` strips them. For production builds where debugging happens via captured profiles, strip aggressively.
2. **Build tags abused for feature flags.** Build tags are for compile-time conditional compilation. Using them as runtime feature flags (rebuild to toggle a feature) is a code smell that eventually breaks your CI story. Use real feature flags for runtime switching.
3. **Cross-compile without CI coverage.** A service built for Linux locally but never tested on Linux in CI will ship unexpected breakage. Wire the target into CI.

---
`;
