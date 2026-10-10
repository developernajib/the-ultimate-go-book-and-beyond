## 4. Building an HTTP Server from Scratch

Let us combine everything into a minimal but functional HTTP/1.1 server.

```cpp
#include <sstream>
#include <string>
#include <string_view>
#include <unordered_map>
#include <functional>

struct HttpRequest {
    std::string method;
    std::string path;
    std::string version;
    std::unordered_map<std::string, std::string> headers;
    std::string body;
};

struct HttpResponse {
    int status_code = 200;
    std::string status_text = "OK";
    std::unordered_map<std::string, std::string> headers;
    std::string body;

    std::string serialize() const {
        std::ostringstream oss;
        oss << "HTTP/1.1 " << status_code << " " << status_text << "\r\n";
        for (const auto& [key, value] : headers) {
            oss << key << ": " << value << "\r\n";
        }
        if (headers.find("Content-Length") == headers.end()) {
            oss << "Content-Length: " << body.size() << "\r\n";
        }
        oss << "\r\n" << body;
        return oss.str();
    }
};

// Incremental HTTP parser - handles partial reads
class HttpParser {
public:
    enum class State { RequestLine, Headers, Body, Complete };

    // Feed data into the parser - returns true when a complete request is ready
    bool feed(const char* data, size_t len) {
        buffer_.append(data, len);

        while (true) {
            if (state_ == State::RequestLine) {
                auto pos = buffer_.find("\r\n");
                if (pos == std::string::npos) return false;

                parse_request_line(buffer_.substr(0, pos));
                buffer_.erase(0, pos + 2);
                state_ = State::Headers;
            }
            else if (state_ == State::Headers) {
                auto pos = buffer_.find("\r\n");
                if (pos == std::string::npos) return false;

                if (pos == 0) {
                    // Empty line - end of headers
                    buffer_.erase(0, 2);
                    auto it = request_.headers.find("Content-Length");
                    if (it != request_.headers.end()) {
                        content_length_ = std::stoul(it->second);
                        state_ = State::Body;
                    } else {
                        state_ = State::Complete;
                        return true;
                    }
                } else {
                    parse_header(buffer_.substr(0, pos));
                    buffer_.erase(0, pos + 2);
                }
            }
            else if (state_ == State::Body) {
                if (buffer_.size() >= content_length_) {
                    request_.body = buffer_.substr(0, content_length_);
                    buffer_.erase(0, content_length_);
                    state_ = State::Complete;
                    return true;
                }
                return false;
            }
            else {
                return true;
            }
        }
    }

    const HttpRequest& request() const { return request_; }

    void reset() {
        state_ = State::RequestLine;
        request_ = {};
        content_length_ = 0;
    }

private:
    void parse_request_line(const std::string& line) {
        std::istringstream iss(line);
        iss >> request_.method >> request_.path >> request_.version;
    }

    void parse_header(const std::string& line) {
        auto colon = line.find(':');
        if (colon != std::string::npos) {
            std::string key = line.substr(0, colon);
            std::string value = line.substr(colon + 1);
            // Trim leading whitespace from value
            size_t start = value.find_first_not_of(' ');
            if (start != std::string::npos) value = value.substr(start);
            request_.headers[key] = value;
        }
    }

    State state_ = State::RequestLine;
    HttpRequest request_;
    std::string buffer_;
    size_t content_length_ = 0;
};

// Minimal HTTP server using our Reactor
class HttpServer {
public:
    using Handler = std::function<HttpResponse(const HttpRequest&)>;

    void route(const std::string& path, Handler handler) {
        routes_[path] = std::move(handler);
    }

    void listen(uint16_t port) {
        int server_fd = create_tcp_server(port);
        set_nonblocking(server_fd);

        Reactor reactor;

        reactor.register_handler(server_fd, EPOLLIN, [&](uint32_t) {
            int client_fd = accept4(server_fd, nullptr, nullptr, SOCK_NONBLOCK);
            if (client_fd < 0) return;
            disable_nagle(client_fd);

            auto parser = std::make_shared<HttpParser>();

            reactor.register_handler(client_fd, EPOLLIN | EPOLLET,
                [this, &reactor, client_fd, parser](uint32_t) {
                    char buf[8192];
                    while (true) {
                        ssize_t n = read(client_fd, buf, sizeof(buf));
                        if (n > 0) {
                            if (parser->feed(buf, n)) {
                                handle_request(client_fd, parser->request());
                                parser->reset();
                            }
                        } else if (n == 0) {
                            reactor.remove_handler(client_fd);
                            close(client_fd);
                            break;
                        } else if (errno == EAGAIN) {
                            break;
                        }
                    }
                });
        });

        std::cout << "HTTP server listening on port " << port << "\n";
        reactor.run();
    }

private:
    void handle_request(int fd, const HttpRequest& req) {
        HttpResponse resp;
        auto it = routes_.find(req.path);
        if (it != routes_.end()) {
            resp = it->second(req);
        } else {
            resp.status_code = 404;
            resp.status_text = "Not Found";
            resp.body = "404 Not Found";
        }
        resp.headers["Connection"] = "keep-alive";
        std::string raw = resp.serialize();
        write(fd, raw.data(), raw.size());
    }

    std::unordered_map<std::string, Handler> routes_;
};

// Usage
int main() {
    HttpServer server;

    server.route("/", [](const HttpRequest&) {
        HttpResponse resp;
        resp.headers["Content-Type"] = "text/plain";
        resp.body = "Hello from C++ HTTP server!";
        return resp;
    });

    server.route("/health", [](const HttpRequest&) {
        HttpResponse resp;
        resp.headers["Content-Type"] = "application/json";
        resp.body = R"({"status":"healthy"})";
        return resp;
    });

    server.listen(8080);
    return 0;
}
```

This server handles keep-alive connections, incremental parsing of partial reads, and non-blocking I/O. A production server would add: write buffering (when `write()` returns `EAGAIN`), timeout management, request size limits to prevent memory exhaustion, and worker thread pools for CPU-intensive handlers.

---
