## Performance Characteristics Table

This table summarizes the time complexity for key operations across all major containers. **Memorize this for interviews.**

| Container | Access | Search | Insert (front) | Insert (back) | Insert (mid) | Erase (front) | Erase (back) | Erase (mid) | Sorted |
|-----------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `vector` | O(1) | O(n) | O(n) | O(1)* | O(n) | O(n) | O(1) | O(n) | No |
| `deque` | O(1) | O(n) | O(1) | O(1) | O(n) | O(1) | O(1) | O(n) | No |
| `list` | O(n) | O(n) | O(1) | O(1) | O(1)** | O(1) | O(1) | O(1)** | No |
| `forward_list` | O(n) | O(n) | O(1) | O(n) | O(1)** | O(1) | O(n) | O(1)** | No |
| `array` | O(1) | O(n) | N/A | N/A | N/A | N/A | N/A | N/A | No |
| `map`/`set` | O(log n) | O(log n) |, |, | O(log n) |, |, | O(log n) | Yes |
| `unordered_map`/`set` | O(1)*** | O(1)*** |, |, | O(1)*** |, |, | O(1)*** | No |
| `priority_queue` | O(1) top |, |, | O(log n) |, | O(log n) pop |, |, | Heap |

\* Amortized O(1), worst case O(n) due to reallocation.
\** O(1) only when you already have an iterator to the position. Finding the position is O(n).
\*** Average case. Worst case is O(n) if all elements hash to the same bucket.

**Space overhead per element:**

| Container | Overhead |
|-----------|:---|
| `vector` | ~0 bytes (contiguous, may have unused capacity at the end) |
| `deque` | Small (chunk pointers in map array, ~8 bytes amortized) |
| `list` | 2 pointers per node (16 bytes on 64-bit) + allocator overhead |
| `forward_list` | 1 pointer per node (8 bytes on 64-bit) + allocator overhead |
| `map`/`set` | 3 pointers + color bit per node (~25 bytes on 64-bit) + allocator overhead |
| `unordered_map`/`set` | ~1 pointer per element + bucket array + linked list overhead |

**Practical decision flowchart:**

1. Need random access by index? Use `vector` (or `deque` if also inserting at front).
2. Need sorted order or range queries? Use `map`/`set`.
3. Need O(1) key lookup, don't need order? Use `unordered_map`/`unordered_set`.
4. Need O(1) insert/erase at arbitrary positions (with iterator)? Use `list`.
5. Need fixed size known at compile time? Use `array`.
6. Need FIFO? Use `queue`. Need LIFO? Use `stack`. Need priority? Use `priority_queue`.
7. When in doubt, use `vector`. Profile before switching.

---
