## LLVM IR and the LLVM Pass Framework

LLVM is a compiler infrastructure used by Clang (C/C++), Swift, Rust, Julia, Zig, and TinyGo. It provides a platform-independent intermediate representation (LLVM IR), a suite of optimization passes, and code generators for x86, ARM, RISC-V, WebAssembly, and more. Understanding LLVM IR makes you literate in how modern compilers work at the machine boundary.

### LLVM IR

LLVM IR is a typed, SSA-form assembly language. SSA, Static Single Assignment, means every variable is assigned exactly once. When a value can come from two different branches, a `phi` instruction merges them.

```llvm
; A simple add function
define i64 @add(i64 %a, i64 %b) {
entry:
  %sum = add i64 %a, %b
  ret i64 %sum
}

; Fibonacci using SSA and phi nodes
define i64 @fib(i64 %n) {
entry:
  %cond = icmp sle i64 %n, 1
  br i1 %cond, label %base_case, label %rec_case

base_case:
  ret i64 %n

rec_case:
  %n_minus_1 = sub i64 %n, 1
  %fib1 = call i64 @fib(i64 %n_minus_1)
  %n_minus_2 = sub i64 %n, 2
  %fib2 = call i64 @fib(i64 %n_minus_2)
  %result = add i64 %fib1, %fib2
  ret i64 %result
}
```

Key IR types: `i1` (bool), `i32`, `i64`, `double`, `ptr`. Every instruction is typed. There are no implicit conversions.

### Emitting LLVM IR from C++ Using the LLVM API

The LLVM C++ API lets you construct IR programmatically. This is the approach used by Clang and rustc.

```cpp
// Requires: llvm-dev package installed
// Compile: clang++ -std=c++17 codegen.cpp $(llvm-config --cxxflags --ldflags --libs core) -o codegen

#include <llvm/IR/LLVMContext.h>
#include <llvm/IR/Module.h>
#include <llvm/IR/IRBuilder.h>
#include <llvm/IR/Function.h>
#include <llvm/IR/BasicBlock.h>
#include <llvm/IR/Type.h>
#include <llvm/IR/Verifier.h>
#include <llvm/Support/raw_ostream.h>
#include <memory>
#include <unordered_map>
#include <stdexcept>

class LLVMCodegen {
    llvm::LLVMContext              ctx_;
    std::unique_ptr<llvm::Module>  module_;
    llvm::IRBuilder<>              builder_;
    std::unordered_map<std::string, llvm::Value*> named_values_;

public:
    LLVMCodegen()
        : module_(std::make_unique<llvm::Module>("calc", ctx_))
        , builder_(ctx_)
    {}

    llvm::Value* codegen_expr(const Expr& e) {
        return std::visit([this](const auto& n) -> llvm::Value* {
            return codegen_node(n);
        }, e);
    }

    llvm::Value* codegen_node(const NumberExpr& n) {
        return llvm::ConstantFP::get(ctx_, llvm::APFloat(n.value));
    }

    llvm::Value* codegen_node(const IdentExpr& id) {
        auto it = named_values_.find(id.name);
        if (it == named_values_.end())
            throw std::runtime_error("undefined variable: " + id.name);
        return it->second;
    }

    llvm::Value* codegen_node(const BinaryExpr& b) {
        llvm::Value* lhs = codegen_expr(*b.lhs);
        llvm::Value* rhs = codegen_expr(*b.rhs);
        if (!lhs || !rhs) return nullptr;

        if (b.op == "+")  return builder_.CreateFAdd(lhs, rhs, "addtmp");
        if (b.op == "-")  return builder_.CreateFSub(lhs, rhs, "subtmp");
        if (b.op == "*")  return builder_.CreateFMul(lhs, rhs, "multmp");
        if (b.op == "/")  return builder_.CreateFDiv(lhs, rhs, "divtmp");
        if (b.op == "<") {
            llvm::Value* cmp = builder_.CreateFCmpULT(lhs, rhs, "cmptmp");
            // Convert bool i1 to double for consistency
            return builder_.CreateUIToFP(cmp, llvm::Type::getDoubleTy(ctx_), "booltmp");
        }
        if (b.op == ">") {
            llvm::Value* cmp = builder_.CreateFCmpUGT(lhs, rhs, "cmptmp");
            return builder_.CreateUIToFP(cmp, llvm::Type::getDoubleTy(ctx_), "booltmp");
        }
        if (b.op == "==") {
            llvm::Value* cmp = builder_.CreateFCmpUEQ(lhs, rhs, "cmptmp");
            return builder_.CreateUIToFP(cmp, llvm::Type::getDoubleTy(ctx_), "booltmp");
        }
        throw std::runtime_error("unknown op: " + b.op);
    }

    llvm::Value* codegen_node(const UnaryExpr& u) {
        llvm::Value* v = codegen_expr(*u.operand);
        if (u.op == "-") return builder_.CreateFNeg(v, "negtmp");
        return nullptr;
    }

    llvm::Value* codegen_node(const IfExpr& ie) {
        llvm::Value* cond = codegen_expr(*ie.cond);
        // Convert double to bool: cond != 0.0
        cond = builder_.CreateFCmpONE(
            cond, llvm::ConstantFP::get(ctx_, llvm::APFloat(0.0)), "ifcond"
        );

        llvm::Function*   fn        = builder_.GetInsertBlock()->getParent();
        llvm::BasicBlock* then_bb   = llvm::BasicBlock::Create(ctx_, "then", fn);
        llvm::BasicBlock* else_bb   = llvm::BasicBlock::Create(ctx_, "else");
        llvm::BasicBlock* merge_bb  = llvm::BasicBlock::Create(ctx_, "ifcont");

        builder_.CreateCondBr(cond, then_bb, else_bb);

        // Then block
        builder_.SetInsertPoint(then_bb);
        llvm::Value* then_val = llvm::ConstantFP::get(ctx_, llvm::APFloat(0.0));
        for (const auto& s : ie.then_body) {
            if (auto* v = codegen_stmt(*s)) then_val = v;
        }
        builder_.CreateBr(merge_bb);
        then_bb = builder_.GetInsertBlock();

        // Else block
        fn->getBasicBlockList().push_back(else_bb);
        builder_.SetInsertPoint(else_bb);
        llvm::Value* else_val = llvm::ConstantFP::get(ctx_, llvm::APFloat(0.0));
        for (const auto& s : ie.else_body) {
            if (auto* v = codegen_stmt(*s)) else_val = v;
        }
        builder_.CreateBr(merge_bb);
        else_bb = builder_.GetInsertBlock();

        // Merge block with phi node
        fn->getBasicBlockList().push_back(merge_bb);
        builder_.SetInsertPoint(merge_bb);
        llvm::PHINode* phi = builder_.CreatePHI(
            llvm::Type::getDoubleTy(ctx_), 2, "iftmp"
        );
        phi->addIncoming(then_val, then_bb);
        phi->addIncoming(else_val, else_bb);
        return phi;
    }

    llvm::Function* codegen_fn(const std::string& name, const FnExpr& fn) {
        std::vector<llvm::Type*> param_types(
            fn.params.size(), llvm::Type::getDoubleTy(ctx_)
        );
        llvm::FunctionType* ft = llvm::FunctionType::get(
            llvm::Type::getDoubleTy(ctx_), param_types, /*vararg=*/false
        );
        llvm::Function* func = llvm::Function::Create(
            ft, llvm::Function::ExternalLinkage, name, module_.get()
        );

        // Name the parameters
        size_t i = 0;
        for (auto& arg : func->args()) arg.setName(fn.params[i++]);

        // Create entry block
        llvm::BasicBlock* bb = llvm::BasicBlock::Create(ctx_, "entry", func);
        builder_.SetInsertPoint(bb);

        // Register parameters as named values
        named_values_.clear();
        for (auto& arg : func->args())
            named_values_[std::string(arg.getName())] = &arg;

        // Generate body
        llvm::Value* ret_val = nullptr;
        for (const auto& s : fn.body) {
            ret_val = codegen_stmt(*s);
        }
        if (ret_val) builder_.CreateRet(ret_val);
        else         builder_.CreateRet(llvm::ConstantFP::get(ctx_, llvm::APFloat(0.0)));

        llvm::verifyFunction(*func);
        return func;
    }

    llvm::Value* codegen_node(const FnCall& fc) {
        llvm::Function* callee_fn = module_->getFunction(fc.callee);
        if (!callee_fn)
            throw std::runtime_error("undefined function: " + fc.callee);

        std::vector<llvm::Value*> args;
        for (const auto& a : fc.args) args.push_back(codegen_expr(*a));
        return builder_.CreateCall(callee_fn, args, "calltmp");
    }

    llvm::Value* codegen_node(const FnExpr&)    { return nullptr; }
    llvm::Value* codegen_node(const AssignExpr&){ return nullptr; }

    llvm::Value* codegen_stmt(const Stmt& s) {
        return std::visit([this](const auto& n) -> llvm::Value* {
            return codegen_stmt_node(n);
        }, s);
    }

    llvm::Value* codegen_stmt_node(const LetStmt& ls) {
        llvm::Value* v = codegen_expr(*ls.value);
        named_values_[ls.name] = v;
        return v;
    }

    llvm::Value* codegen_stmt_node(const ReturnStmt& rs) {
        llvm::Value* v = codegen_expr(*rs.value);
        builder_.CreateRet(v);
        return v;
    }

    llvm::Value* codegen_stmt_node(const ExprStmt& es) {
        return codegen_expr(*es.expr);
    }

    llvm::Value* codegen_stmt_node(const BlockStmt& bs) {
        llvm::Value* last = nullptr;
        for (const auto& s : bs.stmts) last = codegen_stmt(*s);
        return last;
    }

    void dump_ir() const {
        module_->print(llvm::outs(), nullptr);
    }
};
```

### Optimization Passes

LLVM has over 60 optimization passes. The `PassBuilder` API (LLVM 13+) applies a preset optimization pipeline:

```cpp
#include <llvm/Passes/PassBuilder.h>
#include <llvm/Analysis/LoopAnalysisManager.h>
#include <llvm/Analysis/CGSCCPassManager.h>

void run_optimizations(llvm::Module& module) {
    llvm::PassBuilder pb;
    llvm::LoopAnalysisManager     lam;
    llvm::FunctionAnalysisManager fam;
    llvm::CGSCCAnalysisManager    cgam;
    llvm::ModuleAnalysisManager   mam;

    pb.registerModuleAnalyses(mam);
    pb.registerCGSCCAnalyses(cgam);
    pb.registerFunctionAnalyses(fam);
    pb.registerLoopAnalyses(lam);
    pb.crossRegisterProxies(lam, fam, cgam, mam);

    // Build O2-equivalent pipeline
    llvm::ModulePassManager mpm =
        pb.buildPerModuleDefaultPipeline(llvm::OptimizationLevel::O2);
    mpm.run(module, mam);
}
```

After `-O2`, LLVM performs: constant folding, dead code elimination, inlining, loop vectorization, tail call optimization, and register allocation.

### Running the IR

`lli` JIT-executes LLVM IR directly, making it useful for testing the code generator output without a full compilation pipeline. `llc -filetype=obj` compiles IR to a native object file that can be linked with `clang`, giving access to the system's C runtime and libc so the generated code can call `printf` or `malloc` without a custom runtime library.
```bash
# JIT-execute via lli
lli --jit output.ll

# Compile to object file
llc -filetype=obj -march=x86-64 output.ll -o output.o

# Link to executable
clang output.o -o calc_program
```

### Writing a Custom Pass

An analysis pass inspects the IR without modifying it. A transformation pass modifies it. Here is a pass that counts function calls:

```cpp
#include <llvm/IR/PassManager.h>
#include <llvm/IR/Instructions.h>

struct CallCountPass : public llvm::PassInfoMixin<CallCountPass> {
    llvm::PreservedAnalyses run(llvm::Function& f,
                                 llvm::FunctionAnalysisManager&) {
        int call_count = 0;
        for (auto& bb : f) {
            for (auto& inst : bb) {
                if (llvm::isa<llvm::CallInst>(inst)) ++call_count;
            }
        }
        llvm::outs() << f.getName() << " has " << call_count << " call sites\n";
        return llvm::PreservedAnalyses::all(); // read-only: preserve everything
    }
};

// A constant folding transformation pass (simplified):
struct ConstFoldPass : public llvm::PassInfoMixin<ConstFoldPass> {
    llvm::PreservedAnalyses run(llvm::Function& f,
                                 llvm::FunctionAnalysisManager&) {
        for (auto& bb : f) {
            for (auto& inst : bb) {
                // Let LLVM's built-in constant folder handle this in production
                // This shows the structural pattern
                (void)inst;
            }
        }
        return llvm::PreservedAnalyses::none();
    }
};
```

### Go Comparison

TinyGo (`tinygo.org`) compiles Go to LLVM IR, it uses the same `llvm/IR/IRBuilder` API shown above, but from Go via CGo bindings. The standard Go compiler does not use LLVM. It uses its own SSA intermediate representation (`cmd/compile/internal/ssa`), which serves the same purpose (platform-independent typed IR) but is tuned specifically for Go's type system and garbage collector integration. The `golang.org/x/tools/go/ssa` package exposes a SSA form of Go code to user-space analysis tools, `staticcheck` uses it for interprocedural analysis.

---
