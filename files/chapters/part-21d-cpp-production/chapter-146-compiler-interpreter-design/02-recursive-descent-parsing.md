## Recursive Descent Parsing

A parser transforms a flat token stream into a tree. The tree reflects the grammatical structure of the program, which expressions are nested inside which statements, which operands belong to which operators. Recursive descent is the simplest, most direct parsing technique: you write one function per grammar rule, and the call stack mirrors the parse tree.

### Grammar for Calc

The Calc grammar is written in BNF and directly mirrors the recursive descent parser: each non-terminal like `expr`, `comparison`, or `term` becomes a parser method, and the production rules determine which methods call each other. Operator precedence is encoded structurally, `term` calls `factor`, which means multiplication binds tighter than addition without any explicit precedence table.
```
program        := stmt*
stmt           := let_stmt | return_stmt | block_stmt | expr_stmt
let_stmt       := "let" IDENT "=" expr ";"
return_stmt    := "return" expr ";"
block_stmt     := "{" stmt* "}"
expr_stmt      := expr ";"

expr           := comparison
comparison     := addition (("==" | "!=" | "<" | ">" | "<=" | ">=") addition)?
addition       := multiplication (("+" | "-") multiplication)*
multiplication := unary (("*" | "/") unary)*
unary          := "-" unary | primary
primary        := NUMBER | IDENT | "(" expr ")" | if_expr | fn_expr | fn_call
if_expr        := "if" expr block_stmt ("else" block_stmt)?
fn_expr        := "fn" "(" param_list ")" block_stmt
fn_call        := IDENT "(" arg_list ")"
param_list     := (IDENT ("," IDENT)*)?
arg_list       := (expr ("," expr)*)?
```

Operator precedence emerges naturally from the grammar hierarchy. `multiplication` calls `unary` before `addition` calls `multiplication`, which means `*` and `/` bind tighter than `+` and `-`. This is the standard technique, but it becomes unwieldy for languages with many precedence levels (C++ has 18). Section 03 shows Pratt parsing as the solution.

### AST Nodes (Forward Reference)

The parser builds the AST defined in section 04. For now, we use a simplified forward declaration:

```cpp
#include <memory>
#include <variant>
#include <vector>
#include <string>
#include <optional>
#include <stdexcept>

// Forward declarations -- full definitions in section 04
struct NumberExpr;
struct IdentExpr;
struct BinaryExpr;
struct UnaryExpr;
struct IfExpr;
struct FnExpr;
struct FnCall;
struct LetStmt;
struct ReturnStmt;
struct ExprStmt;
struct BlockStmt;

using Expr = std::variant<
    NumberExpr, IdentExpr, BinaryExpr, UnaryExpr,
    IfExpr, FnExpr, FnCall
>;
using ExprPtr  = std::unique_ptr<Expr>;

using Stmt = std::variant<LetStmt, ReturnStmt, ExprStmt, BlockStmt>;
using StmtPtr  = std::unique_ptr<Stmt>;
using StmtList = std::vector<StmtPtr>;

// Minimal struct definitions needed by the parser
struct NumberExpr { double value; };
struct IdentExpr  { std::string name; };
struct BinaryExpr { std::string op; ExprPtr lhs, rhs; };
struct UnaryExpr  { std::string op; ExprPtr operand; };
struct IfExpr     { ExprPtr cond; StmtList then_body; StmtList else_body; };
struct FnExpr     { std::vector<std::string> params; StmtList body; };
struct FnCall     { std::string callee; std::vector<ExprPtr> args; };

struct LetStmt    { std::string name; ExprPtr value; };
struct ReturnStmt { ExprPtr value; };
struct ExprStmt   { ExprPtr expr; };
struct BlockStmt  { StmtList stmts; };
```

### The Parser

`Parser` holds a token vector and a current position index, with `consume(expected)` throwing a `ParseError` if the next token is not the expected kind, this is the single error reporting point that propagates up to the caller rather than silently skipping tokens. The parser throws exceptions rather than returning error values because parse errors are rare relative to successful parses and exception propagation avoids threading error state through every grammar method.
```cpp
class ParseError : public std::runtime_error {
public:
    explicit ParseError(const std::string& msg) : std::runtime_error(msg) {}
};

class Parser {
    std::vector<Token> tokens_;
    size_t             pos_ = 0;

    const Token& peek(size_t offset = 0) const {
        size_t idx = pos_ + offset;
        if (idx >= tokens_.size()) return tokens_.back(); // EOF
        return tokens_[idx];
    }

    const Token& advance() {
        const Token& t = tokens_[pos_];
        if (pos_ + 1 < tokens_.size()) ++pos_;
        return t;
    }

    bool check(TokenKind k) const { return peek().kind == k; }

    bool match(TokenKind k) {
        if (check(k)) { advance(); return true; }
        return false;
    }

    const Token& expect(TokenKind k, std::string_view msg) {
        if (!check(k)) {
            const auto& t = peek();
            throw ParseError(
                "error[" + std::to_string(t.line) + ":" + std::to_string(t.col)
                + "]: expected " + std::string(msg)
                + ", got '" + std::string(t.text) + "'"
            );
        }
        return advance();
    }

    // Error recovery: skip tokens until we find a synchronization point
    void synchronize() {
        while (!check(TokenKind::Eof)) {
            if (peek(-1 + (int)pos_).kind == TokenKind::Semicolon) return;
            switch (peek().kind) {
                case TokenKind::Let:
                case TokenKind::Return:
                case TokenKind::If:
                case TokenKind::Fn:
                    return;
                default:
                    advance();
            }
        }
    }

public:
    explicit Parser(std::vector<Token> tokens) : tokens_(std::move(tokens)) {}

    // --- Statement parsing ---

    StmtList parse_program() {
        StmtList stmts;
        while (!check(TokenKind::Eof)) {
            try {
                stmts.push_back(parse_stmt());
            } catch (const ParseError& e) {
                std::cerr << e.what() << "\n";
                synchronize();
            }
        }
        return stmts;
    }

    StmtPtr parse_stmt() {
        if (check(TokenKind::Let))    return parse_let_stmt();
        if (check(TokenKind::Return)) return parse_return_stmt();
        return parse_expr_stmt();
    }

    StmtPtr parse_let_stmt() {
        expect(TokenKind::Let, "'let'");
        auto name_tok = expect(TokenKind::Ident, "identifier");
        expect(TokenKind::Eq, "'='");
        auto value = parse_expr();
        expect(TokenKind::Semicolon, "';'");
        return std::make_unique<Stmt>(LetStmt{std::string(name_tok.text), std::move(value)});
    }

    StmtPtr parse_return_stmt() {
        expect(TokenKind::Return, "'return'");
        auto value = parse_expr();
        expect(TokenKind::Semicolon, "';'");
        return std::make_unique<Stmt>(ReturnStmt{std::move(value)});
    }

    StmtPtr parse_expr_stmt() {
        auto expr = parse_expr();
        // Semicolon optional at end of program (REPL-friendly)
        match(TokenKind::Semicolon);
        return std::make_unique<Stmt>(ExprStmt{std::move(expr)});
    }

    StmtList parse_block() {
        expect(TokenKind::LBrace, "'{'");
        StmtList stmts;
        while (!check(TokenKind::RBrace) && !check(TokenKind::Eof)) {
            stmts.push_back(parse_stmt());
        }
        expect(TokenKind::RBrace, "'}'");
        return stmts;
    }

    // --- Expression parsing (precedence via grammar levels) ---

    ExprPtr parse_expr() {
        return parse_comparison();
    }

    ExprPtr parse_comparison() {
        auto lhs = parse_addition();
        if (check(TokenKind::EqEq) || check(TokenKind::BangEq) ||
            check(TokenKind::Lt)   || check(TokenKind::Gt)     ||
            check(TokenKind::LtEq) || check(TokenKind::GtEq))
        {
            auto op = std::string(advance().text);
            auto rhs = parse_addition();
            return std::make_unique<Expr>(
                BinaryExpr{std::move(op), std::move(lhs), std::move(rhs)}
            );
        }
        return lhs;
    }

    ExprPtr parse_addition() {
        auto lhs = parse_multiplication();
        while (check(TokenKind::Plus) || check(TokenKind::Minus)) {
            auto op = std::string(advance().text);
            auto rhs = parse_multiplication();
            lhs = std::make_unique<Expr>(
                BinaryExpr{std::move(op), std::move(lhs), std::move(rhs)}
            );
        }
        return lhs;
    }

    ExprPtr parse_multiplication() {
        auto lhs = parse_unary();
        while (check(TokenKind::Star) || check(TokenKind::Slash)) {
            auto op = std::string(advance().text);
            auto rhs = parse_unary();
            lhs = std::make_unique<Expr>(
                BinaryExpr{std::move(op), std::move(lhs), std::move(rhs)}
            );
        }
        return lhs;
    }

    ExprPtr parse_unary() {
        if (check(TokenKind::Minus)) {
            auto op = std::string(advance().text);
            auto operand = parse_unary();
            return std::make_unique<Expr>(UnaryExpr{std::move(op), std::move(operand)});
        }
        return parse_primary();
    }

    ExprPtr parse_primary() {
        // Number literal
        if (check(TokenKind::Number)) {
            auto tok = advance();
            double val = std::stod(std::string(tok.text));
            return std::make_unique<Expr>(NumberExpr{val});
        }

        // Identifier or function call
        if (check(TokenKind::Ident)) {
            auto name = std::string(advance().text);
            if (check(TokenKind::LParen)) {
                // Function call
                advance(); // consume '('
                std::vector<ExprPtr> args;
                while (!check(TokenKind::RParen) && !check(TokenKind::Eof)) {
                    args.push_back(parse_expr());
                    if (!match(TokenKind::Comma)) break;
                }
                expect(TokenKind::RParen, "')'");
                return std::make_unique<Expr>(FnCall{name, std::move(args)});
            }
            return std::make_unique<Expr>(IdentExpr{name});
        }

        // Parenthesized expression
        if (check(TokenKind::LParen)) {
            advance();
            auto expr = parse_expr();
            expect(TokenKind::RParen, "')'");
            return expr;
        }

        // If expression
        if (check(TokenKind::If)) {
            advance();
            auto cond = parse_expr();
            auto then_body = parse_block();
            StmtList else_body;
            if (match(TokenKind::Else)) {
                else_body = parse_block();
            }
            return std::make_unique<Expr>(
                IfExpr{std::move(cond), std::move(then_body), std::move(else_body)}
            );
        }

        // Function expression: fn(a, b) { ... }
        if (check(TokenKind::Fn)) {
            advance();
            expect(TokenKind::LParen, "'('");
            std::vector<std::string> params;
            while (!check(TokenKind::RParen) && !check(TokenKind::Eof)) {
                params.push_back(std::string(expect(TokenKind::Ident, "param name").text));
                if (!match(TokenKind::Comma)) break;
            }
            expect(TokenKind::RParen, "')'");
            auto body = parse_block();
            return std::make_unique<Expr>(FnExpr{std::move(params), std::move(body)});
        }

        const auto& t = peek();
        throw ParseError(
            "error[" + std::to_string(t.line) + ":" + std::to_string(t.col)
            + "]: unexpected token '" + std::string(t.text) + "'"
        );
    }
};
```

### The Mutual Recursion Trace

When parsing `1 + 2 * 3`:

```
parse_expr()
  parse_comparison()
    parse_addition()
      parse_multiplication()
        parse_unary()
          parse_primary() → NumberExpr{1}
        // no * or /
      // sees '+', consumes it
      parse_multiplication()
        parse_unary()
          parse_primary() → NumberExpr{2}
        // sees '*', consumes it
        parse_unary()
          parse_primary() → NumberExpr{3}
        → BinaryExpr{"*", 2, 3}
      → BinaryExpr{"+", 1, BinaryExpr{"*", 2, 3}}
```

The tree correctly encodes `*` at a deeper nesting level than `+`, enforcing the precedence rule without any explicit precedence table.

### Go Comparison

Go's `go/parser` package uses the same recursive-descent technique. `parser.parseExpr()` calls `parseBinaryExpr()` which calls `parseUnaryExpr()` which calls `parsePrimaryExpr()`. The Go parser has one extra feature: it uses a `prec` (precedence level) parameter to collapse the many grammar levels into a single function, which is essentially a hybrid between recursive descent and Pratt parsing. That hybrid is discussed in the next section.

---
