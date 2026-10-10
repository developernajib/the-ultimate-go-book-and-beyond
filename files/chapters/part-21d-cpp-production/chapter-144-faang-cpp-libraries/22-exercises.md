## Exercises

### Exercise 1: Thread-Safe LRU Cache with absl::flat_hash_map

Implement an `LRUCache<K, V>` with the following contract:
- `get(key)` returns `std::optional<V>`, promotes the entry to MRU position
- `put(key, value)` inserts or updates. Evicts the LRU entry when at capacity
- All operations are thread-safe for concurrent access from multiple goroutines

Use `absl::flat_hash_map` for O(1) lookup and `absl::Mutex` for thread safety. For the LRU ordering, maintain a `std::list<K>` of keys in access order and a separate map from key to list iterator.

```cpp
#include "absl/container/flat_hash_map.h"
#include "absl/synchronization/mutex.h"
#include <list>
#include <optional>

template <typename K, typename V>
class LRUCache {
    struct Entry {
        V                              value;
        typename std::list<K>::iterator lru_iter;
    };

    mutable absl::Mutex               mu_;
    absl::flat_hash_map<K, Entry>     map_  ABSL_GUARDED_BY(mu_);
    std::list<K>                       lru_  ABSL_GUARDED_BY(mu_);
    size_t                             cap_;

public:
    explicit LRUCache(size_t capacity) : cap_(capacity) {
        map_.reserve(capacity + 1);
    }

    std::optional<V> get(const K& key) {
        absl::MutexLock lock(&mu_);
        auto it = map_.find(key);
        if (it == map_.end()) return std::nullopt;

        // Move to front (MRU position)
        lru_.splice(lru_.begin(), lru_, it->second.lru_iter);
        return it->second.value;
    }

    void put(K key, V value) {
        absl::MutexLock lock(&mu_);
        if (auto it = map_.find(key); it != map_.end()) {
            it->second.value = std::move(value);
            lru_.splice(lru_.begin(), lru_, it->second.lru_iter);
            return;
        }

        if (map_.size() >= cap_) {
            // Evict LRU (back of list)
            map_.erase(lru_.back());
            lru_.pop_back();
        }

        lru_.push_front(key);
        map_.emplace(std::move(key), Entry{std::move(value), lru_.begin()});
    }

    size_t size() const {
        absl::ReaderMutexLock lock(&mu_);
        return map_.size();
    }
};
```

**Extend it:** Add a `get_or_load(key, loader)` method that calls `loader(key)` outside the lock (to avoid lock-held I/O), then inserts the result. Handle the case where two threads call `get_or_load` for the same missing key simultaneously.

### Exercise 2: Async Request Pipeline with Folly Futures

Build an async service pipeline that:
1. Validates a `Request` struct (fast, CPU-bound)
2. Fetches user data from a simulated slow store (I/O-bound, 10ms delay)
3. Enriches the response with computed fields (CPU-bound)
4. Handles errors at each stage with appropriate status codes

```cpp
#include <folly/futures/Future.h>
#include <folly/executors/CPUThreadPoolExecutor.h>
#include <folly/executors/IOThreadPoolExecutor.h>

struct Request  { int64_t user_id; std::string query; };
struct UserData { std::string name; int64_t score; };
struct Response { int status; std::string body; };

// Simulates async I/O (use ManualExecutor in tests)
folly::SemiFuture<UserData> fetch_user_async(int64_t user_id);

folly::Future<Response> process(
    const Request& req,
    folly::Executor* cpu_pool,
    folly::Executor* io_pool
) {
    return folly::makeSemiFuture(req)
        .via(cpu_pool)
        .thenValue([](Request r) -> Request {
            if (r.user_id <= 0) throw std::invalid_argument("bad user_id");
            if (r.query.empty()) throw std::invalid_argument("empty query");
            return r;
        })
        .thenValue([io_pool](Request r) {
            return fetch_user_async(r.user_id).via(io_pool);
        })
        .via(cpu_pool)
        .thenValue([](UserData ud) -> Response {
            return Response{200, absl::StrCat(R"({"name":")", ud.name,
                                              R"(","score":)", ud.score, "}")};
        })
        .thenError<std::invalid_argument>([](std::invalid_argument&& ex) {
            return Response{400, ex.what()};
        })
        .thenError(folly::tag_t<std::exception>{}, [](std::exception&& ex) {
            return Response{500, "internal error"};
        });
}
```

**Test it** using `folly::ManualExecutor` to control execution order deterministically. Verify that an invalid `user_id` produces a 400 response, and a simulated I/O failure produces a 500 response, without spawning real threads.

### Exercise 3: gRPC Bidirectional Streaming Chat Service

Implement both sides of a bidirectional streaming gRPC service:

```protobuf
service ChatService {
    rpc Chat(stream ChatMessage) returns (stream ChatMessage);
}
message ChatMessage { string user = 1; string text = 2; int64 timestamp = 3; }
```

Server requirements:
- Maintain a list of active streams
- When a message arrives on any stream, broadcast it to all other active streams
- Handle client disconnection gracefully (check `context->IsCanceled()`)
- Thread-safe broadcast using `absl::Mutex`

```cpp
class ChatServiceImpl final : public chat::ChatService::Service {
    absl::Mutex streams_mu_;
    std::vector<grpc::ServerReaderWriter<ChatMessage, ChatMessage>*>
        active_streams_ ABSL_GUARDED_BY(streams_mu_);

    grpc::Status Chat(
        grpc::ServerContext* ctx,
        grpc::ServerReaderWriter<ChatMessage, ChatMessage>* stream
    ) override {
        {
            absl::MutexLock lock(&streams_mu_);
            active_streams_.push_back(stream);
        }

        ChatMessage msg;
        while (stream->Read(&msg)) {
            msg.set_timestamp(absl::ToUnixMillis(absl::Now()));
            absl::ReaderMutexLock lock(&streams_mu_);
            for (auto* s : active_streams_) {
                if (s != stream) s->Write(msg);
            }
        }

        {
            absl::MutexLock lock(&streams_mu_);
            active_streams_.erase(
                std::remove(active_streams_.begin(), active_streams_.end(), stream),
                active_streams_.end()
            );
        }
        return grpc::Status::OK;
    }
};
```

**Extend it:** Add a message history buffer using `folly::MPMCQueue<ChatMessage>` that replays the last 50 messages to newly connecting clients before joining the live stream.

### Exercise 4: Write-Batched RocksDB Wrapper

Implement a `BatchedWriter` that accumulates writes and flushes them as a `WriteBatch` when either:
- The batch reaches 1000 entries, or
- 10ms has elapsed since the first entry was added

This is the write-coalescing pattern used in production storage systems to amortize fsync overhead.

```cpp
#include "rocksdb/db.h"
#include "rocksdb/write_batch.h"
#include "absl/synchronization/mutex.h"
#include "absl/time/time.h"

class BatchedWriter {
    rocksdb::DB*           db_;
    absl::Mutex            mu_;
    rocksdb::WriteBatch    batch_     ABSL_GUARDED_BY(mu_);
    size_t                 count_     ABSL_GUARDED_BY(mu_) = 0;
    absl::Time             first_at_  ABSL_GUARDED_BY(mu_);
    bool                   has_first_ ABSL_GUARDED_BY(mu_) = false;

    static constexpr size_t kMaxBatch = 1000;
    static constexpr auto   kMaxAge   = absl::Milliseconds(10);

public:
    explicit BatchedWriter(rocksdb::DB* db) : db_(db) {}

    absl::Status write(std::string key, std::string value) {
        absl::MutexLock lock(&mu_);

        if (!has_first_) {
            first_at_  = absl::Now();
            has_first_ = true;
        }

        batch_.Put(key, value);
        ++count_;

        bool should_flush = (count_ >= kMaxBatch) ||
                            (absl::Now() - first_at_ >= kMaxAge);
        if (should_flush) return flush_locked();
        return absl::OkStatus();
    }

    absl::Status flush() {
        absl::MutexLock lock(&mu_);
        return flush_locked();
    }

private:
    absl::Status flush_locked() ABSL_EXCLUSIVE_LOCKS_REQUIRED(mu_) {
        if (count_ == 0) return absl::OkStatus();

        rocksdb::Status s = db_->Write(rocksdb::WriteOptions(), &batch_);
        batch_.Clear();
        count_     = 0;
        has_first_ = false;

        if (!s.ok()) {
            return absl::InternalError(s.ToString());
        }
        return absl::OkStatus();
    }
};
```

**Extend it:** Add a background timer thread that flushes based on age even when no new writes arrive. Use `absl::Notification` to signal clean shutdown.

### Exercise 5: HTTP Server with Boost.Beast

Implement a minimal HTTP/1.1 server using Boost.Beast with C++20 coroutines that:
- Handles `GET /health` → `{"status":"ok"}`
- Handles `GET /echo?msg=...` → echoes the `msg` query parameter as JSON
- Returns `404` for all other paths
- Properly sets `Content-Type`, `Content-Length`, and `Connection` headers
- Handles concurrent connections (one coroutine per connection)

```cpp
#include <boost/asio.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/http.hpp>

namespace asio      = boost::asio;
namespace beast     = boost::beast;
namespace http      = beast::http;
using tcp           = asio::ip::tcp;
using awaitable_t   = asio::awaitable<void>;

http::response<http::string_body>
make_json_response(unsigned version, http::status status, std::string body) {
    http::response<http::string_body> res{status, version};
    res.set(http::field::content_type, "application/json");
    res.set(http::field::connection, "close");
    res.body() = std::move(body);
    res.prepare_payload();
    return res;
}

awaitable_t handle_session(tcp::socket socket) {
    beast::flat_buffer buf;
    http::request<http::string_body> req;

    co_await http::async_read(socket, buf, req, asio::use_awaitable);

    http::response<http::string_body> res;

    if (req.target() == "/health") {
        res = make_json_response(req.version(), http::status::ok,
                                 R"({"status":"ok"})");
    } else if (req.target().starts_with("/echo")) {
        // Parse ?msg= from target
        auto target = std::string(req.target());
        auto pos = target.find("msg=");
        std::string msg = (pos != std::string::npos)
                          ? target.substr(pos + 4) : "";
        res = make_json_response(req.version(), http::status::ok,
                                 absl::StrCat(R"({"msg":")", msg, R"("})"));
    } else {
        res = make_json_response(req.version(), http::status::not_found,
                                 R"({"error":"not found"})");
    }

    co_await http::async_write(socket, res, asio::use_awaitable);
}

awaitable_t run_server(asio::io_context& ioc, uint16_t port) {
    tcp::acceptor acceptor(ioc, {tcp::v4(), port});
    for (;;) {
        tcp::socket socket = co_await acceptor.async_accept(asio::use_awaitable);
        asio::co_spawn(ioc, handle_session(std::move(socket)), asio::detached);
    }
}
```

**Extend it:** Add request logging middleware that records the method, target, status code, and response time for every request using `absl::StrFormat` and `absl::Now()`.

---
