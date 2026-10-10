## Google Coding Round in C++

The Google coding round is 45 minutes with one interviewer, in a shared editor (Google Docs or CoderPad). The problems are similar to LeetCode medium and hard, but the bar is different. This file covers what differs, what gets you a Strong Hire, and five sample problems with grading.

### What Differs from Generic LeetCode

LeetCode optimizes for "find the trick". Google's coding round optimizes for "write production-quality code under time pressure".

#### Differences in priority

| LeetCode habit | Google rubric |
|----------------|---------------|
| Get the optimal solution fast | Get a correct solution, then discuss optimization |
| Skip edge cases | Enumerate edge cases first, write tests last |
| One-letter variable names | Real names (`left`, `right` not `l`, `r`) |
| Tight code, often unreadable | Clean code that another engineer can review |
| Quiet thinking | Constant communication |

#### Idioms accepted

Modern C++ is welcomed. Use:

- `std::ranges` algorithms (C++20). `std::ranges::sort(v)`, `std::ranges::find(v, x)`.
- Structured bindings: `auto [it, ok] = m.try_emplace(k, v);`.
- `std::optional<T>` for "maybe a value".
- `std::variant<A, B, C>` for tagged unions.
- `std::span<T>` for non-owning views over contiguous data.
- `auto` where the type is not informative.
- `if constexpr` for template branches.
- Lambdas with `[&]` capture for inline helpers.

#### Idioms to avoid

- `using namespace std;` at file scope. Junior signal.
- Raw `new` / `delete`. Use `std::make_unique`.
- C-style casts. Use `static_cast`, `reinterpret_cast`, `const_cast`.
- C arrays. Use `std::array` or `std::vector`.
- `printf` debug logs. The interviewer scores you on the final solution, not your debug strategy.
- Premature optimization. Get correctness first.

### Error Handling

Pick a convention and stick to it. The two acceptable approaches:

- Return `std::optional<T>` or `std::expected<T, E>` (C++23) or `absl::StatusOr<T>` for fallible functions.
- Throw exceptions, but only if you confirm with the interviewer.

In an interview, "I'd return optional" is a clean answer. Throwing exceptions in a 30-line solution is overkill and signals you have not internalized the no-exceptions style of large C++ shops.

For input invariants:

```cpp
if (input.empty()) return std::nullopt;
```

State the invariant out loud. Do not silently ignore.

### Edge Case Coverage

Before declaring "done", walk through:

- Empty input.
- Single element.
- All elements equal.
- Maximum size (does anything overflow `int`? Switch to `int64_t`).
- Negative numbers if the spec allows.
- Duplicates.
- Already sorted, reverse sorted.

This walkthrough is part of your grade. A candidate who says "let me check the edge cases" and finds two bugs is rated higher than one who says "I think it works" and ships untested code.

### Sample Problem 1: Merge K Sorted Lists

Given K sorted vectors, return one sorted vector containing all elements.

#### L4 expected solution

Min-heap of (value, list index, position):

```cpp
std::vector<int> MergeKSorted(const std::vector<std::vector<int>>& lists) {
  using Entry = std::tuple<int, size_t, size_t>;  // value, list_idx, pos
  std::priority_queue<Entry, std::vector<Entry>, std::greater<>> pq;
  for (size_t i = 0; i < lists.size(); ++i) {
    if (!lists[i].empty()) pq.emplace(lists[i][0], i, 0);
  }
  std::vector<int> result;
  while (!pq.empty()) {
    auto [val, list_idx, pos] = pq.top();
    pq.pop();
    result.push_back(val);
    if (pos + 1 < lists[list_idx].size()) {
      pq.emplace(lists[list_idx][pos + 1], list_idx, pos + 1);
    }
  }
  return result;
}
```

Time: O(N log K). Space: O(K) for the heap.

#### What earns a Good rating

- Reserves the result vector size up front: `result.reserve(total_size)`.
- Mentions the alternative: divide and conquer pairwise merge, same time complexity, same space as a recursion stack.
- Edge cases enumerated: empty lists, K=1, all-empty input.

#### What earns Excellent

- Discusses the cache behavior of a heap-based merge for very large K (poor due to scattered accesses) and proposes a tournament tree as a cache-friendlier alternative.
- Writes a quick test: 2 lists, overlapping ranges, verify output sorted.

### Sample Problem 2: Design a Rate Limiter

Implement `bool TryAcquire()` that returns true at most R times per second per token bucket.

#### Solution

Token bucket. Refill on demand, do not run a background thread.

```cpp
class TokenBucket {
 public:
  TokenBucket(double rate_per_sec, double burst)
      : rate_(rate_per_sec), capacity_(burst), tokens_(burst),
        last_(std::chrono::steady_clock::now()) {}

  bool TryAcquire() {
    std::lock_guard l(mu_);
    Refill();
    if (tokens_ >= 1.0) {
      tokens_ -= 1.0;
      return true;
    }
    return false;
  }

 private:
  void Refill() {
    auto now = std::chrono::steady_clock::now();
    double elapsed = std::chrono::duration<double>(now - last_).count();
    tokens_ = std::min(capacity_, tokens_ + elapsed * rate_);
    last_ = now;
  }

  std::mutex mu_;
  double rate_, capacity_, tokens_;
  std::chrono::steady_clock::time_point last_;
};
```

#### Discussion points

- Why `steady_clock` and not `system_clock`. NTP jumps would break a system_clock implementation.
- Lock-free version: use `std::atomic` with compare-exchange on tokens. More complex, only worth it under heavy contention.
- Sliding window log alternative for stricter accuracy. Higher memory cost.
- Distributed rate limiting: Redis-backed counter with Lua script for atomicity.

#### What earns Excellent

The candidate notices that the lock is held during `Refill`, which calls into the clock. They mention that `steady_clock::now()` is fast (vDSO call) but under extreme contention the lock is the bottleneck, and propose either striping by token-bucket-id or a CAS-based design.

### Sample Problem 3: Find the Median of a Stream

Given a stream of integers, return the running median after each insert.

#### Solution

Two heaps. Lower half as a max-heap, upper half as a min-heap. Balance after each insert.

```cpp
class MedianStream {
 public:
  void Insert(int x) {
    if (lower_.empty() || x <= lower_.top()) lower_.push(x);
    else upper_.push(x);
    Balance();
  }

  double Median() const {
    if (lower_.size() == upper_.size()) {
      return (lower_.top() + upper_.top()) / 2.0;
    }
    return lower_.size() > upper_.size() ? lower_.top() : upper_.top();
  }

 private:
  void Balance() {
    if (lower_.size() > upper_.size() + 1) {
      upper_.push(lower_.top());
      lower_.pop();
    } else if (upper_.size() > lower_.size()) {
      lower_.push(upper_.top());
      upper_.pop();
    }
  }

  std::priority_queue<int> lower_;
  std::priority_queue<int, std::vector<int>, std::greater<>> upper_;
};
```

Time: O(log N) per insert. O(1) for median.

#### What earns Good

The candidate handles `Median()` on an empty stream (returns NaN, throws, or asserts, with the choice stated up front). Discusses overflow when summing two large ints.

#### What earns Excellent

Mentions that for a windowed median (last K elements only), the heap approach does not work, and proposes a balanced BST or a multiset.

### Sample Problem 4: LRU Cache

`Get(key)` returns the value, marking it most recently used. `Put(key, value)` inserts, evicting the LRU if full.

#### Solution

`std::list<std::pair<K, V>>` for the order, `std::unordered_map<K, list_iter>` for O(1) lookup.

```cpp
template <typename K, typename V>
class LRUCache {
 public:
  explicit LRUCache(size_t capacity) : capacity_(capacity) {}

  std::optional<V> Get(const K& key) {
    auto it = index_.find(key);
    if (it == index_.end()) return std::nullopt;
    order_.splice(order_.begin(), order_, it->second);
    return it->second->second;
  }

  void Put(const K& key, V value) {
    auto it = index_.find(key);
    if (it != index_.end()) {
      it->second->second = std::move(value);
      order_.splice(order_.begin(), order_, it->second);
      return;
    }
    if (order_.size() == capacity_) {
      index_.erase(order_.back().first);
      order_.pop_back();
    }
    order_.emplace_front(key, std::move(value));
    index_[key] = order_.begin();
  }

 private:
  size_t capacity_;
  std::list<std::pair<K, V>> order_;
  std::unordered_map<K, typename std::list<std::pair<K, V>>::iterator> index_;
};
```

#### What earns Excellent

The candidate notes that `std::list` has poor cache locality and proposes an intrusive doubly-linked-list of nodes inside an arena, or `boost::intrusive::list`. Mentions that `splice` does not invalidate iterators, which is why this design works.

### Sample Problem 5: Word Ladder Length

Given start, end, and a dictionary, return the shortest transformation length where each step changes one letter and is in the dictionary.

#### Solution

BFS over a graph where edges connect words differing by one letter. Build adjacency on the fly using wildcard patterns.

```cpp
int WordLadderLength(const std::string& begin, const std::string& end,
                     const std::unordered_set<std::string>& dict) {
  if (!dict.count(end)) return 0;

  std::unordered_map<std::string, std::vector<std::string>> patterns;
  for (const auto& w : dict) {
    for (size_t i = 0; i < w.size(); ++i) {
      std::string pat = w;
      pat[i] = '*';
      patterns[pat].push_back(w);
    }
  }

  std::queue<std::pair<std::string, int>> q;
  q.emplace(begin, 1);
  std::unordered_set<std::string> visited{begin};
  while (!q.empty()) {
    auto [w, dist] = q.front();
    q.pop();
    if (w == end) return dist;
    for (size_t i = 0; i < w.size(); ++i) {
      std::string pat = w;
      pat[i] = '*';
      for (const auto& nxt : patterns[pat]) {
        if (visited.insert(nxt).second) q.emplace(nxt, dist + 1);
      }
    }
  }
  return 0;
}
```

#### What earns Excellent

Mentions bidirectional BFS as the optimization that halves the explored frontier (search from both start and end, meet in the middle). Implements it if time allows.

### Grading Rubric Summary

For each problem, the interviewer scores on:

- Correctness: does it work on all cases?
- Code quality: is it readable? Are names clear?
- Complexity analysis: stated correctly?
- Communication: did you talk through your approach?
- Edge case coverage: did you find them, or did the interviewer point them out?
- Optimization awareness: do you know there's a better solution and articulate the trade-off?

A Good signal is correctness, clean code, stated complexity, communicated approach, edge cases identified by you. An Excellent signal adds optimization discussion, alternative implementations, and tested behavior.

### Senior at FAANG: Coding Is the Floor

For L5 and above, coding is the price of admission. The differentiator is design and behavioral. But a poor coding round derails the whole loop. Practice until 30-minute medium problems are routine. The bar is "another senior engineer reviewing this code on Monday morning would not flag anything as obviously wrong".
