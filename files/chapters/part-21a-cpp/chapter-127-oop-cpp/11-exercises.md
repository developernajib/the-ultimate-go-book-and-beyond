## Exercises

### Exercise 1: Rule of Five String Class

Implement a `MyString` class that manages a dynamically allocated character array. Implement all five special member functions. Track allocations and deallocations by printing messages.

```cpp
class MyString {
public:
    MyString();                              // default constructor
    explicit MyString(const char* str);      // parameterized constructor
    ~MyString();                             // destructor
    MyString(const MyString& other);         // copy constructor
    MyString& operator=(const MyString& other); // copy assignment
    MyString(MyString&& other) noexcept;     // move constructor
    MyString& operator=(MyString&& other) noexcept; // move assignment

    size_t length() const;
    const char* c_str() const;

    friend std::ostream& operator<<(std::ostream& os, const MyString& s);

private:
    char* data_;
    size_t length_;
};
```

Test it with:
```cpp
MyString a("Hello");
MyString b = a;              // copy constructor
MyString c;
c = a;                       // copy assignment
MyString d = std::move(a);   // move constructor
MyString e;
e = std::move(b);            // move assignment
```

### Exercise 2: Shape Hierarchy with Areas and Perimeters

Create an abstract `Shape` class with pure virtual methods `area()` and `perimeter()`. Implement `Circle`, `Rectangle`, `Triangle`, and `RegularPolygon`. Write a function that takes a `std::vector<std::unique_ptr<Shape>>` and prints a sorted report (by area, descending). Implement `operator<` for sorting.

### Exercise 3: Refactor to SOLID

You are given this monolithic class. Refactor it to follow all five SOLID principles:

```cpp
class UserManager {
public:
    void createUser(const std::string& name, const std::string& email) {
        // validate email with regex
        // hash password
        // insert into MySQL database
        // send welcome email via SMTP
        // log to file
        // send metrics to StatsD
    }

    void deleteUser(int id) {
        // find user in MySQL
        // delete from database
        // send goodbye email
        // log to file
    }

    std::string getUserReport(int id) {
        // query MySQL
        // format as HTML
        // return HTML string
    }
};
```

Identify which SOLID principles are violated and create the properly separated classes and interfaces.

### Exercise 4: Thread-Safe LRU Cache

Extend the LRU cache implementation to be thread-safe. Use `std::shared_mutex` for reader-writer locking (multiple concurrent reads, exclusive writes). Benchmark single-threaded vs multi-threaded performance with 1 million operations.

### Exercise 5: Go vs C++ Design Translation

Take the parking lot C++ design and implement it in Go using idiomatic patterns. Then take a Go codebase that uses interfaces and embedding (such as the `io.Reader`/`io.Writer` pattern) and implement the equivalent in C++ using abstract classes and inheritance. Compare the resulting code in terms of lines of code, flexibility, and testability.

---

### Junior → FAANG: Exercise Completion Checklist

For each exercise, verify three things before moving on: (1) the code compiles without warnings under `-Wall -Wextra`, (2) all unit tests pass under ASan, (3) you can explain every design choice in one sentence. If you cannot explain a choice, it was a guess, not a decision, and guesses become bugs.

### Senior @ FAANG: Using These Exercises to Calibrate Candidates

The Go-to-C++ bidirectional translation exercise is particularly useful for calibrating senior candidates: ask them to write both the Go and C++ versions of the same abstraction, then explain the trade-offs. An L5 candidate describes the syntax differences. An L6 candidate describes the design differences (implicit vs. explicit interface satisfaction, the impact on testability, the binary compatibility implications, the performance trade-offs of vtable vs. interface dispatch). Use this as a calibration question in debrief: which dimensions did the candidate surface without prompting?

