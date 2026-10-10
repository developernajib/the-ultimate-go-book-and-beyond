## Pratt Parsing: Elegant Operator Precedence

Recursive descent handles precedence by adding a grammar level per precedence tier. A language with 18 precedence levels (C++) needs 18 grammar functions chained together. Adding a new operator means restructuring the grammar. This is the problem Vaughan Pratt solved in 1973 with **top-down operator precedence** parsing, now universally called Pratt parsing.

### The Core Insight: Binding Power

Each operator token has two numbers: how tightly it binds to the left operand, and how tightly it binds to the right operand. Call them `lbp` and `rbp`.

| Operator | Left BP | Right BP | Associativity |
|----------|---------|----------|---------------|
| `+`, `-` | 10      | 11       | left  |
| `*`, `/` | 20      | 21       | left  |
| unary `-` |,      | 30       | prefix |
| `==`, `!=` | 5     | 6        | left  |
| `<`, `>`, `<=`, `>=` | 5 | 6 | left |

The main loop: parse while the next operator's left binding power is greater than the current minimum. Left-associativity: `rbp = lbp + 1`. Right-associativity: `rbp = lbp` (e.g., assignment `=`).

### Implementation

The Pratt parser's `left_bp` table assigns binding powers to infix operators, and `parse_expr(min_bp)` keeps consuming operators whose left binding power exceeds `min_bp`. Each call to a `led` (left denotation) function recursively calls `parse_expr(right_bp(op))`, where `right_bp` is one higher for left-associative operators and one lower for right-associative ones, the entire precedence and associativity model in two lookup tables.
```cpp
// Binding power table
static int left_bp(TokenKind k) {
    switch (k) {
        case TokenKind::EqEq:
        case TokenKind::BangEq:
        case TokenKind::Lt:
        case TokenKind::Gt:
        case TokenKind::LtEq:
        case TokenKind::GtEq:  return 5;
        case TokenKind::Plus:
        case TokenKind::Minus: return 10;
        case TokenKind::Star:
        case TokenKind::Slash: return 20;
        default:               return 0;   // not an infix operator
    }
}

static int right_bp(TokenKind k) {
    // For left-associative: rbp = lbp + 1
    // For right-associative: rbp = lbp
    int lbp = left_bp(k);
    return lbp > 0 ? lbp + 1 : 0;
}
```

```cpp
class PrattParser {
    std::vector<Token> tokens_;
    size_t             pos_ = 0;

    const Token& peek()    const { return tokens_[std::min(pos_, tokens_.size()-1)]; }
    const Token& advance()       { return tokens_[pos_ < tokens_.size() ? pos_++ : pos_]; }
    bool check(TokenKind k) const { return peek().kind == k; }

    // Null denotation (nud): how to parse this token at the start of an expression
    ExprPtr nud(const Token& tok) {
        switch (tok.kind) {
            case TokenKind::Number: {
                double val = std::stod(std::string(tok.text));
                return std::make_unique<Expr>(NumberExpr{val});
            }
            case TokenKind::Ident: {
                std::string name(tok.text);
                // Lookahead: is this a function call?
                if (check(TokenKind::LParen)) {
                    advance(); // consume '('
                    std::vector<ExprPtr> args;
                    while (!check(TokenKind::RParen) && !check(TokenKind::Eof)) {
                        args.push_back(parse_expr(0));
                        if (peek().kind != TokenKind::Comma) break;
                        advance(); // consume ','
                    }
                    if (!check(TokenKind::RParen))
                        throw ParseError("expected ')' after argument list");
                    advance(); // consume ')'
                    return std::make_unique<Expr>(FnCall{name, std::move(args)});
                }
                return std::make_unique<Expr>(IdentExpr{name});
            }
            case TokenKind::Minus: {
                // Prefix unary minus: right-binding-power = 30
                auto operand = parse_expr(30);
                return std::make_unique<Expr>(UnaryExpr{"-", std::move(operand)});
            }
            case TokenKind::LParen: {
                auto expr = parse_expr(0);
                if (!check(TokenKind::RParen))
                    throw ParseError("expected ')' after grouped expression");
                advance(); // consume ')'
                return expr;
            }
            case TokenKind::If: {
                auto cond = parse_expr(0);
                // expect block
                if (!check(TokenKind::LBrace))
                    throw ParseError("expected '{' after if condition");
                advance();
                StmtList then_body;
                // simplified: not re-using parse_block here, just showing structure
                (void)then_body;
                // In the full compiler, delegate to the statement parser
                throw ParseError("if-expr in Pratt parser: delegate to recursive descent");
            }
            default:
                throw ParseError(
                    "unexpected token '" + std::string(tok.text) + "' in expression"
                );
        }
    }

    // Left denotation (led): how to parse this token when appearing infix
    ExprPtr led(const Token& tok, ExprPtr lhs) {
        int rbp = right_bp(tok.kind);
        auto rhs = parse_expr(rbp);
        return std::make_unique<Expr>(
            BinaryExpr{std::string(tok.text), std::move(lhs), std::move(rhs)}
        );
    }

public:
    explicit PrattParser(std::vector<Token> tokens) : tokens_(std::move(tokens)) {}

    ExprPtr parse_expr(int min_bp) {
        // Consume the first token and call its nud
        auto tok = advance();
        auto lhs = nud(tok);

        // While the next operator binds tighter than min_bp, consume and fold
        while (left_bp(peek().kind) > min_bp) {
            auto op = advance();
            lhs = led(op, std::move(lhs));
        }

        return lhs;
    }
};
```

### Walking Through `1 + 2 * 3`

The trace below shows how `parse_expr(0)` handles `1 + 2 * 3`: when processing `+` the right-side recursive call uses `min_bp=11`, and since `*` has `left_bp=20 > 11` the multiplication is consumed first, producing `(+ 1 (* 2 3))` rather than `(* (+ 1 2) 3)`. This automatic precedence climbing is the Pratt parser's key insight, no grammar restructuring is needed to add new operators with different precedences.
```
parse_expr(0):
  tok = '1', nud('1') → NumberExpr{1}     lhs = 1
  peek = '+', left_bp('+') = 10 > 0, enter loop
    op = '+', led('+', lhs=1):
      rhs = parse_expr(right_bp('+') = 11)
        tok = '2', nud('2') → NumberExpr{2}   lhs = 2
        peek = '*', left_bp('*') = 20 > 11, enter loop
          op = '*', led('*', lhs=2):
            rhs = parse_expr(right_bp('*') = 21)
              tok = '3', nud('3') → NumberExpr{3}
              peek = EOF, left_bp = 0 < 21, exit loop
            → return NumberExpr{3}
          → return BinaryExpr{'*', 2, 3}
        peek = EOF, left_bp = 0 < 11, exit loop
      → return BinaryExpr{'*', 2, 3}
    → return BinaryExpr{'+', 1, BinaryExpr{'*', 2, 3}}
  peek = EOF, left_bp = 0 < 0, exit loop
→ BinaryExpr{'+', 1, BinaryExpr{'*', 2, 3}}
```

Correct. The `*` binds tighter because `20 > 11`.

### Right-Associativity: Assignment

To make `a = b = c` parse as `a = (b = c)` (right-associative), use `rbp = lbp`:

```cpp
// In the binding power table:
case TokenKind::Eq:  return 2;   // left_bp

// In right_bp():
case TokenKind::Eq:  return 2;   // same as left_bp → right-associative
```

Now `parse_expr(2)` for the right side will consume `b = c` as a unit before returning. For left-associative operators, `rbp = lbp + 1` ensures the operator does not capture itself on the right.

### Extending Without Restructuring

The power of Pratt parsing becomes clear when you add a postfix operator like `!` (factorial) or `++`:

```cpp
// In led():
case TokenKind::Bang:  // postfix !
    return std::make_unique<Expr>(UnaryExpr{"!", std::move(lhs)});  // no rhs parse
```

No grammar changes. No new parser functions. Just add a `left_bp` entry and a `led` case.

For a ternary `a ? b : c`:

```cpp
// left_bp(Question) = 3
// led(Question, lhs):
//   then_expr = parse_expr(0)
//   expect(Colon)
//   else_expr = parse_expr(3)
//   return TernaryExpr{lhs, then_expr, else_expr}
```

### Hybrid Strategy (What Go's Parser Does)

Go's `go/parser` uses a hybrid: recursive descent for statements and prefix expressions, but a single `parseBinaryExpr(prec int)` loop for infix operators, exactly the Pratt `parse_expr(min_bp)` loop, but without the nud/led split. This is the sweet spot for many practical parsers: recursive descent for the top-level structure (easy to read, good error messages), Pratt for binary expressions (easy to extend, handles precedence cleanly).

For Calc, the full Pratt parser is used in the REPL where expressions are the primary input. The recursive descent parser is used for the full program with statements.

---
