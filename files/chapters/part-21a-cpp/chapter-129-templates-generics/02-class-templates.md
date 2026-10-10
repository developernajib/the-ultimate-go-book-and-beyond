## Class Templates

### Basic Syntax

A class template (called a struct template when using `struct`) is a blueprint for generating classes parameterized by types or values.

```cpp
template <typename T>
class Stack {
private:
    std::vector<T> elements_;

public:
    void Push(const T& value) {
        elements_.push_back(value);
    }

    T Pop() {
        if (elements_.empty()) {
            throw std::out_of_range("Stack<>::Pop(): empty stack");
        }
        T top = std::move(elements_.back());
        elements_.pop_back();
        return top;
    }

    const T& Top() const {
        if (elements_.empty()) {
            throw std::out_of_range("Stack<>::Top(): empty stack");
        }
        return elements_.back();
    }

    bool Empty() const { return elements_.empty(); }
    size_t Size() const { return elements_.size(); }
};

int main() {
    Stack<int> intStack;
    intStack.Push(42);
    intStack.Push(17);
    std::cout << intStack.Pop() << "\n";  // 17

    Stack<std::string> stringStack;
    stringStack.Push("hello");
    stringStack.Push("world");
    std::cout << stringStack.Pop() << "\n";  // world
    return 0;
}
```

**Compare with Go:**

```go
type Stack[T any] struct {
    elements []T
}

func (s *Stack[T]) Push(value T) {
    s.elements = append(s.elements, value)
}

func (s *Stack[T]) Pop() (T, error) {
    if len(s.elements) == 0 {
        var zero T
        return zero, errors.New("stack is empty")
    }
    top := s.elements[len(s.elements)-1]
    s.elements = s.elements[:len(s.elements)-1]
    return top, nil
}
```

The structural difference: C++ generates a completely separate `Stack<int>` class and a completely separate `Stack<std::string>` class at compile time. Each one is optimized for its specific type. Go may share a single implementation using dictionaries or may monomorphize, the spec does not mandate either approach.

### Member Functions Defined Outside the Class

When the class definition becomes large, you define member functions outside the class body. Each must repeat the template parameter list.

```cpp
template <typename T>
class Queue {
    std::deque<T> data_;
public:
    void Enqueue(const T& value);
    T Dequeue();
    bool Empty() const;
};

template <typename T>
void Queue<T>::Enqueue(const T& value) {
    data_.push_back(value);
}

template <typename T>
T Queue<T>::Dequeue() {
    if (data_.empty()) {
        throw std::runtime_error("Queue is empty");
    }
    T front = std::move(data_.front());
    data_.pop_front();
    return front;
}

template <typename T>
bool Queue<T>::Empty() const {
    return data_.empty();
}
```

### Static Members

Each instantiation of a class template gets its own copy of static members. This is a critical detail that catches many developers off guard.

```cpp
template <typename T>
class Counter {
public:
    static int count;
    Counter() { ++count; }
    ~Counter() { --count; }
};

template <typename T>
int Counter<T>::count = 0;

int main() {
    Counter<int> a, b, c;
    Counter<double> x, y;

    std::cout << Counter<int>::count << "\n";    // 3
    std::cout << Counter<double>::count << "\n";  // 2
    // int and double instantiations have completely separate counters
    return 0;
}
```

This means `Counter<int>` and `Counter<double>` are truly independent classes. They share no state. If you need a single counter across all instantiations, you must use a non-template base class:

```cpp
class CounterBase {
protected:
    static inline int total_count_ = 0;
};

template <typename T>
class Counter : public CounterBase {
public:
    static int count;
    Counter() { ++count; ++total_count_; }
    ~Counter() { --count; --total_count_; }
    static int TotalCount() { return total_count_; }
};

template <typename T>
int Counter<T>::count = 0;
```

### Template Aliases

C++11 introduced `using` for template aliases, which simplify complex template types.

```cpp
template <typename T>
using Vec = std::vector<T>;

template <typename K, typename V>
using Map = std::unordered_map<K, V>;

Vec<int> numbers = {1, 2, 3};
Map<std::string, int> ages = {{"Alice", 30}, {"Bob", 25}};
```

Prior to Go 1.24, Go did not support parameterized type aliases. Starting in Go 1.24 (and standard in Go 1.27.1), Go supports generic type aliases (e.g., `type Set[T comparable] = map[T]struct{}`), similar to C++ `using` template aliases.

### Friend Functions and Templates

Declaring friend functions inside class templates requires care:

```cpp
template <typename T>
class Box {
    T value_;
public:
    explicit Box(T v) : value_(std::move(v)) {}

    // Friend declaration for operator<< -- note the extra template parameter
    template <typename U>
    friend std::ostream& operator<<(std::ostream& os, const Box<U>& b);

    // Friend declaration for a specific instantiation
    friend bool operator==(const Box& lhs, const Box& rhs) {
        return lhs.value_ == rhs.value_;
    }
};

template <typename U>
std::ostream& operator<<(std::ostream& os, const Box<U>& b) {
    return os << "Box(" << b.value_ << ")";
}
```

---
