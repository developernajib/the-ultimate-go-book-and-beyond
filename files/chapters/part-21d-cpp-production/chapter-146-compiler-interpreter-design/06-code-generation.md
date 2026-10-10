## Code Generation: Interpreter and Bytecode

The type-checked AST can be executed directly (tree-walking interpreter) or compiled to an intermediate bytecode that a virtual machine then executes. Both approaches are used in production: Ruby's MRI interpreter is tree-walking. Python, Lua, Java, and Go all use bytecode VMs.

### Tree-Walking Interpreter

The simplest execution model: recursively evaluate each AST node. A `Value` represents a runtime value. An `Environment` holds variable bindings in a scope stack.

```cpp
#include <variant>
#include <unordered_map>
#include <vector>
#include <functional>
#include <stdexcept>
#include <memory>

struct CalcFn;
using Value = std::variant<double, bool, std::shared_ptr<CalcFn>>;

// A Calc function is its parameter list, body, and the environment it closed over
struct CalcFn {
    std::vector<std::string>                     params;
    StmtList*                                    body;   // pointer into AST (non-owning)
    std::vector<std::unordered_map<std::string, Value>> closure_env;
};

class Environment {
    std::vector<std::unordered_map<std::string, Value>> scopes_;
public:
    Environment() { scopes_.emplace_back(); }

    void push()  { scopes_.emplace_back(); }
    void pop()   { scopes_.pop_back(); }

    void set(const std::string& name, Value v) {
        scopes_.back()[name] = std::move(v);
    }

    // Walk from innermost to outermost
    Value get(const std::string& name) const {
        for (auto it = scopes_.rbegin(); it != scopes_.rend(); ++it) {
            auto found = it->find(name);
            if (found != it->end()) return found->second;
        }
        throw std::runtime_error("undefined variable: " + name);
    }

    void assign(const std::string& name, Value v) {
        for (auto it = scopes_.rbegin(); it != scopes_.rend(); ++it) {
            if (it->count(name)) { (*it)[name] = std::move(v); return; }
        }
        throw std::runtime_error("assignment to undeclared variable: " + name);
    }
};

// Thrown to unwind the call stack when a return statement is hit
struct ReturnSignal { Value value; };

class Interpreter {
    Environment env_;

    double to_number(const Value& v) {
        if (auto* d = std::get_if<double>(&v)) return *d;
        throw std::runtime_error("expected Number");
    }
    bool to_bool(const Value& v) {
        if (auto* b = std::get_if<bool>(&v)) return *b;
        throw std::runtime_error("expected Bool");
    }

public:
    Value eval(const Expr& e) {
        return std::visit([this](const auto& node) -> Value {
            return eval_node(node);
        }, e);
    }

    Value eval_node(const NumberExpr& n) { return n.value; }
    Value eval_node(const IdentExpr& id) { return env_.get(id.name); }

    Value eval_node(const BinaryExpr& b) {
        Value lhs = eval(*b.lhs);
        Value rhs = eval(*b.rhs);
        if (b.op == "+") return to_number(lhs) + to_number(rhs);
        if (b.op == "-") return to_number(lhs) - to_number(rhs);
        if (b.op == "*") return to_number(lhs) * to_number(rhs);
        if (b.op == "/") {
            double d = to_number(rhs);
            if (d == 0.0) throw std::runtime_error("division by zero");
            return to_number(lhs) / d;
        }
        if (b.op == "==") return lhs == rhs;
        if (b.op == "!=") return !(lhs == rhs);
        if (b.op == "<")  return to_number(lhs) < to_number(rhs);
        if (b.op == ">")  return to_number(lhs) > to_number(rhs);
        if (b.op == "<=") return to_number(lhs) <= to_number(rhs);
        if (b.op == ">=") return to_number(lhs) >= to_number(rhs);
        throw std::runtime_error("unknown op: " + b.op);
    }

    Value eval_node(const UnaryExpr& u) {
        if (u.op == "-") return -to_number(eval(*u.operand));
        throw std::runtime_error("unknown unary op");
    }

    Value eval_node(const IfExpr& ie) {
        bool cond = to_bool(eval(*ie.cond));
        env_.push();
        Value result = double(0);
        try {
            if (cond)                  exec_stmts(ie.then_body);
            else if (!ie.else_body.empty()) exec_stmts(ie.else_body);
        } catch (...) { env_.pop(); throw; }
        env_.pop();
        return result;
    }

    Value eval_node(const FnExpr& fn) {
        auto f = std::make_shared<CalcFn>();
        f->params = fn.params;
        f->body   = const_cast<StmtList*>(&fn.body);
        return Value(f);
    }

    Value eval_node(const FnCall& fc) {
        Value callee_val = env_.get(fc.callee);
        auto* fn = std::get_if<std::shared_ptr<CalcFn>>(&callee_val);
        if (!fn) throw std::runtime_error("'" + fc.callee + "' is not a function");

        if (fc.args.size() != (*fn)->params.size())
            throw std::runtime_error("wrong arg count for " + fc.callee);

        env_.push();
        for (size_t i = 0; i < fc.args.size(); ++i)
            env_.set((*fn)->params[i], eval(*fc.args[i]));

        Value ret_val = double(0);
        try {
            exec_stmts(*(*fn)->body);
        } catch (ReturnSignal& rs) {
            ret_val = std::move(rs.value);
        }
        env_.pop();
        return ret_val;
    }

    Value eval_node(const AssignExpr& a) {
        Value v = eval(*a.value);
        env_.assign(a.name, v);
        return v;
    }

    void exec_stmts(const StmtList& stmts) {
        for (const auto& s : stmts) exec_stmt(*s);
    }

    void exec_stmt(const Stmt& s) {
        std::visit([this](const auto& node) { exec_node(node); }, s);
    }

    void exec_node(const LetStmt& ls)    { env_.set(ls.name, eval(*ls.value)); }
    void exec_node(const ReturnStmt& rs) { throw ReturnSignal{eval(*rs.value)}; }
    void exec_node(const ExprStmt& es)   { eval(*es.expr); }
    void exec_node(const BlockStmt& bs)  { env_.push(); exec_stmts(bs.stmts); env_.pop(); }
};
```

### Bytecode VM

For performance, compile the AST to bytecode first, then execute the bytecode in a tight loop. The VM is stack-based: instructions push and pop a value stack.

```cpp
#include <cstdint>

enum class Opcode : uint8_t {
    PUSH_CONST,      // push constants[operand]
    LOAD_VAR,        // push locals[operand]
    STORE_VAR,       // locals[operand] = pop()
    ADD, SUB, MUL, DIV,
    CMP_EQ, CMP_NE, CMP_LT, CMP_GT, CMP_LE, CMP_GE,
    NEG,             // pop, push -value
    JMP,             // pc = operand
    JMP_IF_FALSE,    // if pop() == false: pc = operand
    CALL,            // operand = arg count
    RET,
    HALT,
};

struct Instruction {
    Opcode  op;
    int32_t operand = 0;
};

using Bytecode = std::vector<Instruction>;

struct VMFunction {
    std::vector<std::string> params;
    Bytecode                 code;
    std::vector<double>      constants;
};
```

```cpp
class BytecodeCompiler {
    Bytecode            code_;
    std::vector<double> constants_;
    std::unordered_map<std::string, int> locals_;

    int add_constant(double v) {
        constants_.push_back(v);
        return (int)constants_.size() - 1;
    }

    int local_index(const std::string& name) {
        auto it = locals_.find(name);
        if (it != locals_.end()) return it->second;
        int idx = (int)locals_.size();
        locals_[name] = idx;
        return idx;
    }

    size_t emit(Opcode op, int32_t operand = 0) {
        code_.push_back({op, operand});
        return code_.size() - 1;
    }

    void patch(size_t idx, int32_t operand) {
        code_[idx].operand = operand;
    }

public:
    void compile_expr(const Expr& e) {
        std::visit([this](const auto& n) { compile_node(n); }, e);
    }

    void compile_node(const NumberExpr& n) {
        emit(Opcode::PUSH_CONST, add_constant(n.value));
    }

    void compile_node(const IdentExpr& id) {
        emit(Opcode::LOAD_VAR, local_index(id.name));
    }

    void compile_node(const BinaryExpr& b) {
        compile_expr(*b.lhs);
        compile_expr(*b.rhs);
        if      (b.op == "+")  emit(Opcode::ADD);
        else if (b.op == "-")  emit(Opcode::SUB);
        else if (b.op == "*")  emit(Opcode::MUL);
        else if (b.op == "/")  emit(Opcode::DIV);
        else if (b.op == "==") emit(Opcode::CMP_EQ);
        else if (b.op == "!=") emit(Opcode::CMP_NE);
        else if (b.op == "<")  emit(Opcode::CMP_LT);
        else if (b.op == ">")  emit(Opcode::CMP_GT);
        else if (b.op == "<=") emit(Opcode::CMP_LE);
        else if (b.op == ">=") emit(Opcode::CMP_GE);
    }

    void compile_node(const UnaryExpr& u) {
        compile_expr(*u.operand);
        if (u.op == "-") emit(Opcode::NEG);
    }

    void compile_node(const IfExpr& ie) {
        compile_expr(*ie.cond);
        size_t jmp_false = emit(Opcode::JMP_IF_FALSE);

        for (const auto& s : ie.then_body) compile_stmt(*s);

        if (!ie.else_body.empty()) {
            size_t jmp_end = emit(Opcode::JMP);
            patch(jmp_false, (int32_t)code_.size());
            for (const auto& s : ie.else_body) compile_stmt(*s);
            patch(jmp_end, (int32_t)code_.size());
        } else {
            patch(jmp_false, (int32_t)code_.size());
        }
    }

    void compile_node(const FnExpr&)   { /* handled at top level */ }
    void compile_node(const FnCall& fc) {
        for (const auto& arg : fc.args) compile_expr(*arg);
        emit(Opcode::CALL, (int32_t)fc.args.size());
    }
    void compile_node(const AssignExpr& a) {
        compile_expr(*a.value);
        emit(Opcode::STORE_VAR, local_index(a.name));
    }

    void compile_stmt(const Stmt& s) {
        std::visit([this](const auto& n) { compile_stmt_node(n); }, s);
    }

    void compile_stmt_node(const LetStmt& ls) {
        compile_expr(*ls.value);
        emit(Opcode::STORE_VAR, local_index(ls.name));
    }

    void compile_stmt_node(const ReturnStmt& rs) {
        compile_expr(*rs.value);
        emit(Opcode::RET);
    }

    void compile_stmt_node(const ExprStmt& es) {
        compile_expr(*es.expr);
    }

    void compile_stmt_node(const BlockStmt& bs) {
        for (const auto& s : bs.stmts) compile_stmt(*s);
    }

    VMFunction finish() {
        emit(Opcode::HALT);
        VMFunction fn;
        fn.code      = std::move(code_);
        fn.constants = std::move(constants_);
        return fn;
    }
};
```

```cpp
class VM {
    using VMValue = std::variant<double, bool>;
    std::vector<VMValue>  stack_;
    std::vector<VMValue>  locals_;

    VMValue pop() {
        auto v = std::move(stack_.back());
        stack_.pop_back();
        return v;
    }
    void push(VMValue v) { stack_.push_back(std::move(v)); }
    double num(const VMValue& v) { return std::get<double>(v); }
    bool   boo(const VMValue& v) { return std::get<bool>(v); }

public:
    VMValue run(const VMFunction& fn) {
        locals_.resize(64);   // pre-size for local variables
        const auto& code = fn.code;
        int pc = 0;

        while (true) {
            const Instruction& ins = code[pc++];
            switch (ins.op) {
                case Opcode::PUSH_CONST:
                    push(fn.constants[ins.operand]);
                    break;
                case Opcode::LOAD_VAR:
                    push(locals_[ins.operand]);
                    break;
                case Opcode::STORE_VAR:
                    locals_[ins.operand] = pop();
                    break;
                case Opcode::ADD: { auto b=pop(), a=pop(); push(num(a)+num(b)); break; }
                case Opcode::SUB: { auto b=pop(), a=pop(); push(num(a)-num(b)); break; }
                case Opcode::MUL: { auto b=pop(), a=pop(); push(num(a)*num(b)); break; }
                case Opcode::DIV: { auto b=pop(), a=pop(); push(num(a)/num(b)); break; }
                case Opcode::NEG: { auto a=pop(); push(-num(a)); break; }
                case Opcode::CMP_EQ: { auto b=pop(), a=pop(); push(a == b); break; }
                case Opcode::CMP_NE: { auto b=pop(), a=pop(); push(!(a == b)); break; }
                case Opcode::CMP_LT: { auto b=pop(), a=pop(); push(num(a) < num(b));  break; }
                case Opcode::CMP_GT: { auto b=pop(), a=pop(); push(num(a) > num(b));  break; }
                case Opcode::CMP_LE: { auto b=pop(), a=pop(); push(num(a) <= num(b)); break; }
                case Opcode::CMP_GE: { auto b=pop(), a=pop(); push(num(a) >= num(b)); break; }
                case Opcode::JMP:
                    pc = ins.operand;
                    break;
                case Opcode::JMP_IF_FALSE:
                    if (!boo(pop())) pc = ins.operand;
                    break;
                case Opcode::RET:
                    return pop();
                case Opcode::HALT:
                    return stack_.empty() ? VMValue(0.0) : pop();
                default:
                    throw std::runtime_error("unknown opcode");
            }
        }
    }
};
```

### Performance Comparison

| Mode | Throughput | Use case |
|------|-----------|----------|
| Tree-walking interpreter | ~5-10M ops/sec | Prototypes, small scripts |
| Bytecode VM | ~100-300M ops/sec | Python, Lua, Go |
| JIT-compiled (LLVM) | ~1B ops/sec | V8, LuaJIT, Julia |
| Native code | ~3-10B ops/sec | C++, Rust |

The bytecode VM gains ~20× over tree-walking by eliminating pointer chasing through the AST on every iteration and by enabling a tight dispatch loop that the CPU's branch predictor can learn.

### Go Comparison

Go uses a bytecode-style execution for goroutine stacks. The Go compiler's SSA IR (`cmd/compile/internal/ssa`) is conceptually similar to the bytecode above but in static single-assignment form. The `go/ssa` package from `golang.org/x/tools` exposes a user-accessible SSA representation you can use for program analysis. The `github.com/traefik/yaegi` project is a full Go interpreter built in Go, it uses a tree-walking approach for portability, reaching roughly the throughput of the tree-walker above.

---
