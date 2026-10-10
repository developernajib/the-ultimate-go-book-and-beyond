## Common Memory Bugs

Memory bugs are the most dangerous class of bugs in C++. They cause crashes, security vulnerabilities, data corruption, and behaviors that are impossible to reproduce. This section shows buggy code alongside fixed versions.

### Bug 1: Memory Leak

A memory leak occurs when heap-allocated memory is never freed.

```cpp
// BUGGY: Memory leak
void processRequest(const Request& req) {
    auto* handler = new RequestHandler(req);
    
    handler->validate();    // Might throw an exception
    handler->process();     // Might return early
    handler->respond();
    
    delete handler;         // Never reached if validate() or process() throws!
}

// FIXED: Use RAII (unique_ptr)
void processRequest(const Request& req) {
    auto handler = std::make_unique<RequestHandler>(req);
    
    handler->validate();    // If this throws, unique_ptr still cleans up
    handler->process();
    handler->respond();
    
    // No delete needed. unique_ptr handles it.
}
```

### Bug 2: Dangling Pointer

A dangling pointer points to memory that has been freed.

```cpp
// BUGGY: Dangling pointer
int* createArray() {
    int arr[10] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10};
    return arr;  // WARNING: returning pointer to local variable!
}

void useDanglingPointer() {
    int* data = createArray();  // data points to freed stack memory
    std::cout << data[0];      // Undefined behavior! Stack frame is gone.
}

// FIXED: Return by value (compiler applies RVO/NRVO -- no copy)
std::vector<int> createArray() {
    return {1, 2, 3, 4, 5, 6, 7, 8, 9, 10};  // Moved, not copied
}

// FIXED alternative: Use unique_ptr for heap allocation
std::unique_ptr<int[]> createArrayHeap() {
    auto arr = std::make_unique<int[]>(10);
    for (int i = 0; i < 10; ++i) arr[i] = i + 1;
    return arr;  // Moved out
}
```

### Bug 3: Use-After-Free

Accessing memory after it has been deallocated.

```cpp
// BUGGY: Use-after-free
class EventSystem {
    std::vector<Listener*> listeners_;
    
public:
    void addListener(Listener* l) { listeners_.push_back(l); }
    
    void notify() {
        for (auto* l : listeners_) {
            l->onEvent();  // Crash if listener was deleted elsewhere!
        }
    }
};

void useAfterFreeDemo() {
    EventSystem events;
    
    {
        auto listener = std::make_unique<Listener>();
        events.addListener(listener.get());  // Raw pointer stored
    }  // listener destroyed here!
    
    events.notify();  // USE-AFTER-FREE: listener is dead
}

// FIXED: Use shared_ptr/weak_ptr
class EventSystem {
    std::vector<std::weak_ptr<Listener>> listeners_;
    
public:
    void addListener(std::shared_ptr<Listener> l) {
        listeners_.push_back(l);
    }
    
    void notify() {
        for (auto it = listeners_.begin(); it != listeners_.end(); ) {
            if (auto l = it->lock()) {
                l->onEvent();
                ++it;
            } else {
                it = listeners_.erase(it);  // Auto-remove dead listeners
            }
        }
    }
};
```

### Bug 4: Double Free

Freeing the same memory twice causes heap corruption.

```cpp
// BUGGY: Double free
void doubleFreeDemo() {
    int* data = new int[100];
    
    processData(data);
    delete[] data;
    
    // ... later in the code, someone else also tries to clean up ...
    delete[] data;  // DOUBLE FREE: undefined behavior, heap corruption
}

// BUGGY: Double free through aliasing
void aliasDoubleFree() {
    int* a = new int(42);
    int* b = a;        // b is an alias for a
    
    delete a;          // Frees the memory
    delete b;          // DOUBLE FREE: same memory
}

// FIXED: Use unique_ptr (ownership is clear, no manual delete)
void fixedDoubleFree() {
    auto data = std::make_unique<int[]>(100);
    processData(data.get());
    // No delete needed. Cannot be double-freed.
}

// FIXED: Set pointer to nullptr after delete (defensive, but prefer smart pointers)
void defensiveDelete() {
    int* data = new int[100];
    delete[] data;
    data = nullptr;   // Now safe: delete[] nullptr is a no-op
    delete[] data;    // No-op, not a double free
}
```

### Bug 5: Mismatched Allocation/Deallocation

Passing a pointer allocated with `new[]` to scalar `delete` invokes undefined behavior: only the destructor of the first element runs, and the allocator receives wrong size metadata, silently corrupting the heap. Mixing `new`/`free` or `malloc`/`delete` is equally undefined. The safest solution is to use `std::unique_ptr` or `std::make_unique<T[]>`, which automatically select the correct deallocation path.
```cpp
// BUGGY: Using delete instead of delete[]
void mismatchedDelete() {
    int* arr = new int[100];
    delete arr;      // WRONG: should be delete[]
    // Only first element's destructor runs (if it's a class type).
    // Heap metadata is corrupted.
}

// BUGGY: Mixing malloc/free with new/delete
void mixedAllocation() {
    int* a = new int(42);
    free(a);          // WRONG: was allocated with new, must use delete
    
    int* b = (int*)malloc(sizeof(int));
    delete b;         // WRONG: was allocated with malloc, must use free
}

// FIXED: Be consistent. Better yet, use smart pointers exclusively.
void correctAllocation() {
    auto a = std::make_unique<int>(42);          // unique_ptr uses delete
    auto b = std::make_unique<int[]>(100);       // unique_ptr uses delete[]
    // No manual deallocation. No mismatch possible.
}
```

### Bug 6: Buffer Overflow

Using `<=` instead of `<` in the loop condition writes one element past the end of a 10-element array, overwriting adjacent stack memory, potentially the saved return address. `std::array::at()` and `std::vector::at()` add bounds-checked access. AddressSanitizer (`-fsanitize=address`) detects this at runtime during testing.
```cpp
// BUGGY: Writing past the end of an array
void bufferOverflow() {
    int arr[10];
    for (int i = 0; i <= 10; ++i) {  // Bug: <= instead of <
        arr[i] = i;                   // arr[10] writes past the end!
    }
    // This may corrupt the stack, overwrite return address, or crash
}

// FIXED: Use std::array or std::vector with bounds checking
void fixedOverflow() {
    std::array<int, 10> arr;
    for (size_t i = 0; i < arr.size(); ++i) {
        arr[i] = static_cast<int>(i);
    }
    
    // Even better: range-based for
    std::vector<int> vec(10);
    for (int i = 0; auto& val : vec) {
        val = i++;
    }
    
    // at() provides bounds checking (throws std::out_of_range)
    try {
        arr.at(10) = 99;  // Throws, does not corrupt memory
    } catch (const std::out_of_range& e) {
        std::cerr << "Caught: " << e.what() << "\n";
    }
}
```

### Bug 7: Uninitialized Memory Read

`new int[100]` allocates raw memory without zeroing it, the array contains whatever bytes the allocator left behind from a previous deallocation. Reading these bytes produces an unpredictable sum that may differ between runs, debug and release builds, or machines. Use `new int[100]()` (value-initialization) or `std::vector<int>(100, 0)` to guarantee zero-initialization.
```cpp
// BUGGY: Reading uninitialized memory
void uninitializedRead() {
    int* data = new int[100];  // Memory is NOT zeroed
    
    int sum = 0;
    for (int i = 0; i < 100; ++i) {
        sum += data[i];  // Reading garbage values!
    }
    std::cout << "Sum: " << sum << "\n";  // Unpredictable result
    delete[] data;
}

// FIXED: Initialize memory
void fixedUninitializedRead() {
    // Option 1: Value initialization (zeros for primitive types)
    int* data = new int[100]();
    
    // Option 2: Use a container (always initializes)
    std::vector<int> vec(100, 0);
    
    // Option 3: Use make_unique (value-initializes for arrays)
    auto arr = std::make_unique<int[]>(100);  // Zero-initialized
}
```

**Go comparison:** Go avoids most of these bugs by design:
- Memory leaks: GC collects unreachable objects (but goroutine leaks are still possible)
- Dangling pointers: Impossible, GC keeps objects alive while referenced
- Use-after-free: Impossible, GC prevents freeing reachable objects
- Double free: Impossible, no manual free
- Buffer overflow: Runtime bounds checking on slices (with `panic`)
- Uninitialized reads: All variables are zero-initialized by default

The cost? GC pauses, higher memory usage (typically 2-3x), and less deterministic performance.

---
