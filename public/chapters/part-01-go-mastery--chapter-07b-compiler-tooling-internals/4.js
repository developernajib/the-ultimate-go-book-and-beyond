export default `## 7B.2 Lexical Analysis

The lexer (scanner) transforms raw bytes into a stream of tokens. This is the very first stage of compilation: the compiler reads your \`.go\` source file character by character and groups those characters into meaningful units called tokens. Tokens include keywords like \`func\` and \`package\`, identifiers like variable names, literal values like \`42\` or \`"hello"\`, and punctuation like \`{\` and \`:=\`. You can use Go's standard library \`go/scanner\` package to perform this same tokenization yourself, which is useful for building code analysis tools.

\`\`\`go
package main

import (
	"fmt"
	"go/scanner"
	"go/token"
)

func main() {
	src := []byte(\`package main

import "fmt"

func main() {
	x := 42
	fmt.Println(x)
}\`)

	fset := token.NewFileSet()
	file := fset.AddFile("main.go", fset.Base(), len(src))

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
\`\`\`

Output (abbreviated):
\`\`\`
main.go:1:1    package  ""
main.go:1:9    IDENT    "main"
main.go:3:1    import   ""
main.go:3:8    STRING   "\\"fmt\\""
main.go:5:1    func     ""
main.go:5:6    IDENT    "main"
...
\`\`\`

### Token Categories

Go has a fixed set of token types defined in the \`go/token\` package. Every piece of your source code maps to one of these token types. Understanding them helps you reason about what the scanner produces and what the parser consumes. The tokens fall into four main groups: literals (identifiers, numbers, strings), operators and punctuation, keywords, and special tokens like \`EOF\` (end of file) and \`COMMENT\`.

\`\`\`go
// go/token constants
const (
    ILLEGAL Token = iota
    EOF
    COMMENT

    // Literals
    IDENT  // main, fmt, x
    INT    // 42, 0xFF
    FLOAT  // 3.14
    IMAG   // 3i
    CHAR   // 'a'
    STRING // "hello"

    // Operators
    ADD // +
    SUB // -
    MUL // *
    QUO // /
    REM // %

    // Keywords
    BREAK    // break
    CASE     // case
    CHAN     // chan
    CONST    // const
    CONTINUE // continue
    // ... 25 keywords total
)
\`\`\`

### When You Actually Use the Scanner

Most tooling never touches the scanner directly. \`go/parser\` embeds its own scanner. The cases where you reach for \`go/scanner\` as a senior engineer:

1. **Source code formatters.** \`gofmt\` runs its own scanner to preserve whitespace and comment positions.
2. **Syntax-highlighting tools.** Editor integrations tokenise without parsing for speed.
3. **Build-system heuristics.** Fast "does this file contain X" checks without the parser overhead.

For almost everything else, start with \`go/parser\`.

---
`;
