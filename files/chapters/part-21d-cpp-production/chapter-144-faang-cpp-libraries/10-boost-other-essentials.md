## Boost: Multi-index, Graph, and Spirit

Beyond Asio and Beast, Boost contains several libraries that fill gaps the C++ standard library never addressed. Three of these appear regularly in production systems: `Boost.MultiIndex` for containers with multiple access strategies, `Boost.Graph` for graph algorithms, and `Boost.Spirit` for compile-time parser generation. A fourth, `Boost.Geometry`, appears in geo-spatial systems.

### Boost.MultiIndex: One Container, Many Access Patterns

The standard library forces a choice: `std::map` for sorted access, `std::unordered_map` for fast lookup, `std::list` for fast insertion/deletion. `Boost.MultiIndex` provides a single container with all three access strategies simultaneously, keeping all indices consistent on every mutation.

```cpp
#include <boost/multi_index_container.hpp>
#include <boost/multi_index/ordered_index.hpp>
#include <boost/multi_index/hashed_index.hpp>
#include <boost/multi_index/member.hpp>
#include <boost/multi_index/mem_fun.hpp>

namespace bmi = boost::multi_index;

struct Employee {
    int         id;
    std::string name;
    std::string department;
    int         salary;
};

// Tags for index access
struct by_id       {};
struct by_name     {};
struct by_dept     {};

// Container with three simultaneous indices
using EmployeeDB = bmi::multi_index_container<
    Employee,
    bmi::indexed_by<
        // Index 0: unique, ordered by id
        bmi::ordered_unique<
            bmi::tag<by_id>,
            bmi::member<Employee, int, &Employee::id>
        >,
        // Index 1: unique hash by name -- O(1) lookup
        bmi::hashed_unique<
            bmi::tag<by_name>,
            bmi::member<Employee, std::string, &Employee::name>
        >,
        // Index 2: non-unique, ordered by department
        bmi::ordered_non_unique<
            bmi::tag<by_dept>,
            bmi::member<Employee, std::string, &Employee::department>
        >
    >
>;

EmployeeDB employees;

// Insert -- all three indices updated atomically
employees.insert({1, "Alice", "Engineering", 120000});
employees.insert({2, "Bob",   "Engineering", 115000});
employees.insert({3, "Carol", "Marketing",   105000});

// Lookup by id -- O(log n)
auto& id_idx = employees.get<by_id>();
auto it = id_idx.find(1);
if (it != id_idx.end()) {
    std::cout << it->name << "\n";
}

// Lookup by name -- O(1) amortized
auto& name_idx = employees.get<by_name>();
auto name_it = name_idx.find("Alice");

// Range scan by department -- O(log n + results)
auto& dept_idx = employees.get<by_dept>();
auto [begin, end] = dept_idx.equal_range("Engineering");
for (auto it = begin; it != end; ++it) {
    std::cout << it->name << " earns " << it->salary << "\n";
}
```

### Production Pattern: LRU Cache with MultiIndex

The classic LRU cache needs O(1) lookup by key and O(1) eviction of the least recently used entry. With `MultiIndex`, both are achievable without a separate linked list:

```cpp
struct CacheEntry {
    std::string key;
    std::string value;
    int64_t     last_access;  // monotonic sequence number
};

struct by_key    {};
struct by_access {};

using LRUContainer = bmi::multi_index_container<
    CacheEntry,
    bmi::indexed_by<
        bmi::hashed_unique<
            bmi::tag<by_key>,
            bmi::member<CacheEntry, std::string, &CacheEntry::key>
        >,
        bmi::ordered_non_unique<
            bmi::tag<by_access>,
            bmi::member<CacheEntry, int64_t, &CacheEntry::last_access>
        >
    >
>;

class LRUCache {
    LRUContainer  cache_;
    size_t        max_size_;
    int64_t       counter_ = 0;

public:
    explicit LRUCache(size_t max_size) : max_size_(max_size) {}

    std::optional<std::string> get(const std::string& key) {
        auto& key_idx = cache_.get<by_key>();
        auto it = key_idx.find(key);
        if (it == key_idx.end()) return std::nullopt;

        // Update access time -- modify() keeps all indices consistent
        key_idx.modify(it, [this](CacheEntry& e) {
            e.last_access = ++counter_;
        });
        return it->value;
    }

    void put(std::string key, std::string value) {
        auto& key_idx = cache_.get<by_key>();
        if (auto it = key_idx.find(key); it != key_idx.end()) {
            key_idx.modify(it, [&, this](CacheEntry& e) {
                e.value       = std::move(value);
                e.last_access = ++counter_;
            });
            return;
        }

        if (cache_.size() >= max_size_) {
            // Evict least recently used (smallest last_access)
            cache_.get<by_access>().begin();
            cache_.get<by_access>().erase(cache_.get<by_access>().begin());
        }

        cache_.insert({std::move(key), std::move(value), ++counter_});
    }
};
```

### Boost.Graph: Generic Graph Algorithms

Boost.Graph's `adjacency_list` is parameterized on edge container type, vertex container type, and user-defined property bundles, making the same BFS, Dijkstra, and topological sort algorithms reusable across directed, undirected, weighted, and unweighted graphs without virtual dispatch. The visitor pattern used by `breadth_first_search` lets you attach custom callbacks to graph traversal events, discovering a vertex, examining an edge, finishing a subtree, without forking the algorithm implementation.
```cpp
#include <boost/graph/adjacency_list.hpp>
#include <boost/graph/breadth_first_search.hpp>
#include <boost/graph/dijkstra_shortest_paths.hpp>
#include <boost/graph/topological_sort.hpp>

// Define graph type: directed, vertex property = string (name)
using Graph = boost::adjacency_list<
    boost::vecS,        // edge container
    boost::vecS,        // vertex container
    boost::directedS,   // directed graph
    boost::property<boost::vertex_name_t, std::string>,       // vertex properties
    boost::property<boost::edge_weight_t, double>             // edge properties
>;

Graph g;

// Add vertices and edges
auto v_a = boost::add_vertex(g);
auto v_b = boost::add_vertex(g);
auto v_c = boost::add_vertex(g);

boost::add_edge(v_a, v_b, g);
boost::add_edge(v_b, v_c, g);

// Topological sort -- dependency resolution
std::vector<Graph::vertex_descriptor> order;
boost::topological_sort(g, std::back_inserter(order));
// order is in reverse topological order

// Dijkstra -- shortest path from source to all vertices
std::vector<double> distances(boost::num_vertices(g));
boost::dijkstra_shortest_paths(g, v_a,
    boost::distance_map(boost::make_iterator_property_map(
        distances.begin(), boost::get(boost::vertex_index, g)
    ))
);
```

Use cases where `Boost.Graph` appears in production: build system dependency resolution, network topology analysis, state machine validation, and package dependency solving (e.g., `apt` solvers are graph problems).

### Boost.Spirit.X3: Compile-Time Parser Combinators

Spirit.X3 generates parsers entirely at compile time using template metaprogramming. The result is parser code as fast as hand-written recursive descent, with the expressiveness of a combinator library.

```cpp
#include <boost/spirit/home/x3.hpp>

namespace x3 = boost::spirit::x3;

// Parse a simple key=value pair: "key = 42.5"
auto const key    = x3::lexeme[+(x3::alpha | x3::char_('_'))];
auto const value  = x3::double_;
auto const kvpair = key >> '=' >> value;

std::string input = "timeout = 30.5";
auto it = input.begin();

std::pair<std::string, double> result;
bool ok = x3::phrase_parse(
    it, input.end(),
    kvpair,            // grammar rule
    x3::space,         // skip whitespace
    result             // output attribute
);
// result == {"timeout", 30.5}

// More complex: comma-separated list of integers
auto const int_list = x3::int_ % ',';  // int separated by ','

std::string nums = "1, 2, 3, 42, 100";
std::vector<int> values;
x3::phrase_parse(nums.begin(), nums.end(), int_list, x3::space, values);
// values == {1, 2, 3, 42, 100}
```

Spirit.X3 is most valuable for config file parsers, custom DSLs, and data format parsers where you need performance and correctness guarantees that regex cannot provide.

### When to Use Boost vs Modern C++ stdlib

| Need | Before C++17/20 | C++17/20+ |
|------|-----------------|-----------|
| `optional<T>` | `boost::optional` | `std::optional` |
| `variant<T...>` | `boost::variant` | `std::variant` |
| `string_view` | `boost::string_view` | `std::string_view` |
| Filesystem ops | `boost::filesystem` | `std::filesystem` |
| Async I/O | `boost::asio` | Asio (standalone) / C++26 networking TS |
| Multi-key container | `boost::multi_index` | No stdlib equivalent |
| Graph algorithms | `boost::graph` | No stdlib equivalent |
| Parser combinator | `boost::spirit` | No stdlib equivalent |
| Geometry | `boost::geometry` | No stdlib equivalent |

The decision rule: if C++17/20 covers it, use the stdlib. Boost adds compile time and binary size. Reach for Boost only when the stdlib has no answer, and for `MultiIndex`, `Graph`, and `Spirit`, the stdlib still has no answer.

---
