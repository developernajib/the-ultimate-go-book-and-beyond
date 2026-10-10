## Container Adaptors

Container adaptors provide restricted interfaces on top of an underlying container. They are not containers themselves. They wrap another container and expose only specific operations. They have no iterators, which means you cannot iterate over their elements directly.

### std::stack: LIFO

`std::stack` wraps a `std::deque` by default and exposes only `push`, `pop`, `top`, `empty`, and `size`, forbidding random access and iteration to enforce LIFO discipline. Specifying `std::vector<int>` as the second template argument gives contiguous storage and better cache locality when frequent random access to the underlying data is not needed.
```cpp
#include <stack>
#include <vector>
#include <iostream>

int main() {
    // Default underlying container: deque
    std::stack<int> s1;
    
    // Can specify underlying container
    std::stack<int, std::vector<int>> s2;
    
    s1.push(10);
    s1.push(20);
    s1.push(30);
    
    std::cout << "top: " << s1.top() << "\n";  // 30
    s1.pop();
    std::cout << "top: " << s1.top() << "\n";  // 20
    std::cout << "size: " << s1.size() << "\n"; // 2
    
    // emplace constructs in-place (C++11)
    s1.emplace(40);
    
    // Process all elements
    while (!s1.empty()) {
        std::cout << s1.top() << " ";
        s1.pop();
    }
    std::cout << "\n";  // 40 20 10
    
    return 0;
}
```

**Why deque is the default, not vector**: Both work, but deque never invalidates references to other elements during push/pop (it allocates new chunks rather than reallocating). For most uses the difference is negligible. If you want guaranteed contiguous memory, use `std::stack<T, std::vector<T>>`.

### std::queue: FIFO

`std::queue` wraps a `std::deque` and exposes `push` (back), `pop` (front), `front`, `back`, `empty`, and `size`. The deque default provides O(1) push and pop at both ends without reallocation, making it efficient for producer-consumer patterns where elements arrive at the back and are consumed from the front.
```cpp
#include <queue>
#include <iostream>

int main() {
    // Default underlying container: deque
    std::queue<int> q;
    
    q.push(10);
    q.push(20);
    q.push(30);
    
    std::cout << "front: " << q.front() << "\n";  // 10
    std::cout << "back: " << q.back() << "\n";    // 30
    q.pop();  // Removes front element
    std::cout << "front: " << q.front() << "\n";  // 20
    
    // BFS pattern
    std::queue<int> bfs;
    bfs.push(1);
    while (!bfs.empty()) {
        int node = bfs.front();
        bfs.pop();
        std::cout << "Visiting: " << node << "\n";
        // bfs.push(neighbor) for each neighbor
        if (node < 3) {
            bfs.push(node * 2);
            bfs.push(node * 2 + 1);
        }
    }
    
    return 0;
}
```

### std::priority_queue: Max-Heap

Internally uses `std::make_heap`, `std::push_heap`, and `std::pop_heap` on the underlying container (default: `vector`). The largest element is always at the top. The heap is maintained as a complete binary tree stored in an array: for element at index `i`, the left child is at `2i+1`, right child at `2i+2`, and parent at `(i-1)/2`.

```cpp
#include <queue>
#include <vector>
#include <functional>
#include <iostream>

int main() {
    // Max-heap (default)
    std::priority_queue<int> max_pq;
    max_pq.push(3);
    max_pq.push(1);
    max_pq.push(4);
    max_pq.push(1);
    max_pq.push(5);
    
    std::cout << "Max-heap order: ";
    while (!max_pq.empty()) {
        std::cout << max_pq.top() << " ";
        max_pq.pop();
    }
    std::cout << "\n";  // 5 4 3 1 1
    
    // Min-heap: use std::greater
    std::priority_queue<int, std::vector<int>, std::greater<int>> min_pq;
    min_pq.push(3);
    min_pq.push(1);
    min_pq.push(4);
    
    std::cout << "Min-heap order: ";
    while (!min_pq.empty()) {
        std::cout << min_pq.top() << " ";
        min_pq.pop();
    }
    std::cout << "\n";  // 1 3 4
    
    // Custom comparator for complex types
    struct Task {
        std::string name;
        int priority;
    };
    
    auto cmp = [](const Task& a, const Task& b) {
        return a.priority < b.priority;  // Higher priority first
    };
    
    std::priority_queue<Task, std::vector<Task>, decltype(cmp)> task_queue(cmp);
    task_queue.push({"Low", 1});
    task_queue.push({"Critical", 10});
    task_queue.push({"Medium", 5});
    
    while (!task_queue.empty()) {
        std::cout << task_queue.top().name << "(" 
                  << task_queue.top().priority << ") ";
        task_queue.pop();
    }
    std::cout << "\n";  // Critical(10) Medium(5) Low(1)
    
    return 0;
}
```

**The comparator is inverted**: This confuses many people. The comparator for `priority_queue` answers "should `a` be below `b` in the heap?" So `std::less<int>` (the default, `a < b`) means larger elements have higher priority (max-heap). `std::greater<int>` (`a > b`) means smaller elements have higher priority (min-heap). Think of it as: the comparator defines what "loses" the comparison and sinks to the bottom.

**Efficiency**: `push` is O(log n), it appends to the vector then sifts up. `pop` is O(log n), it swaps root with last element, removes last, then sifts down. `top` is O(1). Building a priority_queue from n elements using the constructor is O(n), not O(n log n), because it uses `make_heap` which is a bottom-up heapify.

---
