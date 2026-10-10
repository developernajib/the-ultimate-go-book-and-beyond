## Exercises

### Exercise 1: Implement a Scope Guard

Write a `ScopeGuard` class that takes any callable and executes it when the scope exits. Support a `dismiss()` method that cancels the cleanup.

```cpp
// Your implementation here
// Usage:
void processFile() {
    FILE* f = fopen("data.txt", "w");
    auto guard = ScopeGuard([&]() { fclose(f); });
    
    // Write data...
    
    if (success) {
        guard.dismiss();  // Don't close -- we'll keep using it
        // transfer f to another owner
    }
    // If we didn't dismiss, fclose runs here
}
```

### Exercise 2: Build a Simple Memory Pool

Implement a fixed-size object pool that:
- Pre-allocates N objects worth of memory
- Supports `allocate()` and `deallocate()` with O(1) complexity
- Uses placement new for construction
- Is type-safe (template class)

### Exercise 3: Find and Fix All Bugs

The snippet below compiles cleanly and still contains several memory bugs of the kinds this chapter cataloged. Find every one before reading the fix list that follows.
```cpp
// This code has 6 memory bugs. Find and fix all of them.
#include <iostream>
#include <cstring>

class StringBuffer {
    char* data_;
    size_t size_;
    
public:
    StringBuffer(const char* str) {
        size_ = strlen(str);
        data_ = new char[size_];        // Bug 1: no room for null terminator
        strcpy(data_, str);              // Bug 2: writes past allocated size
    }
    
    // Bug 3: missing copy constructor -- compiler generates shallow copy
    // Bug 4: missing copy assignment operator
    // Bug 5: missing destructor (memory leak of data_)
    
    char* data() { return data_; }
    size_t size() const { return size_; }
};

void exercise() {
    StringBuffer a("Hello");
    StringBuffer b = a;              // Shallow copy of data_ pointer
    
    std::cout << a.data() << "\n";
    std::cout << b.data() << "\n";
    
    // Bug 6: if a destructor is added without rule-of-three copy controls, double-free occurs
}
```

### Exercise 4: Smart Pointer Refactoring

Refactor this raw-pointer code to use smart pointers with zero manual `delete` calls:

```cpp
class Node {
public:
    int value;
    Node* left;
    Node* right;
    Node* parent;  // Back-pointer to parent
    
    Node(int v) : value(v), left(nullptr), right(nullptr), parent(nullptr) {}
};

class BinaryTree {
    Node* root_;
    
public:
    BinaryTree() : root_(nullptr) {}
    
    void insert(int value) {
        Node* node = new Node(value);
        if (!root_) {
            root_ = node;
            return;
        }
        // ... insertion logic ...
        node->parent = current;
    }
    
    ~BinaryTree() {
        // Must manually traverse and delete every node
        deleteSubtree(root_);
    }
    
    void deleteSubtree(Node* node) {
        if (!node) return;
        deleteSubtree(node->left);
        deleteSubtree(node->right);
        delete node;
    }
};
```

Hint: Children should be `unique_ptr`, and `parent` should be a raw pointer (non-owning back-reference) or `weak_ptr` if shared ownership is needed.

### Exercise 5: Measure GC Impact in Go

Write a Go program that:
1. Allocates 10 million small objects (simulating a cache)
2. Measures GC pause times using `runtime.ReadMemStats`
3. Experiments with different `GOGC` values (50, 100, 200, 400)
4. Reports how GOGC affects memory usage vs GC frequency

Then discuss: how would this workload differ in C++ with manual management?

---

### Junior → FAANG: Treating Memory Exercises as Interview Simulation

Each exercise here simulates a category of FAANG memory question: implementing a scope guard tests RAII understanding, writing a smart pointer tests ownership semantics, building a memory pool tests allocator design. These are not academic. They are the kind of problems asked in Google and Meta C++ interviews at L4/L5.

When completing these exercises, check your implementation against ASan. If ASan finds any issue, treat it as an interview failure and fix it before moving on. An interviewee who submits a smart pointer implementation with a memory leak is not ready for a C++ role at FAANG.

### Senior @ FAANG: Memory Exercises as the Baseline for Team Capability Assessment

At the L6 level, these exercises serve as the baseline for assessing a candidate's C++ memory management capability. An L5 candidate should complete exercises 1 through 4 in 90 minutes with no memory errors under ASan. An L6 candidate should complete all exercises including the Go GC comparison, and should be able to discuss the performance trade-offs of each design choice (arena vs. pool, unique vs. shared, RAII vs. explicit cleanup).

When calibrating a hiring panel, use these exercises as reference points: "this candidate's scope guard implementation was correct but they could not explain why `reset()` must set the pointer to null before calling the destructor (to handle self-assignment)" is the kind of specific calibration note that helps a committee make accurate level decisions.

