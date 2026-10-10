## String and string_view

### std::string Internals and SSO

`std::string` is not just a `vector<char>`. Most implementations use **Small String Optimization (SSO)**: short strings are stored inline within the string object itself, avoiding heap allocation entirely.

A typical `std::string` object occupies 32 bytes (on 64-bit systems) and contains:

- A pointer to the character data
- A size field
- A capacity field (or an inline buffer that overlaps these fields for small strings)

With SSO, strings shorter than about 15-22 characters (implementation-dependent) are stored directly inside the object. Only longer strings allocate on the heap.

```
Small string (SSO active):
+-----------------------------------------+
| "Hello\0" + padding                     |  (32 bytes, all inline)
| size=5, SSO flag set                    |
+-----------------------------------------+

Long string (heap-allocated):
+-----------------------------------------+
| ptr -------> [heap buffer: "long..."]   |  (32 bytes for metadata)
| size=1000                               |
| capacity=1024                           |
+-----------------------------------------+
```

**SSO thresholds by implementation:**
- GCC libstdc++: 15 characters (string object is 32 bytes)
- Clang libc++: 22 characters (string object is 24 bytes, uses all available space cleverly)
- MSVC: 15 characters (string object is 32 bytes)

```cpp
#include <string>
#include <iostream>

int main() {
    std::string small = "Hello";         // SSO: no heap allocation
    std::string large(100, 'x');         // Heap allocated
    
    // Demonstrate SSO threshold (implementation-specific)
    for (int len = 1; len <= 30; ++len) {
        std::string s(len, 'a');
        // If address of first char is within the string object,
        // SSO is active
        const char* data = s.data();
        const char* obj_start = reinterpret_cast<const char*>(&s);
        const char* obj_end = obj_start + sizeof(s);
        
        bool is_sso = (data >= obj_start && data < obj_end);
        if (len <= 22 || !is_sso) {  // Print boundary
            std::cout << "len=" << len << " SSO=" << is_sso << "\n";
        }
    }
    
    // String operations to know
    std::string s = "Hello, World!";
    
    // substr creates a copy (expensive for large strings)
    std::string sub = s.substr(7, 5);  // "World"
    
    // find family
    size_t pos = s.find("World");      // 7
    size_t rpos = s.rfind('l');        // 10 (last 'l')
    size_t fof = s.find_first_of("aeiou");  // 1 ('e')
    
    // Compare (C++20)
    if (s.starts_with("Hello")) {}
    if (s.ends_with("!")) {}
    
    // Efficient append - reserve when building long strings
    std::string result;
    result.reserve(100);
    for (int i = 0; i < 10; ++i) {
        result += std::to_string(i);
        result += ',';
    }
    std::cout << result << "\n";
    
    return 0;
}
```

**Performance implications of SSO**: Creating and copying short strings is extremely fast because no heap allocation occurs. This is why small keys in `std::map<std::string, ...>` are much faster than you might expect. It also means moving a short string is no faster than copying it (both are memcpy of 32 bytes), unlike heap-allocated strings where move is O(1) pointer swap and copy is O(n) character copy.

### std::string_view: Non-Owning String Reference

`string_view` (C++17) is a lightweight, non-owning view into a string. It consists of just a pointer and a length (16 bytes). It never allocates memory, never copies characters, and can reference any contiguous character sequence (`std::string`, C string literal, substring of either).

```cpp
#include <string>
#include <string_view>
#include <iostream>

// Accepts any string-like input without copying
void process(std::string_view sv) {
    std::cout << "Length: " << sv.size() << "\n";
    std::cout << "Content: " << sv << "\n";
    
    // Cheap substring operations (no allocation)
    std::string_view first_word = sv.substr(0, sv.find(' '));
    std::cout << "First word: " << first_word << "\n";
    
    // Remove prefix/suffix (modifies the view, not the data)
    sv.remove_prefix(std::min(sv.find(' '), sv.size()));
    std::cout << "After removing first word: " << sv << "\n";
}

int main() {
    // All of these work without conversion or copying
    process("Hello World!");                         // C string literal
    process(std::string("Hello World!"));           // std::string
    process(std::string_view("Hello World!", 12));  // Explicit view
    
    // DANGER: string_view does not own the data!
    std::string_view dangling;
    {
        std::string temp = "temporary";
        dangling = temp;  // OK here...
    }
    // dangling now points to freed memory - UNDEFINED BEHAVIOR
    // std::cout << dangling; // DO NOT DO THIS
    
    return 0;
}
```

**When to use each:**

| Scenario | Use |
|----------|:---|
| Function parameter, read-only | `std::string_view` |
| Store/own the data | `std::string` |
| Need null-termination (C APIs) | `std::string` (`.c_str()`) |
| Substring operations (no mutation) | `std::string_view` |
| Return from function (data lives beyond scope) | `std::string` |
| Constexpr string processing | `std::string_view` |
| Key in a map/set | `std::string` (must own the data) |

**The dangling reference trap**: The most common `string_view` bug is storing a view to a temporary:

```cpp
std::string_view bad() {
    std::string local = "hello";
    return local;  // DANGLING: local is destroyed when function returns
}

std::string_view also_bad(std::string s) {  // s is a copy
    return s;  // DANGLING: s is destroyed when function returns
}

// SAFE: string literal has static lifetime
std::string_view ok() {
    return "hello";  // OK: string literals live for the entire program
}
```

---
