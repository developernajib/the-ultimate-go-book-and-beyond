export default `# Pratt Parsing: How Interpreters Handle Expressions

If you have ever wondered how a programming language correctly evaluates \`1 + 2 * 3\` as \`7\` and
not \`9\`, the answer lives in the parser. Specifically, it lives in a technique called Pratt
parsing. This is the approach used in real interpreters and compilers, including Go's own frontend.

## What Parsing Actually Does

Parsing converts a flat sequence of tokens into a tree. Tokens are the atomic units of source
code: numbers, identifiers, operators, brackets. A token stream for \`1 + 2 * 3\` looks like:

\`\`\`
NUM(1)  PLUS  NUM(2)  STAR  NUM(3)
\`\`\`

The tree we want is an Abstract Syntax Tree (AST) where the structure encodes precedence. For
\`1 + 2 * 3\`, multiplication has higher precedence than addition, so the correct tree is:

\`\`\`
    +
   / \\
  1   *
     / \\
    2   3
\`\`\`

When the interpreter walks this tree post-order (left child, right child, root), it evaluates
\`2 * 3 = 6\` first, then \`1 + 6 = 7\`. If the tree were built wrong, flattening left-to-right, it
would produce \`(1 + 2) * 3 = 9\`. The tree structure IS the precedence.

## Why Naive Recursive Descent Breaks

The first instinct for parsing is to write a recursive descent parser: one function per grammar
rule, each calling the others recursively. For a simple grammar this works fine. The problem
appears with left-recursive rules.

Consider writing \`parseAddition\`:

\`\`\`go
func parseAddition() Node {
    left := parseAddition()  // infinite recursion
    expectToken(PLUS)
    right := parseMul()
    return BinaryNode{"+", left, right}
}
\`\`\`

The function immediately calls itself before consuming any input. The call stack overflows. You
can work around this by rewriting the grammar to be right-recursive and then flipping the tree,
but that gets complicated fast. Pratt parsing sidesteps the problem entirely with a cleaner model.

## The Core Idea: Binding Power

Pratt parsing replaces the concept of "precedence" with "binding power." Every infix operator has
a left binding power and a right binding power. The algorithm uses these numbers to decide when
to stop consuming tokens for the right-hand side of an expression.

A typical binding power table:

| Operator | Left BP | Right BP |
|----------|---------|----------|
| \`+\` | 1 | 2 |
| \`-\` | 1 | 2 |
| \`*\` | 3 | 4 |
| \`/\` | 3 | 4 |

Left BP and right BP for the same operator differ by 1. That tiny asymmetry forces
left-associativity: \`1 + 2 + 3\` groups as \`(1 + 2) + 3\` because the right side of the first \`+\`
has BP 2, and when the second \`+\` is encountered its left BP of 1 is less than 2, so the loop
stops and the second \`+\` becomes an outer node.

## Walking Through \`1 + 2 * 3\`

1. Call \`parseExpr(minBP=0)\`.
2. Consume \`NUM(1)\`, store as \`left\`.
3. Peek at \`PLUS\`. Left BP of \`+\` is 1. Since \`1 > 0\` (minBP), consume \`+\`.
4. Recurse: \`parseExpr(minBP=2)\` (right BP of \`+\`).
 - Consume \`NUM(2)\`, store as \`left\`.
 - Peek at \`STAR\`. Left BP of \`*\` is 3. Since \`3 > 2\`, consume \`*\`.
 - Recurse: \`parseExpr(minBP=4)\`.
 - Consume \`NUM(3)\`, store as \`left\`.
 - Peek: no more tokens (or EOF). Return \`NUM(3)\`.
 - \`right = NUM(3)\`. Build \`BinaryNode{*, NUM(2), NUM(3)}\`. Return it.
5. Back in outer call: \`right = BinaryNode{*, 2, 3}\`. Build \`BinaryNode{+, NUM(1), *-node}\`.
6. Return. The tree has \`+\` at the root with \`1\` on the left and \`(2 * 3)\` on the right.

The key insight: the recursive call for \`*\` uses \`minBP=4\`, which is higher than the left BP of
any remaining operator, so it stops early and hands control back. Operators with lower binding
power yield to operators with higher binding power by stopping the recursion.

## A Go Implementation

Here is a complete, runnable Pratt parser for arithmetic expressions in Go:

\`\`\`go
package main

import (
    "fmt"
    "strconv"
    "unicode"
)

// Token kinds
const (
    tokNum = iota
    tokPlus
    tokMinus
    tokStar
    tokSlash
    tokLParen
    tokRParen
    tokEOF
)

type Token struct {
    kind int
    val  string
}

// Tokenize splits a string into tokens. Only handles single/multi-digit integers
// and the operators +, -, *, /, (, ).
func tokenize(src string) []Token {
    var tokens []Token
    i := 0
    for i < len(src) {
        ch := rune(src[i])
        if unicode.IsSpace(ch) {
            i++
            continue
        }
        if unicode.IsDigit(ch) {
            j := i
            for j < len(src) && unicode.IsDigit(rune(src[j])) {
                j++
            }
            tokens = append(tokens, Token{tokNum, src[i:j]})
            i = j
            continue
        }
        switch ch {
        case '+':
            tokens = append(tokens, Token{tokPlus, "+"})
        case '-':
            tokens = append(tokens, Token{tokMinus, "-"})
        case '*':
            tokens = append(tokens, Token{tokStar, "*"})
        case '/':
            tokens = append(tokens, Token{tokSlash, "/"})
        case '(':
            tokens = append(tokens, Token{tokLParen, "("})
        case ')':
            tokens = append(tokens, Token{tokRParen, ")"})
        }
        i++
    }
    tokens = append(tokens, Token{tokEOF, ""})
    return tokens
}

// bindingPower returns (leftBP, rightBP) for infix operators.
// Returns (0, 0) for non-infix tokens.
func bindingPower(kind int) (int, int) {
    switch kind {
    case tokPlus, tokMinus:
        return 1, 2
    case tokStar, tokSlash:
        return 3, 4
    }
    return 0, 0
}

type parser struct {
    tokens []Token
    pos    int
}

func (p *parser) peek() Token {
    if p.pos >= len(p.tokens) {
        return Token{tokEOF, ""}
    }
    return p.tokens[p.pos]
}

func (p *parser) next() Token {
    t := p.peek()
    p.pos++
    return t
}

// parseExpr is the heart of the Pratt parser.
// minBP is the minimum left binding power an operator must have to be consumed.
func (p *parser) parseExpr(minBP int) string {
    tok := p.next()

    var left string
    switch tok.kind {
    case tokNum:
        left = tok.val
    case tokLParen:
        // Parse the inner expression with no minimum binding power,
        // then expect a closing parenthesis.
        left = "(" + p.parseExpr(0) + ")"
        closing := p.next()
        if closing.kind != tokRParen {
            panic("expected ')'")
        }
    default:
        panic(fmt.Sprintf("unexpected token: %q", tok.val))
    }

    for {
        op := p.peek()
        lbp, rbp := bindingPower(op.kind)
        // Stop if the operator has no left binding power (it is not an infix operator)
        // or if its left binding power does not exceed our minimum.
        if lbp == 0 || lbp <= minBP {
            break
        }
        p.next() // consume the operator
        right := p.parseExpr(rbp)
        left = fmt.Sprintf("(%s %s %s)", op.val, left, right)
    }

    return left
}

func eval(src string) float64 {
    tokens := tokenize(src)
    p := &parser{tokens: tokens}
    _ = p.parseExpr(0) // get the tree (as a string here; real use would return a Node)
    // For a real evaluator, walk the Node tree. Here we eval directly during parse.
    return evalTokens(tokens[:len(tokens)-1])
}

// evalTokens uses a second pass to actually compute the result.
// In a real interpreter, parseExpr returns an AST Node and you walk that.
func evalTokens(tokens []Token) float64 {
    p := &parser{tokens: append(tokens, Token{tokEOF, ""})}
    return evalExpr(p, 0)
}

func evalExpr(p *parser, minBP int) float64 {
    tok := p.next()
    var left float64
    switch tok.kind {
    case tokNum:
        v, _ := strconv.ParseFloat(tok.val, 64)
        left = v
    case tokLParen:
        left = evalExpr(p, 0)
        p.next() // consume ')'
    default:
        panic(fmt.Sprintf("unexpected: %q", tok.val))
    }

    for {
        op := p.peek()
        lbp, rbp := bindingPower(op.kind)
        if lbp == 0 || lbp <= minBP {
            break
        }
        p.next()
        right := evalExpr(p, rbp)
        switch op.kind {
        case tokPlus:
            left += right
        case tokMinus:
            left -= right
        case tokStar:
            left *= right
        case tokSlash:
            left /= right
        }
    }
    return left
}

func main() {
    exprs := []string{
        "1 + 2 * 3",          // 7
        "1 + 2 * 3 - 4 / 2",  // 5
        "(1 + 2) * 3",         // 9
        "10 / 2 + 3",          // 8
    }
    for _, expr := range exprs {
        result := evalTokens(tokenize(expr))
        fmt.Printf("%s = %.0f\\n", expr, result)
    }
}
\`\`\`

Run it and you get:

\`\`\`
1 + 2 * 3 = 7
1 + 2 * 3 - 4 / 2 = 5
(1 + 2) * 3 = 9
10 / 2 + 3 = 8
\`\`\`

## Adding Parentheses

Parentheses override binding power. When the parser sees \`(\`, it calls \`parseExpr(0)\` recursively
with \`minBP=0\`. That tells the inner call to consume everything until it sees something with left
BP of 0 or less, which only happens at \`)\` (which has no binding power at all, so it stops the
loop). The result of the inner call becomes a single \`left\` value as far as the outer call is
concerned, so \`(1 + 2) * 3\` correctly binds \`1 + 2\` before the multiply.

## Extending the Parser

Adding a new operator requires only one change: add an entry to \`bindingPower\`. No changes to
\`parseExpr\`. For right-associative operators like exponentiation (\`^\`), set right BP lower than
left BP. For example, \`(leftBP=5, rightBP=4)\` makes \`2 ^ 3 ^ 4\` group as \`2 ^ (3 ^ 4)\`.

The dot operator in method chains (\`a.b.c\`) works the same way. Assign a high binding power to
\`.\` and the parser builds a left-leaning chain automatically.

## How Go's Compiler Uses This

Go's own parser lives at \`cmd/compile/internal/syntax\`. The expression parser in \`parser.go\` uses
a precedence-climbing approach that is equivalent to Pratt parsing. Each binary operator carries a
numeric precedence level, the \`binaryExpr\` function loops and recurses based on whether the next
operator's precedence exceeds the current minimum, exactly as shown above.

The Go grammar defines five precedence levels for binary operators (from low to high): \`||\`, \`&&\`,
comparison operators, \`+ -\`, \`* / % << >> & &^\`. Unary operators are handled separately, as
prefix expressions, before the infix loop begins.

## Where to Go Next

Thorsten Ball's book "Writing an Interpreter in Go" walks through building a complete interpreter
for a custom language using Go, with Pratt parsing as the expression parsing strategy. It is the
clearest treatment of the topic in Go and covers prefix operators, if expressions, and function
literals on top of the infix core shown here.

The original article that popularized the "binding power" framing is Matklad's "Simple but
Powerful Pratt Parsing" (matklad.github.io). It explains associativity rules in more depth and
shows how to handle prefix operators like unary minus.

---

Watch the original video: https://www.youtube.com/watch?v=0c8b7YfsBKs
`;
