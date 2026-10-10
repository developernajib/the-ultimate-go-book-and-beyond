## Dependency Injection Without Frameworks

Dependency injection in C++ requires no framework. The language gives you constructor injection (preferred), template injection (zero overhead), and for complex wiring, a minimal container. Frameworks like Boost.DI exist, but most production codebases get by with explicit manual DI, which is more readable and debuggable than magic reflection-based containers.

### Why DI Matters

DI decouples implementation from construction. Instead of a class creating its own dependencies (`new Database()`), it receives them from outside. This makes unit testing possible (inject a mock), makes swapping implementations easy (inject a different concrete type), and makes dependencies explicit (the constructor signature documents what is needed).

```cpp
// WITHOUT DI: tightly coupled, untestable
class OrderService {
    PaymentProcessor processor_;  // Hard-coded concrete type
    EmailSender      mailer_;

public:
    OrderService()
        : processor_(load_config("payment.json"))
        , mailer_("smtp.example.com")
    {}
    // Cannot test without a real payment processor and SMTP server
};

// WITH DI: decoupled, testable
class OrderService {
    PaymentProcessor& processor_;
    EmailSender&      mailer_;

public:
    OrderService(PaymentProcessor& p, EmailSender& m)
        : processor_(p), mailer_(m) {}
    // In tests: inject MockPaymentProcessor and MockEmailSender
};
```

### Constructor Injection with Interfaces

The preferred C++ DI pattern: depend on abstract types (interfaces via pure virtual base classes or template parameters), receive them in the constructor.

```cpp
#include <memory>
#include <string>
#include <vector>
#include <stdexcept>

// ---- Abstract interfaces ---------------------------------------------------

class IPaymentProcessor {
public:
    virtual ~IPaymentProcessor() = default;
    virtual bool charge(const std::string& token, double amount) = 0;
    virtual bool refund(const std::string& transaction_id) = 0;
};

class IEmailSender {
public:
    virtual ~IEmailSender() = default;
    virtual void send(const std::string& to,
                      const std::string& subject,
                      const std::string& body) = 0;
};

class IOrderRepository {
public:
    virtual ~IOrderRepository() = default;
    virtual void save(const struct Order& order) = 0;
    virtual std::optional<struct Order> find(int id) = 0;
};

// ---- Domain types ----------------------------------------------------------

struct Order {
    int         id;
    std::string customer_token;
    double      total;
    bool        paid = false;
};

// ---- Service: depends only on interfaces -----------------------------------

class OrderService {
    IPaymentProcessor& processor_;
    IEmailSender&      mailer_;
    IOrderRepository&  repo_;

public:
    // Constructor injection -- all dependencies explicit in signature
    OrderService(IPaymentProcessor& p, IEmailSender& m, IOrderRepository& r)
        : processor_(p), mailer_(m), repo_(r) {}

    bool place_order(Order order, const std::string& customer_email) {
        if (!processor_.charge(order.customer_token, order.total)) {
            return false;
        }

        order.paid = true;
        repo_.save(order);

        mailer_.send(customer_email,
                     "Order Confirmed",
                     "Your order #" + std::to_string(order.id) + " is confirmed.");
        return true;
    }
};

// ---- Production implementations --------------------------------------------

class StripePaymentProcessor : public IPaymentProcessor {
public:
    bool charge(const std::string& token, double amount) override {
        // Real Stripe API call
        return true;
    }
    bool refund(const std::string& txn_id) override { return true; }
};

class SmtpEmailSender : public IEmailSender {
    std::string smtp_host_;
public:
    explicit SmtpEmailSender(std::string host) : smtp_host_(std::move(host)) {}
    void send(const std::string&, const std::string&, const std::string&) override {
        // Real SMTP sending
    }
};

// ---- Test implementations (mocks) ------------------------------------------

class MockPaymentProcessor : public IPaymentProcessor {
public:
    bool charge_should_succeed = true;
    std::vector<std::pair<std::string, double>> charges;

    bool charge(const std::string& token, double amount) override {
        charges.push_back({token, amount});
        return charge_should_succeed;
    }
    bool refund(const std::string&) override { return true; }
};

class MockEmailSender : public IEmailSender {
public:
    struct SentEmail { std::string to, subject, body; };
    std::vector<SentEmail> sent;

    void send(const std::string& to, const std::string& s, const std::string& b) override {
        sent.push_back({to, s, b});
    }
};
```

### Template-Based DI: Zero Overhead

If the concrete types are always known at compile time, template parameters eliminate the virtual dispatch cost:

```cpp
template <
    typename PaymentProcessor,
    typename EmailSender,
    typename OrderRepository
>
class OrderServiceT {
    PaymentProcessor& processor_;
    EmailSender&      mailer_;
    OrderRepository&  repo_;

public:
    OrderServiceT(PaymentProcessor& p, EmailSender& m, OrderRepository& r)
        : processor_(p), mailer_(m), repo_(r) {}

    bool place_order(Order order, const std::string& email) {
        if (!processor_.charge(order.customer_token, order.total)) return false;
        order.paid = true;
        repo_.save(order);
        mailer_.send(email, "Confirmed", "Order #" + std::to_string(order.id));
        return true;
    }
};

// Production instantiation
using ProdOrderService = OrderServiceT<StripePaymentProcessor,
                                       SmtpEmailSender,
                                       PostgresOrderRepo>;

// Test instantiation
using TestOrderService = OrderServiceT<MockPaymentProcessor,
                                       MockEmailSender,
                                       InMemoryOrderRepo>;
```

All calls are inlined. No vtable. No virtual dispatch overhead. The downside: `ProdOrderService` and `TestOrderService` are distinct types, you cannot store them in the same `vector` without type erasure.

### A Minimal DI Container

For large applications, wiring constructors manually in `main()` becomes tedious. A minimal container manages lifetimes and resolves dependencies:

```cpp
#include <functional>
#include <unordered_map>
#include <typeindex>
#include <any>
#include <memory>
#include <stdexcept>

class Container {
public:
    // Register a factory for type T
    template <typename T>
    void bind(std::function<std::shared_ptr<T>()> factory) {
        auto key = std::type_index(typeid(T));
        factories_[key] = [f = std::move(factory)]() -> std::any {
            return std::static_pointer_cast<void>(f());
        };
    }

    // Resolve type T -- calls factory on first use, caches result (singleton)
    template <typename T>
    std::shared_ptr<T> resolve() {
        auto key = std::type_index(typeid(T));
        auto it = singletons_.find(key);
        if (it != singletons_.end()) {
            return std::static_pointer_cast<T>(
                std::any_cast<std::shared_ptr<void>>(it->second)
            );
        }
        auto fit = factories_.find(key);
        if (fit == factories_.end()) {
            throw std::runtime_error("type not registered in container");
        }
        auto instance = std::any_cast<std::shared_ptr<void>>(fit->second());
        singletons_[key] = instance;
        return std::static_pointer_cast<T>(instance);
    }

private:
    std::unordered_map<std::type_index, std::function<std::any()>> factories_;
    std::unordered_map<std::type_index, std::any>                  singletons_;
};

// ---- Wiring in main.cpp ----------------------------------------------------

void configure_production(Container& c) {
    c.bind<IPaymentProcessor>([]{ return std::make_shared<StripePaymentProcessor>(); });
    c.bind<IEmailSender>([]{ return std::make_shared<SmtpEmailSender>("smtp.example.com"); });

    c.bind<OrderService>([&c]{
        return std::make_shared<OrderService>(
            *c.resolve<IPaymentProcessor>(),
            *c.resolve<IEmailSender>(),
            *c.resolve<IOrderRepository>()
        );
    });
}
```

This container is ~50 lines and handles the most common case: singleton services resolved on demand. It does not handle scoped lifetimes, circular dependencies, or async construction, use Boost.DI or a purpose-built container when you need those.

### Go Comparison

Go DI is explicit and idiomatic, interfaces plus constructor functions:

```go
type OrderService struct {
    processor PaymentProcessor  // interface
    mailer    EmailSender       // interface
    repo      OrderRepository   // interface
}

func NewOrderService(p PaymentProcessor, m EmailSender, r OrderRepository) *OrderService {
    return &OrderService{processor: p, mailer: m, repo: r}
}
```

The Go community has largely settled on manual wiring or `wire` (a code-generation tool by Google that generates the wiring code from provider annotations). There is no runtime reflection-based container idiom in Go. This aligns well with the C++ approach here: explicit, compile-time-resolved, no magic. Both languages benefit from the same discipline: make dependencies visible in the constructor signature and inject them from the outside.

---
