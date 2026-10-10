## MapReduce and FlumeJava-Style Pipelines in C++

Google's batch and streaming data processing has evolved through three generations: MapReduce (2004), FlumeJava (2010), and Apache Beam (2016+). The C++ engineer working at FAANG-scale touches at least one of these every week. This file covers the abstractions, the execution model, and the C++ skeletons that implement them.

### Generation 1: MapReduce in C++

The original MapReduce paper described a programming model with two functions: map and reduce. The C++ implementation:

```cpp
class WordCountMapper : public Mapper {
 public:
  void Map(const MapInput& input) override {
    const std::string& line = input.value();
    for (absl::string_view word : absl::StrSplit(line, ' ')) {
      Emit(std::string(word), "1");
    }
  }
};

class WordCountReducer : public Reducer {
 public:
  void Reduce(ReduceInput* input) override {
    int64_t total = 0;
    while (!input->done()) {
      total += std::stoll(input->value());
      input->NextValue();
    }
    Emit(absl::StrCat(total));
  }
};

REGISTER_MAPPER(WordCountMapper);
REGISTER_REDUCER(WordCountReducer);
```

The framework partitions input files, runs mappers in parallel, shuffles keys to reducer shards (sorted), and runs reducers. A combiner (an in-mapper reduce) reduces shuffle volume.

Limitations: every job is exactly one map plus one reduce. Pipelines of N stages mean N MapReduce jobs, with intermediate output to disk between each. For complex DAGs this is slow.

### Generation 2: FlumeJava (and FlumeC++)

FlumeJava (2010 paper) introduced the `PCollection` abstraction: a parallel collection. Operations on PCollections (map, filter, group-by-key, combine) build a deferred DAG. An optimizer fuses adjacent operations and decides which require shuffle. The user writes one program. The framework executes a multi-stage pipeline.

FlumeC++ is the C++ port internal to Google. The same abstractions, same optimizer, exposed in C++.

```cpp
PCollection<std::string>* lines = ReadTextFile("/cns/path/input.txt");
PCollection<std::string>* words = lines->ParDo(
    "split", [](const std::string& line, Emitter<std::string>* out) {
      for (auto w : absl::StrSplit(line, ' ')) out->Emit(std::string(w));
    });
PTable<std::string, int64_t>* counts = words
    ->ParDo("to_kv", [](const std::string& w, Emitter<KV<std::string, int64_t>>* out) {
      out->Emit({w, 1});
    })
    ->GroupByKey()
    ->CombineValues(SumInt64s());

WriteTextFile(counts, "/cns/path/output.txt");
Pipeline::Run();
```

The DAG is built lazily. `Pipeline::Run` triggers optimization (the FlumeJava optimizer fuses ParDos, hoists filters, picks combiner placement) and execution.

### PCollection and PTable

- `PCollection<T>`: an unordered, possibly-distributed collection of T.
- `PTable<K, V>`: a `PCollection<KV<K, V>>` with the special property that `GroupByKey` is allowed.

These are not in-memory. They are handles to deferred computation. You cannot call `.size()` synchronously. You can only chain operations and trigger Run.

### The Execution Model

After optimization, the DAG is split into stages separated by shuffles. Each stage is a sequence of fused ParDos that runs on a single worker without crossing the network. A shuffle:

1. Each upstream worker partitions output by a hash of the key.
2. Partitioned chunks are written to disk (or to colossus / GCS for cloud).
3. Downstream workers read all chunks for their shard, merge-sort by key.
4. Each downstream task receives one (key, iterable<value>) at a time.

The shuffle is the dominant cost in a Flume pipeline. Optimizations:

- Combiner: reduces values per key on the upstream side before shuffle. Shuffle volume drops from N records to one per (worker, key).
- Side inputs: small lookup tables broadcast to every worker, avoiding a join shuffle.
- CoGroupByKey: simultaneous group on multiple inputs, single shuffle for a join.

### Combiners

A combiner is an associative, commutative reducer that the framework can apply incrementally:

```cpp
class SumLong : public CombineFn<int64_t, int64_t, int64_t> {
 public:
  int64_t CreateAccumulator() override { return 0; }
  int64_t AddInput(int64_t acc, const int64_t& x) override { return acc + x; }
  int64_t MergeAccumulators(absl::Span<const int64_t> accs) override {
    int64_t total = 0;
    for (auto a : accs) total += a;
    return total;
  }
  int64_t ExtractOutput(int64_t acc) override { return acc; }
};
```

The four-method protocol (Create, AddInput, Merge, Extract) lets the framework distribute the combine across workers. If you supply only Reduce, the framework cannot combine on the map side.

### Side Inputs

```cpp
PCollection<UserProfile>* profiles = ReadProfiles();
PCollectionView<std::map<int64_t, UserProfile>>* by_id =
    profiles->ToMapView([](const UserProfile& p) { return p.id(); });

PCollection<Event>* events = ReadEvents();
PCollection<EnrichedEvent>* enriched = events->ParDo(
    "enrich",
    [](const Event& e, const std::map<int64_t, UserProfile>& lookup,
       Emitter<EnrichedEvent>* out) {
      auto it = lookup.find(e.user_id());
      if (it == lookup.end()) return;
      EnrichedEvent ee;
      ee.set_event(e);
      ee.set_profile(it->second);
      out->Emit(ee);
    },
    SideInput(by_id));
```

The view materializes the side input on every worker that needs it. Use only when the side data fits in memory per worker (typically under 1 GB).

### Apache Beam C++ SDK

Apache Beam is the open-source successor to FlumeJava. It supports multiple runners (Dataflow, Flink, Spark, Direct). The Java and Python SDKs are mature. The C++ SDK is a more recent addition (since 2022, still moving).

The Beam C++ API mirrors FlumeC++:

```cpp
auto pipeline = beam::Pipeline::Create(options);
auto lines = pipeline->Apply("read", beam::TextIO::Read("gs://bucket/input"));
auto counts = lines
    ->Apply("split", beam::ParDo(SplitWordsFn()))
    ->Apply("count", beam::Count::PerElement<std::string>());
counts->Apply("write", beam::TextIO::Write("gs://bucket/output"));
pipeline->Run();
```

Under Dataflow, the C++ pipeline serializes into a portable graph (the Beam portability protos) and runs in C++ workers. The runner handles autoscaling, fault tolerance, exactly-once semantics.

### Streaming Mode

Beam unifies batch and streaming. A streaming pipeline reads from an unbounded source (Pub/Sub, Kafka), applies windowing (fixed, sliding, sessions), and triggers output (on watermark, on processing time, on count).

```cpp
auto events = pipeline->Apply("pubsub", beam::PubsubIO::Read("projects/p/topics/t"));
auto windowed = events->Apply("window",
    beam::Window::Into<Event>(beam::FixedWindows::Of(beam::Duration::Minutes(1))));
auto counts = windowed->Apply("count", beam::Count::PerElement<std::string>());
```

The watermark tracks the lowest timestamp of any event still in flight. When it passes the end of a window, the framework triggers output.

### Comparison Table

| Aspect | MapReduce | FlumeJava / FlumeC++ | Apache Beam |
|--------|-----------|----------------------|-------------|
| DAG | One M+R | Multi-stage, optimized | Multi-stage, runner-portable |
| API | Mapper / Reducer classes | PCollection chained ops | PCollection chained ops |
| Streaming | No | Limited | First-class |
| Open source | Hadoop is third-party clone | No | Yes |
| Runners | Google MR | Internal Flume scheduler | Dataflow, Flink, Spark, Direct |
| State of art at Google | Retired for new code | Most internal pipelines | Cloud and external |

### A MapReduce-on-C++ Skeleton from Scratch

If you had to build the simplest possible MapReduce in C++, here is the outline:

```cpp
// Coordinator (single process)
struct Task {
  enum Kind { kMap, kReduce };
  Kind kind;
  std::string input_path;     // for map
  int reduce_shard;           // for reduce
  std::atomic<bool> done{false};
};

class Coordinator {
 public:
  void Run() {
    // 1. Split input into M chunks. Create M map tasks.
    // 2. Create R reduce tasks (one per output shard).
    // 3. Listen on a port. Workers ask for tasks, return when done.
    // 4. After all map tasks done, hand out reduce tasks.
    // 5. After all reduce tasks done, exit.
  }
};

// Worker
class Worker {
 public:
  void Run() {
    while (true) {
      Task t = AskCoordinatorForTask();
      if (t.kind == Task::kMap) RunMap(t);
      else if (t.kind == Task::kReduce) RunReduce(t);
      else break;
      ReportDone(t);
    }
  }
  void RunMap(const Task& t) {
    auto in = ReadFile(t.input_path);
    std::vector<std::vector<KV>> shards(R);
    for (auto& kv : Map(in)) shards[Hash(kv.key) % R].push_back(kv);
    for (int r = 0; r < R; ++r) WriteFile(MapOut(t.id, r), shards[r]);
  }
  void RunReduce(const Task& t) {
    std::map<std::string, std::vector<std::string>> grouped;
    for (int m = 0; m < M; ++m) {
      for (auto& kv : ReadFile(MapOut(m, t.reduce_shard)))
        grouped[kv.key].push_back(kv.value);
    }
    auto out = OpenFile(ReduceOut(t.reduce_shard));
    for (auto& [k, vs] : grouped) Reduce(k, vs, &out);
  }
};
```

Real MapReduce (and Hadoop) adds: speculative execution for stragglers, locality-aware task assignment (pick a worker on the same rack as the input), heartbeats and failure detection, durable intermediate storage. The MIT 6.5840 lab implements this in Go and is the canonical learning exercise.

### Junior to FAANG: Pick the Right Layer

A junior writes a custom multi-threaded data processor for a job that should be a Beam pipeline. They reinvent shuffle (badly) and end up with non-deterministic output. A FAANG-track engineer says "this is a group-by-key problem, ship it as a Dataflow job, done in 50 lines".

### Senior at FAANG: Cost and SLA Awareness

Senior engineers think about pipeline cost and SLA. A daily 10 TB shuffle at \$0.05/GB is \$500/day, \$180k/year. Optimizations like combiner placement, side input vs CoGBK, hot-key salting, autoscaling worker counts all move the cost line. The pipeline that runs in 30 minutes for \$50 beats the one that runs in 20 minutes for \$200 unless someone is waiting on the output. Senior engineers own that trade-off, not just the code.
