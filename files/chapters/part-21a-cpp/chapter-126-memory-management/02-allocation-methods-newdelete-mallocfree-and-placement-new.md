## Allocation Methods: new/delete, malloc/free, and Placement new

C++ offers multiple ways to allocate memory, each with different semantics and use cases.

### malloc and free (C-style)

These are raw memory allocators inherited from C. They allocate and deallocate raw bytes with no knowledge of types or constructors.

```cpp
#include <cstdlib>
#include <cstring>
#include <iostream>

void cStyleAllocation() {
    // Allocate 100 integers worth of raw bytes
    int* arr = (int*)malloc(100 * sizeof(int));
    
    if (arr == nullptr) {
        // malloc returns NULL on failure (does NOT throw)
        std::cerr << "Allocation failed!\n";
        return;
    }
    
    // Memory is UNINITIALIZED -- contains garbage
    // You must initialize it yourself
    memset(arr, 0, 100 * sizeof(int));
    
    for (int i = 0; i < 100; ++i) {
        arr[i] = i * i;
    }
    
    // calloc: allocate AND zero-initialize
    int* zeroed = (int*)calloc(100, sizeof(int));
    
    // realloc: resize an existing allocation
    arr = (int*)realloc(arr, 200 * sizeof(int));
    // WARNING: realloc may move the memory. Old pointer is invalid if it moves.
    
    free(zeroed);
    free(arr);
    // After free, arr and zeroed are dangling pointers.
    // Using them is undefined behavior.
}
```

**Critical rules for malloc/free:**
- `malloc` does NOT call constructors
- `free` does NOT call destructors
- Never mix `malloc`/`free` with `new`/`delete`
- Always check the return value (it returns `NULL` on failure)
- `free(NULL)` is safe (it's a no-op)

### new and delete (C++ style)

These are the C++ allocation operators. They allocate memory AND call constructors/destructors.

```cpp
#include <string>
#include <iostream>

class Connection {
    std::string host_;
    int port_;
public:
    Connection(const std::string& host, int port)
        : host_(host), port_(port) {
        std::cout << "Connected to " << host_ << ":" << port_ << "\n";
    }
    
    ~Connection() {
        std::cout << "Disconnected from " << host_ << ":" << port_ << "\n";
    }
    
    void send(const std::string& data) {
        std::cout << "Sending to " << host_ << ": " << data << "\n";
    }
};

void cppStyleAllocation() {
    // Single object: new calls constructor, delete calls destructor
    Connection* conn = new Connection("api.example.com", 443);
    conn->send("Hello");
    delete conn;   // Calls ~Connection(), then frees memory
    
    // Array form: new[] and delete[]
    int* arr = new int[100];        // Default-initialized (zero for int)
    int* arr2 = new int[100]();     // Value-initialized (guaranteed zero)
    int* arr3 = new int[100]{1,2,3}; // List-initialized (1,2,3,0,0,...)
    
    delete[] arr;   // MUST use delete[] for arrays
    delete[] arr2;
    delete[] arr3;
    
    // DANGER: using delete instead of delete[] on an array is undefined behavior
    // DANGER: using delete[] on a single object is undefined behavior
}
```

**new vs malloc comparison:**

| Feature | `malloc`/`free` | `new`/`delete` |
|---------|-----------------|----------------|
| Calls constructor | No | Yes |
| Calls destructor | No | Yes |
| Returns type | `void*` (must cast) | Correct type |
| On failure | Returns `NULL` | Throws `std::bad_alloc` |
| Can be overloaded | No | Yes (per-class) |
| Size calculation | Manual (`sizeof`) | Automatic |

### nothrow new

By default, `new` throws `std::bad_alloc` on failure. You can opt for a `NULL`-returning version:

```cpp
#include <new>
#include <iostream>

void safeAllocation() {
    // Throws std::bad_alloc on failure
    int* p1 = new int[1000000000000ULL];  // Probably throws
    
    // Returns nullptr on failure (does NOT throw)
    int* p2 = new (std::nothrow) int[1000000000000ULL];
    if (p2 == nullptr) {
        std::cerr << "Allocation failed gracefully\n";
    }
}
```

### Placement new

Placement new constructs an object at a specific memory address. It does not allocate memory, it constructs in-place.

```cpp
#include <new>
#include <iostream>

class Sensor {
    int id_;
    double reading_;
public:
    Sensor(int id) : id_(id), reading_(0.0) {
        std::cout << "Sensor " << id_ << " initialized\n";
    }
    ~Sensor() {
        std::cout << "Sensor " << id_ << " destroyed\n";
    }
    void setReading(double r) { reading_ = r; }
    double getReading() const { return reading_; }
};

void placementNewExample() {
    // Step 1: Allocate raw memory (no constructor called)
    alignas(Sensor) unsigned char buffer[sizeof(Sensor)];
    
    // Step 2: Construct object in that memory using placement new
    Sensor* sensor = new (buffer) Sensor(42);
    
    sensor->setReading(98.6);
    std::cout << "Reading: " << sensor->getReading() << "\n";
    
    // Step 3: Explicitly call destructor (placement new requires manual destruction)
    sensor->~Sensor();
    
    // Do NOT call delete -- we didn't use regular new
    // The buffer is on the stack and will be freed automatically
}
```

**Real-world uses of placement new:**
- **Memory pools**: Pre-allocate large blocks, construct objects within them
- **Custom allocators**: Game engines, embedded systems, real-time systems
- **Shared memory**: Construct objects in memory-mapped regions
- **`std::vector` internals**: Reserves raw memory, uses placement new to construct elements

```cpp
// Memory pool example -- how game engines avoid heap allocation in hot loops
class ObjectPool {
    static constexpr size_t POOL_SIZE = 1024;
    alignas(Sensor) unsigned char pool_[POOL_SIZE * sizeof(Sensor)];
    bool occupied_[POOL_SIZE] = {};
    
public:
    Sensor* allocate(int id) {
        for (size_t i = 0; i < POOL_SIZE; ++i) {
            if (!occupied_[i]) {
                occupied_[i] = true;
                // Placement new: construct Sensor in pre-allocated slot
                return new (&pool_[i * sizeof(Sensor)]) Sensor(id);
            }
        }
        return nullptr;  // Pool exhausted
    }
    
    void deallocate(Sensor* s) {
        auto offset = reinterpret_cast<unsigned char*>(s) - pool_;
        size_t index = offset / sizeof(Sensor);
        if (index < POOL_SIZE && occupied_[index]) {
            s->~Sensor();           // Manually call destructor
            occupied_[index] = false;
        }
    }
};
```

**Go comparison:** Go has no equivalent to placement new. The closest concept is `sync.Pool`, which reuses objects to reduce GC pressure, but it does not give you control over memory addresses. In performance-critical Go code, you might pre-allocate slices (`make([]T, 0, capacity)`), which serves a similar purpose, reducing allocator calls.

### Overloading operator new and operator delete

C++ allows you to override the global allocation functions or define per-class versions. This is powerful for profiling, debugging, and building custom allocation strategies.

```cpp
#include <iostream>
#include <cstdlib>
#include <new>

// Global overload: tracks all allocations
static size_t totalAllocated = 0;
static size_t totalFreed = 0;
static int allocationCount = 0;

void* operator new(size_t size) {
    totalAllocated += size;
    ++allocationCount;
    void* ptr = std::malloc(size);
    if (!ptr) throw std::bad_alloc();
    std::cout << "[alloc] " << size << " bytes at " << ptr
              << " (total: " << totalAllocated << ")\n";
    return ptr;
}

void operator delete(void* ptr) noexcept {
    std::cout << "[free] " << ptr << "\n";
    std::free(ptr);
}

void operator delete(void* ptr, size_t size) noexcept {
    totalFreed += size;
    std::cout << "[free] " << size << " bytes at " << ptr << "\n";
    std::free(ptr);
}

// Per-class overload: useful for pool allocation
class Particle {
    float x_, y_, z_;
    float vx_, vy_, vz_;
    
    static constexpr size_t POOL_SIZE = 10000;
    static char pool_[POOL_SIZE * sizeof(Particle)];
    static bool used_[POOL_SIZE];
    
public:
    Particle(float x, float y, float z) : x_(x), y_(y), z_(z), vx_(0), vy_(0), vz_(0) {}
    
    static void* operator new(size_t size) {
        for (size_t i = 0; i < POOL_SIZE; ++i) {
            if (!used_[i]) {
                used_[i] = true;
                return pool_ + i * sizeof(Particle);
            }
        }
        throw std::bad_alloc();
    }
    
    static void operator delete(void* ptr) noexcept {
        size_t index = (static_cast<char*>(ptr) - pool_) / sizeof(Particle);
        if (index < POOL_SIZE) {
            used_[index] = false;
        }
    }
};

char Particle::pool_[POOL_SIZE * sizeof(Particle)];
bool Particle::used_[POOL_SIZE] = {};
```

This pattern is used in game engines where particle systems allocate and destroy millions of small objects per frame. A pool allocator avoids the overhead of `malloc`/`free` entirely.

---
