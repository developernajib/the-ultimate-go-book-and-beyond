## SOLID Principles in C++

### Single Responsibility Principle

Each class should have one reason to change.

**Violation:**

```cpp
// BAD: Report class does formatting, calculation, AND persistence
class Report {
public:
    void calculate() { /* business logic */ }
    std::string formatAsHTML() { /* formatting logic */ }
    std::string formatAsJSON() { /* formatting logic */ }
    void saveToFile(const std::string& path) { /* I/O logic */ }
    void sendEmail(const std::string& to) { /* network logic */ }
};
```

**Fix:**

```cpp
class ReportData {
public:
    void calculate();
    long long revenue_cents() const;
    long long expenses_cents() const;
    long long profit_cents() const;
private:
    long long revenue_cents_ = 0;
    long long expenses_cents_ = 0;
};

class ReportFormatter {
public:
    virtual ~ReportFormatter() = default;
    virtual std::string format(const ReportData& data) = 0;
};

class HTMLFormatter : public ReportFormatter {
public:
    std::string format(const ReportData& data) override {
        return "<h1>Revenue: " + std::to_string(data.revenue_cents()) + " cents</h1>";
    }
};

class JSONFormatter : public ReportFormatter {
public:
    std::string format(const ReportData& data) override {
        return R"({"revenue_cents": )" + std::to_string(data.revenue_cents()) + "}";
    }
};

class ReportSaver {
public:
    void saveToFile(const std::string& content, const std::string& path);
};
```

**Go equivalent:**

```go
type ReportData struct {
    RevenueCents  int64
    ExpensesCents int64
}

func (r *ReportData) ProfitCents() int64 { return r.RevenueCents - r.ExpensesCents }

type Formatter interface {
    Format(data ReportData) string
}

type HTMLFormatter struct{}
func (f HTMLFormatter) Format(data ReportData) string {
    return fmt.Sprintf("<h1>Revenue: %d cents</h1>", data.RevenueCents)
}

type JSONFormatter struct{}
func (f JSONFormatter) Format(data ReportData) string {
    return fmt.Sprintf(`{"revenue_cents": %d}`, data.RevenueCents)
}
```

### Open-Closed Principle

Open for extension, closed for modification.

```cpp
// Extensible via new shape classes, without modifying existing code
class Shape {
public:
    virtual ~Shape() = default;
    virtual double area() const = 0;
};

class AreaCalculator {
public:
    // Works with ANY shape, present or future
    double totalArea(const std::vector<std::unique_ptr<Shape>>& shapes) const {
        double total = 0;
        for (const auto& shape : shapes) {
            total += shape->area();
        }
        return total;
    }
};

// Adding a new shape requires ZERO changes to AreaCalculator
class Triangle : public Shape {
public:
    Triangle(double base, double height) : base_(base), height_(height) {}
    double area() const override { return 0.5 * base_ * height_; }
private:
    double base_, height_;
};
```

### Liskov Substitution Principle

Derived classes must be substitutable for their base classes without breaking correctness.

**Classic violation:**

```cpp
class Rectangle {
public:
    virtual void setWidth(double w) { width_ = w; }
    virtual void setHeight(double h) { height_ = h; }
    virtual double area() const { return width_ * height_; }
    virtual ~Rectangle() = default;
protected:
    double width_ = 0, height_ = 0;
};

// LSP VIOLATION: Square changes Rectangle's contract
class Square : public Rectangle {
public:
    void setWidth(double w) override {
        width_ = w;
        height_ = w; // breaks callers who expect independent dimensions
    }
    void setHeight(double h) override {
        width_ = h;
        height_ = h;
    }
};

void doubleWidth(Rectangle& r) {
    double h = r.area() / (r.area() / r.area()); // simplified
    r.setWidth(r.area() / 1); // caller expects only width changes
    // With Square, height also changed: SURPRISE!
}
```

**Fix:** Do not inherit Square from Rectangle. Use separate types or a common interface:

```cpp
class Shape {
public:
    virtual ~Shape() = default;
    virtual double area() const = 0;
};

class Rectangle : public Shape {
public:
    Rectangle(double w, double h) : width_(w), height_(h) {}
    double area() const override { return width_ * height_; }
private:
    double width_, height_;
};

class Square : public Shape {
public:
    explicit Square(double side) : side_(side) {}
    double area() const override { return side_ * side_; }
private:
    double side_;
};
```

### Interface Segregation Principle

No client should be forced to depend on methods it does not use.

**Violation:**

```cpp
// BAD: forces all implementations to handle everything
class Machine {
public:
    virtual ~Machine() = default;
    virtual void print() = 0;
    virtual void scan() = 0;
    virtual void fax() = 0;
};

// A simple printer is forced to implement scan and fax
class SimplePrinter : public Machine {
public:
    void print() override { /* OK */ }
    void scan() override { throw std::runtime_error("Not supported"); }
    void fax() override { throw std::runtime_error("Not supported"); }
};
```

**Fix:**

```cpp
class Printer {
public:
    virtual ~Printer() = default;
    virtual void print() = 0;
};

class Scanner {
public:
    virtual ~Scanner() = default;
    virtual void scan() = 0;
};

class FaxMachine {
public:
    virtual ~FaxMachine() = default;
    virtual void fax() = 0;
};

class SimplePrinter : public Printer {
public:
    void print() override { /* print logic */ }
};

class AllInOneMachine : public Printer, public Scanner, public FaxMachine {
public:
    void print() override { /* print logic */ }
    void scan() override { /* scan logic */ }
    void fax() override { /* fax logic */ }
};
```

**Go comparison:** Go interfaces are naturally segregated because convention favors small interfaces:

```go
type Printer interface { Print() }
type Scanner interface { Scan() }
type Faxer interface  { Fax() }

// Compose when needed
type AllInOne interface {
    Printer
    Scanner
    Faxer
}
```

### Dependency Inversion Principle

High-level modules should not depend on low-level modules. Both should depend on abstractions.

```cpp
// Abstraction
class Logger {
public:
    virtual ~Logger() = default;
    virtual void log(const std::string& message) = 0;
};

// Low-level modules
class ConsoleLogger : public Logger {
public:
    void log(const std::string& message) override {
        std::cout << "[CONSOLE] " << message << "\n";
    }
};

class FileLogger : public Logger {
public:
    explicit FileLogger(const std::string& path) : path_(path) {}
    void log(const std::string& message) override {
        std::ofstream file(path_, std::ios::app);
        file << "[FILE] " << message << "\n";
    }
private:
    std::string path_;
};

// High-level module depends on abstraction, not concrete logger
class OrderService {
public:
    explicit OrderService(std::unique_ptr<Logger> logger)
        : logger_(std::move(logger)) {}

    void placeOrder(const std::string& item) {
        // business logic
        logger_->log("Order placed: " + item);
    }

private:
    std::unique_ptr<Logger> logger_;
};

// Injection at construction
auto service = OrderService(std::make_unique<ConsoleLogger>());
service.placeOrder("Widget");
```

**Go equivalent:**

```go
type Logger interface {
    Log(message string)
}

type ConsoleLogger struct{}
func (l ConsoleLogger) Log(message string) {
    fmt.Printf("[CONSOLE] %s\n", message)
}

type OrderService struct {
    logger Logger
}

func NewOrderService(logger Logger) *OrderService {
    return &OrderService{logger: logger}
}

func (s *OrderService) PlaceOrder(item string) {
    s.logger.Log("Order placed: " + item)
}
```

---

### SOLID in Go vs C++: A Summary

| Principle | C++ Mechanism | Go Mechanism |
|---|---|---|
| Single Responsibility | Split classes, each with one concern | Split structs and functions, organize by package |
| Open-Closed | Abstract base classes, virtual functions | Interfaces, function values, embedding |
| Liskov Substitution | Proper inheritance hierarchies | Proper interface contracts. Embedding is not subtyping |
| Interface Segregation | Multiple small abstract classes | Small interfaces (1-3 methods by convention) |
| Dependency Inversion | Inject abstract class pointers/references | Inject interface values. Accept interfaces, return structs |

Go's type system makes ISP and DIP almost effortless because interfaces are small by convention and satisfied implicitly. In C++, you must explicitly design the class hierarchy, which makes it easier to accidentally create fat interfaces or tight coupling.

---

### Junior → FAANG: Applying SOLID in Code Review, Not Just Design

Junior engineers learn SOLID principles in theory but do not apply them in code review. The practice: when reviewing any C++ class, ask one SOLID question per review cycle. This week: does each class have one reason to change? Next week: do new types need to modify existing code? Over six weeks, you will have applied all five principles systematically.

The SOLID violation most common in C++ codebases is the fat abstract class (ISP violation): a base class with 15 virtual functions where each derived class implements only 5. The sign is `override` on some functions and `= 0` on others, or throwing `std::logic_error("not implemented")` in overrides. The fix: split the fat interface into smaller focused interfaces.

### Senior @ FAANG: SOLID as a Team Culture, Not Individual Practice

At the staff level, SOLID compliance is a team culture issue enforced through code review, style guides, and architectural guidelines.

**SOLID violations as technical debt items.** A staff engineer tracks SOLID violations as technical debt in the team's backlog, not as one-off code review comments. When a fat interface is identified, it becomes a tracked debt item with a migration plan. When a class with multiple responsibilities is identified, it becomes a refactoring milestone. This transforms SOLID from a review comment into a team commitment.

**Dependency injection in C++ without a framework.** Go engineers are accustomed to Go's implicit interface satisfaction as a built-in DI mechanism. C++ requires explicit constructor injection (passing dependencies via constructor parameters typed as abstract base classes or `std::function`). A staff engineer designs the team's DI convention: all dependencies are injected via constructor, no dependency is looked up via global (no service locator pattern), and all injectable types are mockable with gMock. This convention, documented in the team style guide, enables effective unit testing without a DI framework.

**ISP compliance and binary size.** Violating ISP (fat interfaces) has a binary size cost: every virtual method declaration in the vtable takes space in the binary, even if not all derived classes implement it. In a codebase with many subclasses of a fat interface, the vtable overhead is measurable. Splitting a fat interface into smaller interfaces reduces vtable size and may improve instruction cache utilization in hot dispatch paths. A staff engineer includes this in the performance argument for ISP compliance when making the case for a refactoring project.

