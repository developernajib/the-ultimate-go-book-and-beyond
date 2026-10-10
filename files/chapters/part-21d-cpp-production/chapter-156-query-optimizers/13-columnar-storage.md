## Columnar Storage

Analytical queries touch a small subset of columns over a large subset of rows. Row-oriented storage forces every page read to bring in unwanted columns. Columnar storage stores values of the same column contiguously, so a scan touches only the bytes that matter. Every analytical engine since 2005 stores data column-wise.

### Apache Parquet Layout

Parquet is the de facto interchange format for the analytical world. The layout is a hierarchy: file, row group, column chunk, page.

```
File
  +- Magic header "PAR1"
  +- Row group 1
  |   +- Column chunk for column A
  |   |    +- Page 1 (dictionary, optional)
  |   |    +- Page 2 (data)
  |   |    +- ...
  |   +- Column chunk for column B
  |   +- ...
  +- Row group 2
  +- ...
  +- Footer (metadata, schema, statistics)
  +- Magic footer "PAR1"
```

A **row group** is a horizontal partition (typically 128 MB to 1 GB of data). Row groups are read-independent: a query that touches column A reads only A's column chunks, but it reads all row groups for those chunks unless statistics let it skip.

A **column chunk** holds the data for one column within one row group, contiguous on disk.

A **page** is the unit of compression and decompression (typically 1 MB). Pages can be dictionary-encoded, plain, RLE, or bit-packed. Pages have a header with statistics (min, max, null count) for predicate pushdown.

The footer contains the schema definition, row group metadata, and offsets. A reader fetches the footer first (4 bytes at the end give the footer length, then read that many bytes back), parses metadata, then issues targeted reads for needed column chunks.

```cpp
#include <cstdint>
#include <vector>

namespace parquet_lite {

struct PageHeader {
    int32_t uncompressed_size;
    int32_t compressed_size;
    int32_t num_values;
    enum class Encoding : uint8_t { Plain, Dict, Rle, BitPacked, DeltaBinary };
    Encoding encoding;
    enum class Codec : uint8_t { Uncompressed, Snappy, Lz4, Zstd, Gzip };
    Codec codec;
    // Page statistics for pushdown.
    bool has_min_max = false;
    int64_t min_int = 0;
    int64_t max_int = 0;
    int64_t null_count = 0;
};

struct ColumnChunkMeta {
    std::string column_name;
    int64_t num_values;
    int64_t total_compressed_size;
    int64_t total_uncompressed_size;
    int64_t data_page_offset;
    int64_t dictionary_page_offset;  // 0 if absent
    std::vector<PageHeader> pages;
    // Aggregated statistics for the whole chunk.
    int64_t min_int = 0;
    int64_t max_int = 0;
    int64_t null_count = 0;
};

struct RowGroupMeta {
    int64_t num_rows;
    int64_t total_byte_size;
    std::vector<ColumnChunkMeta> columns;
};

struct FileMeta {
    std::vector<RowGroupMeta> row_groups;
    std::vector<std::string> schema;  // simplified
    int64_t num_rows;
};

}  // namespace parquet_lite
```

The actual Parquet metadata is Thrift-serialized. The Apache C++ Parquet library (`libparquet`) is the reference. DuckDB has its own minimal Parquet reader in `src/execution/operator/persistent/csv_reader/`.

### Reading Parquet: The Minimum Path

The reader's job: produce vectors of decoded values for the columns the query needs.

```cpp
namespace parquet_lite {

class ParquetReader {
    int fd_;
    FileMeta meta_;

public:
    void Open(const std::string& path);
    void ReadFooter();  // seeks to end, reads metadata length + footer

    // Read one column chunk into a column vector.
    // Returns the number of values decoded.
    size_t ReadColumnChunk(size_t row_group, size_t column,
                           int64_t* out_buffer, uint64_t* out_validity) {
        const auto& chunk = meta_.row_groups[row_group].columns[column];
        size_t total = 0;
        // Read dictionary page if present.
        std::vector<int64_t> dict;
        if (chunk.dictionary_page_offset != 0) {
            dict = ReadDictionary(chunk);
        }
        // Iterate data pages.
        int64_t offset = chunk.data_page_offset;
        for (auto& page : chunk.pages) {
            std::vector<uint8_t> compressed(page.compressed_size);
            pread(fd_, compressed.data(), page.compressed_size, offset);
            offset += page.compressed_size;
            std::vector<uint8_t> uncompressed = Decompress(page.codec, compressed,
                                                            page.uncompressed_size);
            total += DecodePage(page, dict, uncompressed,
                                out_buffer + total, out_validity + total);
        }
        return total;
    }

private:
    std::vector<int64_t> ReadDictionary(const ColumnChunkMeta&);
    std::vector<uint8_t> Decompress(PageHeader::Codec, const std::vector<uint8_t>&, int32_t);
    size_t DecodePage(const PageHeader&, const std::vector<int64_t>&,
                      const std::vector<uint8_t>&, int64_t*, uint64_t*);
};

}  // namespace parquet_lite
```

Three details from production readers:

**Async I/O.** A 128 MB row group on 1 GB/s storage takes 128 ms to read. Reading sequentially blocks decode. The Apache Arrow reader and DuckDB both use async I/O (io_uring on Linux, IOCP on Windows) to overlap reads with decode.

**Vectorized decode.** The decode loop must be vectorized. Decoding 8192 dict-encoded values is one gather instruction (`vpgatherdq` on AVX-512). The Arrow `arrow::util::RleDecoder` does this.

**Predicate pushdown via statistics.** Before reading a column chunk, check its min/max and null count against the query predicate. `WHERE x > 1000` skips chunks where max <= 1000. DuckDB and Spark both implement this.

### Dictionary Encoding

Most columns have low cardinality relative to row count: a `country` column has ~200 distinct values across millions of rows. Dictionary encoding stores each unique value once in a dictionary, then encodes column values as small integer indexes into the dictionary.

```cpp
namespace parquet_lite {

template <typename T>
struct DictEncoded {
    std::vector<T> dictionary;
    std::vector<uint32_t> indices;  // can be packed to fewer bits
};

template <typename T>
DictEncoded<T> DictEncode(const T* values, size_t n) {
    DictEncoded<T> out;
    std::unordered_map<T, uint32_t> map;
    out.indices.reserve(n);
    for (size_t i = 0; i < n; ++i) {
        auto it = map.find(values[i]);
        if (it == map.end()) {
            uint32_t id = static_cast<uint32_t>(out.dictionary.size());
            out.dictionary.push_back(values[i]);
            map[values[i]] = id;
            out.indices.push_back(id);
        } else {
            out.indices.push_back(it->second);
        }
    }
    return out;
}

}  // namespace parquet_lite
```

After dict encoding, the indices can be bit-packed: if there are 200 distinct values, 8 bits per index suffice instead of 32. Parquet wraps dict indices in RLE encoding for further compression of runs.

Dictionary encoding has another benefit: predicate evaluation runs on the dictionary, then on the indices. `WHERE country = 'US'` first finds the dict index for 'US' (one comparison), then filters indices (cheap integer compare). This is 10x faster than comparing strings repeatedly. ClickHouse's `LowCardinality` columns are dict-encoded with this in mind.

### ORC

Apache ORC is the older sibling to Parquet, used heavily in the Hive ecosystem. Layout differences:

- **Stripes** instead of row groups (typically 64 MB).
- **Type-specific encodings** (RunLengthByteEncoder, IntegerRLE, etc.) baked into the spec.
- **More aggressive index granularity** (10K rows per index).

ORC tends to compress slightly better than Parquet on integer-heavy data and slightly worse on string-heavy data. The ecosystem moved toward Parquet because of broader tool support, not technical superiority.

### ClickHouse MergeTree

ClickHouse's MergeTree is not a file format like Parquet. It is a storage engine. Tables are stored as data parts on disk, each part a directory with one file per column.

Key features:

**Sorted by primary key.** Rows are physically sorted by the table's `ORDER BY` clause (which is the primary key, separately from `PRIMARY KEY` in DDL). This enables sparse indexes: an index entry every 8192 rows points into the column files.

**LSM-style merging.** Inserts create new parts. A background process merges parts. Old parts are deleted after merge. Query reads from all parts (the merge tree).

**Per-column compression.** Each column file has its own compression codec (LZ4 default, Zstd common). Columns with low cardinality use dictionary encoding via `LowCardinality(T)`.

**Skipping indexes.** Optional secondary indexes (chapter 15) per column for predicate skipping.

The trade-off versus Parquet: MergeTree is tightly coupled to ClickHouse's executor (it knows about `LowCardinality`, materialized columns, projections). Parquet is a portable format readable by any engine. For self-contained ClickHouse deployments, MergeTree wins. For lake architectures (data shared across Spark, Trino, DuckDB), Parquet wins.

### Sorted-By-Key Compression

When a column is sorted, the values are usually highly compressible. Time series data sorted by timestamp compresses to a few bytes per row using delta-of-delta. Sorted strings compress with prefix encoding.

This is why ClickHouse's `ORDER BY` choice matters so much: it determines compression ratio, scan locality, and skipping index effectiveness. The recommended pattern is to ORDER BY the columns most often filtered, in ascending cardinality order.

### Predicate Pushdown

The optimizer wants to push as much filter work as possible into the scan operator and into the file format reader.

Three levels of pushdown:

1. **Row group / stripe level.** Skip whole row groups based on min/max statistics.
2. **Page level.** Skip pages within a chunk based on page statistics.
3. **Value level.** Decode only values that survive the predicate (predicate evaluation on the dictionary, late materialization).

Parquet supports level 1 and level 2 (column index). MergeTree supports level 1 (granule statistics) and level 3 (PREWHERE, see chapter 16). DuckDB pushes down all three when reading Parquet.

### Adaptive Encoding

Modern engines do not commit to one encoding per column. They sample the first batch, pick the best encoding (dict if low cardinality, RLE if runs, plain otherwise), then encode the rest. ClickHouse's `Compact` parts and the new `Wide` format both use adaptive encoding.

For very wide schemas (1000+ columns), encoding decisions per column are expensive. BigQuery's Capacitor format does cluster-level encoding decisions: the optimizer picks one encoding for a column across many files based on workload patterns.

### Bytes On Disk Versus Bytes In Memory

A 100 GB Parquet file is typically 300-500 GB uncompressed. Reading into memory means decoding. The decode rate must keep pace with the storage read rate.

On a 1 GB/s SSD, decode must run at 3-5 GB/s. LZ4 decompresses at 3-4 GB/s, Zstd at 1-2 GB/s, Snappy at 2-3 GB/s. Parquet readers parallelize decode across cores to keep up.

### Recommended Reading

- Apache Parquet specification (`apache/parquet-format`).
- Melnik et al., "Dremel: Interactive Analysis of Web-Scale Datasets," VLDB 2010.
- Stonebraker et al., "C-Store: A Column-oriented DBMS," VLDB 2005.
- ClickHouse documentation on MergeTree internals.

The next chapter looks at the compression schemes themselves.

---
