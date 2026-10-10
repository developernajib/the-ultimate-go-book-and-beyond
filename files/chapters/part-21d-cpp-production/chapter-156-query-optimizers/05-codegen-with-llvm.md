## Code Generation with LLVM

Vectorization amortizes dispatch cost across batches. Code generation eliminates dispatch entirely. The Hyper paper (Neumann, "Efficiently Compiling Efficient Query Plans for Modern Hardware," VLDB 2011) showed that compiling a query into a single tight loop, with no virtual calls and no batching overhead, beats vectorized engines by another 1.5x to 3x on compute-heavy kernels. The cost is JIT compile time, which can dominate for short queries.

This chapter is about LLVM-based codegen, the data-centric model from Hyper, and when to choose codegen over vectorization.

### The Hyper Model: Data-Centric Pipelines

Hyper's insight is that operators should be classified by whether they pipeline or break the pipeline.

A **pipelining operator** (filter, project, hash probe) consumes a tuple and emits zero or one tuple without buffering. A pipeline-breaking operator (hash build, aggregate, sort) buffers all input before emitting any output.

Hyper compiles each pipeline into a single loop. The loop iterates over the source data and inlines the work of every pipelining operator. Pipeline breakers materialize intermediate state (a hash table, a sort run) and start a new pipeline.

For the query `SELECT SUM(a) FROM t WHERE b > 5`, the generated code is:

```cpp
// Pseudocode of what Hyper generates and JITs.
int64_t sum = 0;
for (size_t i = 0; i < t.row_count; ++i) {
    int64_t b = t.col_b[i];
    if (b > 5) {
        sum += t.col_a[i];
    }
}
return sum;
```

No virtual calls. No batches. The compiler sees the whole loop and applies LICM, SLP vectorization, register allocation across the predicate and the aggregate. The CPU executes one tight kernel.

For a join the pattern is two loops. The first builds the hash table, the second probes:

```cpp
// Pipeline 1: build.
HashTable ht;
for (size_t i = 0; i < r.row_count; ++i) {
    ht.Insert(r.col_key[i], i);
}
// Pipeline 2: probe.
int64_t out_count = 0;
for (size_t j = 0; j < s.row_count; ++j) {
    auto it = ht.Find(s.col_key[j]);
    while (it != ht.End()) {
        out[out_count++] = {it->row_id, j};
        ++it;
    }
}
```

The optimizer assembles pipelines, the codegen lowers each pipeline to LLVM IR, and the JIT compiles the IR to machine code at query start time.

### LLVM IR Basics for Query Engines

LLVM IR is an SSA intermediate representation. A query engine generates IR programmatically using the `llvm::IRBuilder<>` API. Here is the smallest meaningful example: codegen for `x + y` where x and y are loaded from columns.

```cpp
#include <llvm/IR/IRBuilder.h>
#include <llvm/IR/LLVMContext.h>
#include <llvm/IR/Module.h>
#include <llvm/IR/Function.h>
#include <llvm/IR/Verifier.h>

using namespace llvm;

Function* GenAddKernel(LLVMContext& ctx, Module& mod) {
    IRBuilder<> b(ctx);
    Type* i64 = Type::getInt64Ty(ctx);
    Type* i64p = PointerType::get(i64, 0);
    Type* sizet = Type::getInt64Ty(ctx);

    // void add_kernel(int64_t* a, int64_t* b, int64_t* out, size_t n)
    FunctionType* fty = FunctionType::get(
        Type::getVoidTy(ctx), {i64p, i64p, i64p, sizet}, false);
    Function* fn = Function::Create(fty, Function::ExternalLinkage,
                                    "add_kernel", &mod);

    auto args = fn->arg_begin();
    Value* a   = &*args++;
    Value* b2  = &*args++;
    Value* out = &*args++;
    Value* n   = &*args++;

    BasicBlock* entry = BasicBlock::Create(ctx, "entry", fn);
    BasicBlock* loop  = BasicBlock::Create(ctx, "loop",  fn);
    BasicBlock* body  = BasicBlock::Create(ctx, "body",  fn);
    BasicBlock* exit  = BasicBlock::Create(ctx, "exit",  fn);

    b.SetInsertPoint(entry);
    b.CreateBr(loop);

    b.SetInsertPoint(loop);
    PHINode* i = b.CreatePHI(sizet, 2, "i");
    i->addIncoming(ConstantInt::get(sizet, 0), entry);
    Value* cond = b.CreateICmpULT(i, n);
    b.CreateCondBr(cond, body, exit);

    b.SetInsertPoint(body);
    Value* pa  = b.CreateGEP(i64, a,  i);
    Value* pb  = b.CreateGEP(i64, b2, i);
    Value* po  = b.CreateGEP(i64, out, i);
    Value* va  = b.CreateLoad(i64, pa);
    Value* vb  = b.CreateLoad(i64, pb);
    Value* sum = b.CreateAdd(va, vb);
    b.CreateStore(sum, po);
    Value* next = b.CreateAdd(i, ConstantInt::get(sizet, 1));
    i->addIncoming(next, body);
    b.CreateBr(loop);

    b.SetInsertPoint(exit);
    b.CreateRetVoid();

    verifyFunction(*fn, &errs());
    return fn;
}
```

The IR builder produces SSA instructions. After verification, the module is handed to the JIT.

### ORCv2: The Modern LLVM JIT

LLVM's old `ExecutionEngine` and MCJIT are deprecated. ORCv2 is the current API. The skeleton:

```cpp
#include <llvm/ExecutionEngine/Orc/LLJIT.h>
#include <llvm/ExecutionEngine/Orc/ThreadSafeModule.h>
#include <llvm/Support/TargetSelect.h>

using namespace llvm;
using namespace llvm::orc;

class QueryJIT {
    std::unique_ptr<LLJIT> jit_;

public:
    QueryJIT() {
        InitializeNativeTarget();
        InitializeNativeTargetAsmPrinter();
        jit_ = cantFail(LLJITBuilder().create());
    }

    void AddModule(std::unique_ptr<Module> mod,
                   std::unique_ptr<LLVMContext> ctx) {
        cantFail(jit_->addIRModule(
            ThreadSafeModule(std::move(mod), std::move(ctx))));
    }

    template <typename Fn>
    Fn* Lookup(const std::string& name) {
        auto sym = cantFail(jit_->lookup(name));
        return sym.toPtr<Fn>();
    }
};

// Usage:
// QueryJIT jit;
// auto ctx = std::make_unique<LLVMContext>();
// auto mod = std::make_unique<Module>("query", *ctx);
// GenAddKernel(*ctx, *mod);
// jit.AddModule(std::move(mod), std::move(ctx)) - // auto fn = jit.Lookup<void(int64_t*, int64_t*, int64_t*, size_t)>("add_kernel");
// fn(a_buf, b_buf, out_buf, n);
```

The JIT compiles lazily: the symbol resolution at `lookup` triggers compilation. For a query engine you can make this eager by calling `runConstructors()` or by warming up critical functions in the optimizer.

### Pipeline-Breaking Operators

A pipeline breaks at any operator that must materialize state before emitting output. The standard breakers:

- **Hash join build side** (probe is pipelining)
- **Aggregate** (build phase, not the final emit)
- **Sort**
- **Window functions** that need a full partition
- **Set operations** (UNION DISTINCT, INTERSECT)
- **Distributed exchanges** when shuffled

The codegen emits one compiled function per pipeline. The function's "produce" path reads from a source (a scan or a materialized intermediate), runs the inlined operators, and pushes results into the next breaker's "consume" entry point. The Hyper paper formalizes this as `produce()` and `consume()` methods on each operator, where consume is what the parent generates.

### JIT vs AOT vs Vectorized

A new engine in 2026 has three choices.

**Pure JIT (Hyper, Umbra, ImpalaDB old, Spark Tungsten partially).** Best peak throughput on long compute-bound queries. Worst latency for short queries because LLVM compile time is 10 ms to 500 ms per pipeline. Operationally complex (the JIT itself is a moving target, and crashes in JITted code are hard to debug).

**Pure vectorized (DuckDB, ClickHouse, Velox).** Lower peak throughput by 1.3x to 2x on simple kernels but no compile latency. Easier to debug. Easier to integrate with extensions and UDFs. The DuckDB authors have published their reasoning: ad-hoc analytical queries are dominated by short queries where compile time dominates, so vectorization wins.

**Hybrid (Photon, Postgres LLVM JIT).** Use precompiled vectorized kernels for most operators, JIT only the parts that benefit (expression evaluation in projection and filter). Photon does this carefully: the Databricks paper reports 2x speedup over vectorized-only on TPC-DS while keeping JIT compile time under 50 ms per query.

The right choice depends on workload. For interactive analytics (DuckDB use case), vectorization. For long-running ETL (Hyper original use case), JIT. For mixed, hybrid.

### Compile-Time Budget

JIT compile time is real money. A 100 ms compile for a 10 ms query is a 10x slowdown.

LLVM at `-O2` typically compiles 100 to 1000 lines of IR per millisecond. A vectorized engine runs hand-written precompiled kernels at zero cost. A pure JIT engine pays 10 ms to 500 ms per query. Strategies to reduce this:

**Cache compiled functions** keyed by plan signature. If the same query shape runs repeatedly (parameterized prepared statements), compile once.

**Use `OptimizationLevel::Less` (O1)** for short queries. The IR is still vectorized by LLVM but with shorter passes. Hyper uses O0 by default and only escalates to O3 for queries flagged as long-running.

**Skip codegen for trivial expressions.** Postgres only JITs functions when the estimated cost exceeds `jit_above_cost`. Below that, the interpreter wins on total time.

**Warmup pool.** ImpalaDB precompiles common operator templates at server start so the first query of each kind pays only the parameter-substitution cost, not full LLVM optimization.

### Cranelift as an Alternative

Cranelift (the Wasmtime backend) is a faster, less-optimizing JIT. It compiles 10x faster than LLVM but produces code 1.5x slower. For a query engine where compile time matters more than peak throughput, Cranelift is a credible choice. CockroachDB experimented with it for stored procedures. The trade-off is fewer mature optimizations (no full SROA, no advanced loop transforms).

### Debugging JITted Code

Three techniques every codegen engineer needs:

**`llvm::Module::print`** to stdout to see the IR before JITing. Round-trip it through `llc` to see the assembly LLVM would generate.

**GDB JIT integration.** LLVM emits DWARF debug info that GDB can pick up via the `__jit_debug_register_code` interface. Set a breakpoint on a JITted function name like any other.

**Sanitizers.** AddressSanitizer and ThreadSanitizer work on JITted code if you compile the host with them and the JIT respects the runtime hooks. ORCv2 has `JITLink` for this.

### Recommended Reading

- Neumann, "Efficiently Compiling Efficient Query Plans for Modern Hardware," VLDB 2011.
- Kohn, Leis, Neumann, "Adaptive Execution of Compiled Queries," ICDE 2018 (the Umbra paper, which mixes compiled and interpreted execution).
- Photon paper, SIGMOD 2022.
- Postgres LLVM JIT documentation.

The next chapter shifts from execution to estimation: cardinality, the input that makes or breaks every cost-based decision.

---
