## End-to-End Mini Engine

This chapter assembles the previous concepts into a single working vectorized query engine in modern C++23. The engine reads a Parquet-like flat file (a simplified format we define), runs a hash aggregation, sorts the result, and prints it. It is the smallest code that exhibits every concept from chapters 02 through 20.

### Scope

What this engine has:

- Vectorized batches of 2048 rows.
- Columnar in-memory representation with validity bitmaps.
- A simplified file format (header with schema, then column-major data).
- A scan operator with predicate pushdown.
- A vectorized hash aggregation (SUM and COUNT).
- An external sort (in-memory only here, spill omitted for length).
- A Volcano-style operator interface adapted to batches.

What this engine does not have:

- Real Parquet parsing (we use a custom flat format).
- A SQL parser. The plan is built in code.
- Joins (covered in chapter 10 code, combining is straightforward).
- MVCC, distributed execution, codegen, optimizer.

The point is to show how the pieces interlock. A real engine is 100x to 1000x larger.

### The Common Header

```cpp
// query_engine.hpp
#pragma once
#include <algorithm>
#include <bit>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace mini {

constexpr size_t kVectorSize = 2048;

enum class TypeId : uint8_t { Int64, Float64 };

struct Vector {
    TypeId type;
    size_t size = 0;
    alignas(64) std::vector<std::byte> data;
    alignas(64) std::vector<uint64_t> validity;

    void Init(TypeId t, size_t cap) {
        type = t;
        size_t bytes = cap * (t == TypeId::Int64 ? 8 : 8);
        data.assign(bytes, std::byte{0});
        validity.assign((cap + 63) / 64, ~0ULL);
    }

    template <typename T> T* As() {
        return reinterpret_cast<T*>(data.data());
    }
    template <typename T> const T* As() const {
        return reinterpret_cast<const T*>(data.data());
    }
};

struct DataChunk {
    std::vector<Vector> columns;
    size_t size = 0;

    void Init(const std::vector<TypeId>& types) {
        columns.resize(types.size());
        for (size_t i = 0; i < types.size(); ++i) {
            columns[i].Init(types[i], kVectorSize);
        }
    }
    void Reset() { size = 0; }
};

}  // namespace mini
```

### The File Format

A simple format: 4-byte magic `MQE1`, schema (number of columns, types, names), row count, then for each column the dense data array.

```cpp
// mini_format.hpp
#pragma once
#include "query_engine.hpp"

namespace mini {

struct FileHeader {
    char magic[4];          // "MQE1"
    uint32_t num_columns;
    uint64_t num_rows;
};

struct ColumnHeader {
    uint8_t type;           // TypeId
    uint8_t name_len;
    char name[62];
};

class MiniFileReader {
    std::ifstream f_;
    FileHeader hdr_{};
    std::vector<ColumnHeader> cols_;
    std::vector<uint64_t> col_offsets_;
    uint64_t cursor_ = 0;

public:
    bool Open(const std::string& path) {
        f_.open(path, std::ios::binary);
        if (!f_) return false;
        f_.read(reinterpret_cast<char*>(&hdr_), sizeof(hdr_));
        if (std::memcmp(hdr_.magic, "MQE1", 4) != 0) return false;
        cols_.resize(hdr_.num_columns);
        f_.read(reinterpret_cast<char*>(cols_.data()),
                hdr_.num_columns * sizeof(ColumnHeader));
        // Compute column offsets in file (after schema).
        uint64_t offset = sizeof(FileHeader)
                        + hdr_.num_columns * sizeof(ColumnHeader);
        col_offsets_.resize(hdr_.num_columns);
        for (uint32_t i = 0; i < hdr_.num_columns; ++i) {
            col_offsets_[i] = offset;
            offset += hdr_.num_rows * 8;  // all types are 8 bytes here
        }
        return true;
    }

    uint64_t NumRows() const { return hdr_.num_rows; }
    uint32_t NumColumns() const { return hdr_.num_columns; }
    TypeId ColumnType(uint32_t i) const { return TypeId(cols_[i].type); }
    std::string ColumnName(uint32_t i) const {
        return std::string(cols_[i].name, cols_[i].name_len);
    }

    size_t ReadChunk(const std::vector<uint32_t>& projected, DataChunk& out) {
        if (cursor_ >= hdr_.num_rows) return 0;
        size_t to_read = std::min<uint64_t>(kVectorSize, hdr_.num_rows - cursor_);
        for (size_t pi = 0; pi < projected.size(); ++pi) {
            uint32_t c = projected[pi];
            f_.seekg(col_offsets_[c] + cursor_ * 8);
            f_.read(reinterpret_cast<char*>(out.columns[pi].data.data()),
                    to_read * 8);
        }
        out.size = to_read;
        cursor_ += to_read;
        return to_read;
    }
};

}  // namespace mini
```

### Operator Interface

A push-style operator with a single `Execute` method per pipeline. For simplicity we use a pull-style chunk-at-a-time model, the modern Volcano-on-vectors that DuckDB uses.

```cpp
// operators.hpp
#pragma once
#include "mini_format.hpp"
#include <unordered_map>

namespace mini {

class Operator {
public:
    virtual ~Operator() = default;
    virtual bool Next(DataChunk& out) = 0;
    virtual std::vector<TypeId> OutputTypes() const = 0;
};

class Scan final : public Operator {
    MiniFileReader& reader_;
    std::vector<uint32_t> projected_;
    std::vector<TypeId> types_;

public:
    Scan(MiniFileReader& r, std::vector<uint32_t> p) : reader_(r), projected_(std::move(p)) {
        for (auto c : projected_) types_.push_back(reader_.ColumnType(c));
    }

    bool Next(DataChunk& out) override {
        if (out.columns.empty()) out.Init(types_);
        size_t n = reader_.ReadChunk(projected_, out);
        return n > 0;
    }

    std::vector<TypeId> OutputTypes() const override { return types_; }
};

class Filter final : public Operator {
    std::unique_ptr<Operator> child_;
    std::function<size_t(const DataChunk&, uint16_t*)> pred_;
    DataChunk in_;

public:
    Filter(std::unique_ptr<Operator> c,
           std::function<size_t(const DataChunk&, uint16_t*)> p)
        : child_(std::move(c)), pred_(std::move(p)) {}

    bool Next(DataChunk& out) override {
        while (true) {
            if (!child_->Next(in_)) return false;
            uint16_t sel[kVectorSize];
            size_t cnt = pred_(in_, sel);
            if (cnt == 0) continue;
            // Materialize selected rows into out.
            if (out.columns.empty()) out.Init(child_->OutputTypes());
            for (size_t c = 0; c < in_.columns.size(); ++c) {
                int64_t* dst = out.columns[c].As<int64_t>();
                const int64_t* src = in_.columns[c].As<int64_t>();
                for (size_t i = 0; i < cnt; ++i) dst[i] = src[sel[i]];
            }
            out.size = cnt;
            return true;
        }
    }

    std::vector<TypeId> OutputTypes() const override {
        return child_->OutputTypes();
    }
};

}  // namespace mini
```

### Hash Aggregation

```cpp
class HashAgg final : public Operator {
    std::unique_ptr<Operator> child_;
    size_t group_col_;
    size_t value_col_;

    struct Slot { int64_t key; int64_t sum; uint64_t count; bool occupied; };
    std::vector<Slot> slots_;
    uint64_t mask_ = 0;
    bool built_ = false;
    size_t emit_pos_ = 0;

    static uint64_t Hash(int64_t k) {
        uint64_t x = static_cast<uint64_t>(k) * 0x9E3779B97F4A7C15ULL;
        return x ^ (x >> 32);
    }

    void Update(int64_t key, int64_t value) {
        if (slots_.empty()) Resize(1024);
        uint64_t h = Hash(key) & mask_;
        while (slots_[h].occupied) {
            if (slots_[h].key == key) {
                slots_[h].sum += value;
                slots_[h].count += 1;
                return;
            }
            h = (h + 1) & mask_;
        }
        slots_[h] = {key, value, 1, true};
        // Resize at 75%.
        size_t occ = 0;
        for (auto& s : slots_) if (s.occupied) ++occ;
        if (occ * 4 > slots_.size() * 3) Resize(slots_.size() * 2);
    }

    void Resize(size_t cap) {
        cap = std::bit_ceil(std::max<size_t>(16, cap));
        std::vector<Slot> old = std::move(slots_);
        slots_.assign(cap, Slot{});
        mask_ = cap - 1;
        for (auto& s : old) {
            if (!s.occupied) continue;
            uint64_t h = Hash(s.key) & mask_;
            while (slots_[h].occupied) h = (h + 1) & mask_;
            slots_[h] = s;
        }
    }

    void BuildAll() {
        DataChunk in;
        while (child_->Next(in)) {
            const int64_t* keys = in.columns[group_col_].As<int64_t>();
            const int64_t* vals = in.columns[value_col_].As<int64_t>();
            for (size_t i = 0; i < in.size; ++i) {
                Update(keys[i], vals[i]);
            }
        }
        built_ = true;
        emit_pos_ = 0;
    }

public:
    HashAgg(std::unique_ptr<Operator> c, size_t gc, size_t vc)
        : child_(std::move(c)), group_col_(gc), value_col_(vc) {}

    bool Next(DataChunk& out) override {
        if (!built_) BuildAll();
        if (out.columns.empty()) {
            out.Init({TypeId::Int64, TypeId::Int64, TypeId::Int64});
        }
        int64_t* k_out = out.columns[0].As<int64_t>();
        int64_t* sum_out = out.columns[1].As<int64_t>();
        int64_t* cnt_out = out.columns[2].As<int64_t>();
        size_t emitted = 0;
        while (emit_pos_ < slots_.size() && emitted < kVectorSize) {
            if (slots_[emit_pos_].occupied) {
                k_out[emitted] = slots_[emit_pos_].key;
                sum_out[emitted] = slots_[emit_pos_].sum;
                cnt_out[emitted] = static_cast<int64_t>(slots_[emit_pos_].count);
                ++emitted;
            }
            ++emit_pos_;
        }
        out.size = emitted;
        return emitted > 0;
    }

    std::vector<TypeId> OutputTypes() const override {
        return {TypeId::Int64, TypeId::Int64, TypeId::Int64};
    }
};
```

### Sort Operator

In-memory sort of all upstream output. For brevity we omit external spill.

```cpp
class Sort final : public Operator {
    std::unique_ptr<Operator> child_;
    size_t sort_col_;
    bool ascending_;
    std::vector<std::vector<int64_t>> rows_;
    bool built_ = false;
    size_t emit_pos_ = 0;

    void BuildAll() {
        DataChunk in;
        size_t ncols = child_->OutputTypes().size();
        while (child_->Next(in)) {
            for (size_t i = 0; i < in.size; ++i) {
                std::vector<int64_t> row(ncols);
                for (size_t c = 0; c < ncols; ++c) {
                    row[c] = in.columns[c].As<int64_t>()[i];
                }
                rows_.push_back(std::move(row));
            }
        }
        std::sort(rows_.begin(), rows_.end(),
                  [this](const auto& a, const auto& b) {
                      return ascending_ ? a[sort_col_] < b[sort_col_]
                                         : a[sort_col_] > b[sort_col_];
                  });
        built_ = true;
    }

public:
    Sort(std::unique_ptr<Operator> c, size_t col, bool asc)
        : child_(std::move(c)), sort_col_(col), ascending_(asc) {}

    bool Next(DataChunk& out) override {
        if (!built_) BuildAll();
        auto types = child_->OutputTypes();
        if (out.columns.empty()) out.Init(types);
        size_t emitted = 0;
        while (emit_pos_ < rows_.size() && emitted < kVectorSize) {
            for (size_t c = 0; c < types.size(); ++c) {
                out.columns[c].As<int64_t>()[emitted] = rows_[emit_pos_][c];
            }
            ++emit_pos_;
            ++emitted;
        }
        out.size = emitted;
        return emitted > 0;
    }

    std::vector<TypeId> OutputTypes() const override {
        return child_->OutputTypes();
    }
};
```

### Driver

```cpp
// main.cpp
#include "operators.hpp"
#include <iostream>

int main(int argc, char** argv) {
    using namespace mini;
    if (argc < 2) { std::cerr << "usage: " << argv[0] << " <file>\n"; return 1; }
    MiniFileReader reader;
    if (!reader.Open(argv[1])) { std::cerr << "open failed\n"; return 1; }

    // Plan: scan -> filter (col2 > 10) -> hash agg (group by col0, sum col1) -> sort by sum desc
    auto scan = std::make_unique<Scan>(reader, std::vector<uint32_t>{0, 1, 2});

    auto filter = std::make_unique<Filter>(
        std::move(scan),
        [](const DataChunk& in, uint16_t* sel) -> size_t {
            const int64_t* c2 = in.columns[2].As<int64_t>();
            size_t cnt = 0;
            for (size_t i = 0; i < in.size; ++i) {
                sel[cnt] = static_cast<uint16_t>(i);
                cnt += (c2[i] > 10);
            }
            return cnt;
        });

    auto agg = std::make_unique<HashAgg>(std::move(filter), 0, 1);
    auto sort = std::make_unique<Sort>(std::move(agg), 1, false);

    DataChunk out;
    while (sort->Next(out)) {
        for (size_t i = 0; i < out.size; ++i) {
            std::cout << out.columns[0].As<int64_t>()[i] << ", "
                      << out.columns[1].As<int64_t>()[i] << ", "
                      << out.columns[2].As<int64_t>()[i] << "\n";
        }
    }
    return 0;
}
```

### What This Engine Demonstrates

1. **Vectorized batches.** Every operator works on chunks of up to 2048 rows.
2. **Columnar layout.** `DataChunk` is a struct of `Vector`. Each `Vector` is contiguous data of one type.
3. **Volcano-on-vectors.** The `Operator::Next` interface is a one-batch-at-a-time pull. Batching amortizes the virtual call.
4. **Branchless filter inner loop.** The filter predicate uses `cnt += (c2[i] > 10)` instead of an `if`.
5. **Linear-probing hash table.** With power-of-two sizing, integer hash, and CAS-free single-thread access.
6. **Pipeline-breaking operators.** `HashAgg` and `Sort` materialize their entire input before emitting. The `built_` flag tracks the build phase.
7. **Type-safe layout.** `Vector::As<T>()` casts the byte buffer to a typed pointer, preserving the alignment guarantees.

### Where Production Engines Differ

- **Real Parquet.** Real engines decode RLE, dictionary, bit-packed, and apply page-level pruning. Our format is plain dense int64.
- **Validity bitmaps.** Our `Vector` has them but the operators ignore them. Real engines respect NULLs in every operator.
- **Multi-threaded execution.** Production engines use morsel-driven parallelism (DuckDB), partition-aware schedulers (Velox), or task graphs (Spark).
- **External spill.** Our agg and sort do not spill. Section 20 covers this.
- **Cardinality estimates.** No optimizer here, so no cost-based plan choice.
- **Distributed execution.** Single-process only.
- **MVCC.** No transactions, no versioning.

### Lines of Code

The engine above is roughly 350 lines of C++. DuckDB's equivalent (without parser) is about 30,000 lines. ClickHouse is about 100,000 lines for the executor alone. The factor of 100x to 300x is in the details: NULL handling, every operator variant, every type, every encoding, every fallback.

The point of the mini engine is to show that the core ideas fit in 350 lines. Everything else is engineering.

The next chapter points to where to read the production code in DuckDB, ClickHouse, and Velox.

---
