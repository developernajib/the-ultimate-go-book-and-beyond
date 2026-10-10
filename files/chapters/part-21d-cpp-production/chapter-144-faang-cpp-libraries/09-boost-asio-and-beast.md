## Boost: Asio and Beast

Boost.Asio is the de facto standard for async I/O in C++. It provides the event loop, socket abstractions, timers, and coroutine integration that the C++ standard library has never standardized. Boost.Beast builds on top of Asio to provide HTTP/1.1 and WebSocket support. Together they are the primary way to build network servers in C++ without pulling in a heavier framework.

### The io_context: C++'s Event Loop

`asio::io_context` is the reactor, the event loop that drives async operations. Work is submitted to it. Threads call `io_context::run()` to process completions.

```cpp
#include <boost/asio.hpp>
namespace asio = boost::asio;
using tcp = asio::ip::tcp;

// Single-threaded event loop
asio::io_context ioc;

// Post a task to run on the io_context's thread
asio::post(ioc, [] {
    std::cout << "Running on io_context thread\n";
});

ioc.run();  // blocks until all work is done

// Multi-threaded: thread pool draining the same io_context
asio::io_context shared_ioc;
std::vector<std::thread> threads;
for (int i = 0; i < 4; ++i) {
    threads.emplace_back([&shared_ioc] { shared_ioc.run(); });
}
for (auto& t : threads) t.join();
```

### Async TCP Server with Accept Loop

The Boost.Asio async TCP server uses a self-perpetuating accept loop: the accept completion handler calls `do_accept()` again before processing the new connection, ensuring the server is always listening for the next client without blocking. Each accepted `tcp::socket` is moved into a shared `Session` object that manages its own async read/write lifetime independently of the acceptor, so the server can handle many concurrent connections on a single `io_context` thread.
```cpp
#include <boost/asio.hpp>
#include <memory>
#include <functional>

namespace asio = boost::asio;
using tcp = asio::ip::tcp;
using error_code = boost::system::error_code;

class TcpSession : public std::enable_shared_from_this<TcpSession> {
    tcp::socket socket_;
    std::array<char, 4096> buf_;

public:
    explicit TcpSession(tcp::socket socket)
        : socket_(std::move(socket)) {}

    void start() { do_read(); }

private:
    void do_read() {
        auto self = shared_from_this();
        socket_.async_read_some(
            asio::buffer(buf_),
            [this, self](error_code ec, size_t bytes_read) {
                if (ec) return;  // connection closed or error
                do_write(bytes_read);
            }
        );
    }

    void do_write(size_t length) {
        auto self = shared_from_this();
        asio::async_write(
            socket_,
            asio::buffer(buf_.data(), length),
            [this, self](error_code ec, size_t /*bytes_written*/) {
                if (!ec) do_read();  // echo server: keep reading
            }
        );
    }
};

class TcpServer {
    tcp::acceptor acceptor_;

public:
    TcpServer(asio::io_context& ioc, uint16_t port)
        : acceptor_(ioc, tcp::endpoint(tcp::v4(), port)) {
        do_accept();
    }

private:
    void do_accept() {
        acceptor_.async_accept([this](error_code ec, tcp::socket socket) {
            if (!ec) {
                std::make_shared<TcpSession>(std::move(socket))->start();
            }
            do_accept();  // accept next connection
        });
    }
};
```

### Strands: Thread-Safe Handlers

In multi-threaded io_context usage, handlers for the same connection can run on different threads. An `asio::strand` serializes handlers for one logical object without a mutex.

```cpp
class SafeSession : public std::enable_shared_from_this<SafeSession> {
    tcp::socket socket_;
    asio::strand<asio::io_context::executor_type> strand_;

public:
    explicit SafeSession(tcp::socket socket)
        : socket_(std::move(socket))
        , strand_(asio::make_strand(socket_.get_executor())) {}

    void async_send(std::string data) {
        // Handler is guaranteed to not overlap with other strand-dispatched handlers
        asio::post(strand_, [this, self = shared_from_this(),
                             data = std::move(data)]() mutable {
            asio::async_write(socket_, asio::buffer(data),
                asio::bind_executor(strand_,
                    [](error_code ec, size_t) { /* handle */ }
                )
            );
        });
    }
};
```

### C++20 Coroutines with Asio

Asio has first-class support for C++20 coroutines, eliminating callback nesting:

```cpp
#include <boost/asio.hpp>
#include <boost/asio/co_spawn.hpp>
#include <boost/asio/use_awaitable.hpp>

namespace asio = boost::asio;
using tcp = asio::ip::tcp;
using asio::awaitable;
using asio::use_awaitable;

awaitable<void> handle_connection(tcp::socket socket) {
    std::array<char, 4096> buf;
    for (;;) {
        // co_await suspends the coroutine, resumes when data arrives
        size_t n = co_await socket.async_read_some(
            asio::buffer(buf), use_awaitable
        );
        co_await asio::async_write(
            socket, asio::buffer(buf, n), use_awaitable
        );
    }
}

awaitable<void> listener(asio::io_context& ioc, uint16_t port) {
    tcp::acceptor acceptor(ioc, {tcp::v4(), port});
    for (;;) {
        tcp::socket socket = co_await acceptor.async_accept(use_awaitable);
        asio::co_spawn(ioc,
            handle_connection(std::move(socket)),
            asio::detached
        );
    }
}
```

This is almost identical to Go's `net.Listen` + goroutine-per-connection pattern, sequential-looking code that is actually async under the hood. The key difference: Go's goroutines are stackful and work without C++20 support. C++20 coroutines require compiler and standard library support but produce lower overhead.

### Boost.Beast: HTTP/1.1 over Asio

Asynchronous I/O with an event loop allows a single thread to manage thousands of concurrent network connections without the overhead of per-connection threads. The example below demonstrates the proactor pattern used by Boost.Asio: posting asynchronous operations and handling their completion callbacks within the event loop.
```cpp
#include <boost/beast/core.hpp>
#include <boost/beast/http.hpp>
namespace beast = boost::beast;
namespace http  = beast::http;

awaitable<void> handle_http(tcp::socket socket) {
    beast::flat_buffer buffer;

    // Read HTTP request
    http::request<http::string_body> req;
    co_await http::async_read(socket, buffer, req, use_awaitable);

    // Build HTTP response
    http::response<http::string_body> res{
        http::status::ok, req.version()
    };
    res.set(http::field::server, "MyServer/1.0");
    res.set(http::field::content_type, "application/json");
    res.body() = R"({"status":"ok"})";
    res.prepare_payload();  // set Content-Length

    // Send response
    co_await http::async_write(socket, res, use_awaitable);
}
```

### WebSocket with Boost.Beast

Asynchronous I/O with an event loop allows a single thread to manage thousands of concurrent network connections without the overhead of per-connection threads. The example below demonstrates the proactor pattern used by Boost.Asio: posting asynchronous operations and handling their completion callbacks within the event loop.
```cpp
#include <boost/beast/websocket.hpp>
namespace websocket = beast::websocket;

awaitable<void> handle_websocket(tcp::socket raw_socket) {
    websocket::stream<tcp::socket> ws(std::move(raw_socket));

    // WebSocket handshake (upgrade from HTTP)
    co_await ws.async_accept(use_awaitable);

    beast::flat_buffer buf;
    for (;;) {
        // Read a message
        co_await ws.async_read(buf, use_awaitable);

        // Echo it back
        ws.text(ws.got_text());
        co_await ws.async_write(buf.data(), use_awaitable);
        buf.consume(buf.size());
    }
}
```

Go comparison: Go's `net/http` package handles all of this in ~10 lines with `http.ListenAndServe` and a handler function. Beast requires explicit buffer management, framing, and connection lifecycle handling. The payoff is control: Beast lets you tune buffer sizes, set precise timeouts per operation, mix HTTP and WebSocket on the same connection, and pipeline requests, things that Go's `net/http` hides. For most services, Go's simplicity wins. For a proxy or gateway at 100k+ connections/second, Beast's control matters.

---
