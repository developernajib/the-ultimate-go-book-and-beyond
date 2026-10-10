## LeetCode Top Problems in C++

These 20 problems cover the algorithmic foundations that appear in every FAANG interview. Each solution is idiomatic C++, using the STL correctly, choosing the right containers, and applying C++-specific optimizations where they matter. Complexity analysis is given for each.

---

### 1. Two Sum

**Problem**: Given an array of integers and a target, return the indices of the two numbers that add up to the target. O(n) solution required.

**Approach**: Single pass with `unordered_map`. For each element, check if its complement is already in the map.

```cpp
std::vector<int> twoSum(std::vector<int>& nums, int target) {
    std::unordered_map<int, int> seen;  // value → index
    for (int i = 0; i < static_cast<int>(nums.size()); ++i) {
        int complement = target - nums[i];
        auto it = seen.find(complement);
        if (it != seen.end()) return {it->second, i};
        seen[nums[i]] = i;
    }
    return {};
}
```

**Complexity**: O(n) time, O(n) space.

---

### 2. Longest Substring Without Repeating Characters

**Problem**: Find the length of the longest substring without repeating characters.

**Approach**: Sliding window with `unordered_map` tracking the last-seen index of each character.

```cpp
int lengthOfLongestSubstring(const std::string& s) {
    std::unordered_map<char, int> last_seen;
    int max_len = 0, left = 0;
    for (int right = 0; right < static_cast<int>(s.size()); ++right) {
        auto it = last_seen.find(s[right]);
        if (it != last_seen.end() && it->second >= left)
            left = it->second + 1;  // shrink window past the duplicate
        last_seen[s[right]] = right;
        max_len = std::max(max_len, right - left + 1);
    }
    return max_len;
}
```

**Complexity**: O(n) time, O(k) space where k is the character set size (≤ 128 for ASCII).

---

### 3. Median of Two Sorted Arrays

**Problem**: Find the median of two sorted arrays. Must be O(log(m+n)).

**Approach**: Binary search on the smaller array. Partition both arrays such that all left-half elements ≤ all right-half elements.

```cpp
double findMedianSortedArrays(std::vector<int>& A, std::vector<int>& B) {
    if (A.size() > B.size()) std::swap(A, B);
    int m = A.size(), n = B.size();
    int lo = 0, hi = m;
    while (lo <= hi) {
        int i = (lo + hi) / 2;
        int j = (m + n + 1) / 2 - i;
        int maxLeftA  = (i == 0) ? INT_MIN : A[i-1];
        int minRightA = (i == m) ? INT_MAX : A[i];
        int maxLeftB  = (j == 0) ? INT_MIN : B[j-1];
        int minRightB = (j == n) ? INT_MAX : B[j];
        if (maxLeftA <= minRightB && maxLeftB <= minRightA) {
            if ((m + n) % 2 == 1) return std::max(maxLeftA, maxLeftB);
            return (std::max(maxLeftA, maxLeftB) + std::min(minRightA, minRightB)) / 2.0;
        } else if (maxLeftA > minRightB) {
            hi = i - 1;
        } else {
            lo = i + 1;
        }
    }
    return 0.0;
}
```

**Complexity**: O(log(min(m, n))) time, O(1) space.

---

### 4. Merge K Sorted Lists

**Problem**: Merge K sorted linked lists into one sorted list.

**Approach**: Min-heap (`priority_queue`) holding the current head of each list. Always extract the smallest.

```cpp
struct ListNode { int val; ListNode* next; };

ListNode* mergeKLists(std::vector<ListNode*>& lists) {
    auto cmp = [](ListNode* a, ListNode* b) { return a->val > b->val; };
    std::priority_queue<ListNode*, std::vector<ListNode*>, decltype(cmp)> pq{cmp};

    for (ListNode* head : lists)
        if (head) pq.push(head);

    ListNode dummy{0, nullptr};
    ListNode* tail = &dummy;
    while (!pq.empty()) {
        tail->next = pq.top(); pq.pop();
        tail = tail->next;
        if (tail->next) pq.push(tail->next);
    }
    return dummy.next;
}
```

**Complexity**: O(N log K) time where N = total nodes, K = number of lists. O(K) space for the heap.

---

### 5. Valid Parentheses

**Problem**: Determine if a string of brackets is valid (properly nested and closed).

```cpp
bool isValid(const std::string& s) {
    std::stack<char> st;
    for (char c : s) {
        if (c == '(' || c == '[' || c == '{') {
            st.push(c);
        } else {
            if (st.empty()) return false;
            char top = st.top(); st.pop();
            if ((c == ')' && top != '(') ||
                (c == ']' && top != '[') ||
                (c == '}' && top != '{')) return false;
        }
    }
    return st.empty();
}
```

**Complexity**: O(n) time, O(n) space.

---

### 6. Binary Tree Level Order Traversal

**Problem**: Return the level-order traversal of a binary tree (each level as a separate vector).

```cpp
struct TreeNode { int val; TreeNode* left; TreeNode* right; };

std::vector<std::vector<int>> levelOrder(TreeNode* root) {
    std::vector<std::vector<int>> result;
    if (!root) return result;
    std::queue<TreeNode*> q;
    q.push(root);
    while (!q.empty()) {
        int level_size = q.size();
        result.emplace_back();
        for (int i = 0; i < level_size; ++i) {
            TreeNode* node = q.front(); q.pop();
            result.back().push_back(node->val);
            if (node->left)  q.push(node->left);
            if (node->right) q.push(node->right);
        }
    }
    return result;
}
```

**Complexity**: O(n) time and space.

---

### 7. Number of Islands

**Problem**: Given a 2D grid of '1's (land) and '0's (water), count the number of islands.

**Approach**: DFS flood-fill. Mark visited cells as '0' in-place.

```cpp
void dfs(std::vector<std::vector<char>>& grid, int r, int c) {
    int rows = grid.size(), cols = grid[0].size();
    if (r < 0 || r >= rows || c < 0 || c >= cols || grid[r][c] != '1') return;
    grid[r][c] = '0';  // mark visited
    dfs(grid, r+1, c); dfs(grid, r-1, c);
    dfs(grid, r, c+1); dfs(grid, r, c-1);
}

int numIslands(std::vector<std::vector<char>>& grid) {
    int count = 0;
    for (int r = 0; r < static_cast<int>(grid.size()); ++r)
        for (int c = 0; c < static_cast<int>(grid[0].size()); ++c)
            if (grid[r][c] == '1') { ++count; dfs(grid, r, c); }
    return count;
}
```

**Complexity**: O(m×n) time and space (recursion stack in worst case).

---

### 8. LRU Cache

(See OOD Problems section for the full thread-safe LRU implementation.)

```cpp
// Core O(1) implementation using list + unordered_map:
// get: find in map → splice to front → return value
// put: find in map → update + splice, or evict back → insert front
// Already implemented in full in section 05-ood-problems-cpp.md
```

**Complexity**: O(1) amortized for both `get` and `put`.

---

### 9. Word Ladder

**Problem**: Find the shortest transformation sequence from `beginWord` to `endWord`, changing one letter at a time, using words from a dictionary.

**Approach**: BFS. For each word, try all one-letter substitutions and check if they are in the word set.

```cpp
int ladderLength(std::string begin, std::string end,
                 std::vector<std::string>& wordList) {
    std::unordered_set<std::string> word_set{wordList.begin(), wordList.end()};
    if (!word_set.count(end)) return 0;
    std::queue<std::string> q;
    q.push(begin);
    int steps = 1;
    while (!q.empty()) {
        int sz = q.size();
        for (int i = 0; i < sz; ++i) {
            std::string word = q.front(); q.pop();
            for (size_t j = 0; j < word.size(); ++j) {
                char orig = word[j];
                for (char c = 'a'; c <= 'z'; ++c) {
                    word[j] = c;
                    if (word == end) return steps + 1;
                    if (word_set.count(word)) {
                        q.push(word);
                        word_set.erase(word);  // mark visited
                    }
                }
                word[j] = orig;
            }
        }
        ++steps;
    }
    return 0;
}
```

**Complexity**: O(M² × N) where M = word length, N = dictionary size.

---

### 10. Trapping Rain Water

**Problem**: Given heights, compute total water that can be trapped.

**Approach**: Two pointers. Track `left_max` and `right_max`. The shorter side limits water at each position.

```cpp
int trap(const std::vector<int>& height) {
    int left = 0, right = static_cast<int>(height.size()) - 1;
    int left_max = 0, right_max = 0, water = 0;
    while (left < right) {
        if (height[left] < height[right]) {
            height[left] >= left_max ? (left_max = height[left]) : (water += left_max - height[left]);
            ++left;
        } else {
            height[right] >= right_max ? (right_max = height[right]) : (water += right_max - height[right]);
            --right;
        }
    }
    return water;
}
```

**Complexity**: O(n) time, O(1) space.

---

### 11. Merge Intervals

**Problem**: Merge overlapping intervals.

```cpp
std::vector<std::vector<int>> merge(std::vector<std::vector<int>>& intervals) {
    std::sort(intervals.begin(), intervals.end());
    std::vector<std::vector<int>> result;
    for (auto& iv : intervals) {
        if (result.empty() || result.back()[1] < iv[0])
            result.push_back(iv);
        else
            result.back()[1] = std::max(result.back()[1], iv[1]);
    }
    return result;
}
```

**Complexity**: O(n log n) for sort, O(n) for merge pass.

---

### 12. Top K Frequent Elements

**Problem**: Return the k most frequent elements. Better than O(n log n).

**Approach**: `std::nth_element` on a frequency-counted array gives O(n) average.

```cpp
std::vector<int> topKFrequent(std::vector<int>& nums, int k) {
    std::unordered_map<int, int> freq;
    for (int x : nums) ++freq[x];

    std::vector<std::pair<int,int>> pairs(freq.begin(), freq.end());
    // nth_element: O(n) average, places kth-largest at index k-1
    std::nth_element(pairs.begin(), pairs.begin() + k, pairs.end(),
        [](const auto& a, const auto& b) { return a.second > b.second; });

    std::vector<int> result;
    result.reserve(k);
    for (int i = 0; i < k; ++i) result.push_back(pairs[i].first);
    return result;
}
```

**Complexity**: O(n) average (nth_element), O(n) space. Min-heap approach is O(n log k) but deterministic.

---

### 13. Find Median from Data Stream

**Problem**: Design a class supporting `addNum` and `findMedian` on a stream. O(log n) add, O(1) median.

**Approach**: Two heaps, max-heap for the lower half, min-heap for the upper half. Balance to within 1 element.

```cpp
class MedianFinder {
    std::priority_queue<int>                            lower_;  // max-heap (lower half)
    std::priority_queue<int, std::vector<int>, std::greater<int>> upper_;  // min-heap

public:
    void addNum(int num) {
        lower_.push(num);
        upper_.push(lower_.top()); lower_.pop();  // ensure lower ≤ upper
        if (upper_.size() > lower_.size() + 1) {
            lower_.push(upper_.top()); upper_.pop();
        }
    }

    double findMedian() const {
        if (upper_.size() > lower_.size()) return upper_.top();
        return (lower_.top() + upper_.top()) / 2.0;
    }
};
```

**Complexity**: O(log n) add, O(1) median.

---

### 14. Course Schedule (Cycle Detection)

**Problem**: Can you finish all courses given prerequisites? (Topological sort, detect if DAG.)

**Approach**: Kahn's algorithm (BFS with in-degree tracking).

```cpp
bool canFinish(int numCourses, std::vector<std::vector<int>>& prerequisites) {
    std::vector<std::vector<int>> adj(numCourses);
    std::vector<int> in_degree(numCourses, 0);
    for (auto& p : prerequisites) {
        adj[p[1]].push_back(p[0]);
        ++in_degree[p[0]];
    }
    std::queue<int> q;
    for (int i = 0; i < numCourses; ++i)
        if (in_degree[i] == 0) q.push(i);
    int completed = 0;
    while (!q.empty()) {
        int course = q.front(); q.pop();
        ++completed;
        for (int next : adj[course])
            if (--in_degree[next] == 0) q.push(next);
    }
    return completed == numCourses;
}
```

**Complexity**: O(V + E) time and space.

---

### 15. Longest Common Subsequence

**Problem**: Given two strings, find the length of their longest common subsequence.

```cpp
int longestCommonSubsequence(const std::string& text1, const std::string& text2) {
    int m = text1.size(), n = text2.size();
    std::vector<std::vector<int>> dp(m+1, std::vector<int>(n+1, 0));
    for (int i = 1; i <= m; ++i)
        for (int j = 1; j <= n; ++j)
            dp[i][j] = (text1[i-1] == text2[j-1])
                       ? dp[i-1][j-1] + 1
                       : std::max(dp[i-1][j], dp[i][j-1]);
    return dp[m][n];
}
```

**Complexity**: O(m×n) time and space. Space can be reduced to O(min(m, n)) with rolling arrays.

---

### 16. Serialize and Deserialize Binary Tree

**Problem**: Design an algorithm to serialize a binary tree to a string and deserialize it back.

**Approach**: BFS serialization. Null nodes encoded as "#".

```cpp
std::string serialize(TreeNode* root) {
    if (!root) return "";
    std::ostringstream out;
    std::queue<TreeNode*> q;
    q.push(root);
    while (!q.empty()) {
        TreeNode* node = q.front(); q.pop();
        if (node) {
            out << node->val << ',';
            q.push(node->left);
            q.push(node->right);
        } else {
            out << "#,";
        }
    }
    return out.str();
}

TreeNode* deserialize(const std::string& data) {
    if (data.empty()) return nullptr;
    std::istringstream in{data};
    std::string token;
    std::getline(in, token, ',');
    TreeNode* root = new TreeNode{std::stoi(token)};
    std::queue<TreeNode*> q;
    q.push(root);
    while (!q.empty()) {
        TreeNode* node = q.front(); q.pop();
        for (TreeNode*& child : {std::ref(node->left), std::ref(node->right)}) {
            if (!std::getline(in, token, ',')) break;
            if (token != "#") {
                child = new TreeNode{std::stoi(token)};
                q.push(child);
            }
        }
    }
    return root;
}
```

**Complexity**: O(n) time and space.

---

### 17. Sliding Window Maximum

**Problem**: Find the maximum in each sliding window of size k.

**Approach**: Monotonic deque, maintain indices in decreasing order of their values. The front is always the current window's maximum.

```cpp
std::vector<int> maxSlidingWindow(const std::vector<int>& nums, int k) {
    std::deque<int> dq;  // stores indices, front = max index
    std::vector<int> result;
    for (int i = 0; i < static_cast<int>(nums.size()); ++i) {
        // Remove indices outside window
        while (!dq.empty() && dq.front() < i - k + 1) dq.pop_front();
        // Remove smaller elements from back (they can never be the max)
        while (!dq.empty() && nums[dq.back()] < nums[i]) dq.pop_back();
        dq.push_back(i);
        if (i >= k - 1) result.push_back(nums[dq.front()]);
    }
    return result;
}
```

**Complexity**: O(n) time (each element pushed and popped at most once), O(k) space.

---

### 18. Alien Dictionary

**Problem**: Given a sorted list of words in an alien language, determine the character order.

**Approach**: Build a graph from adjacent word comparisons, then topological sort.

```cpp
std::string alienOrder(const std::vector<std::string>& words) {
    std::unordered_map<char, std::unordered_set<char>> adj;
    std::unordered_map<char, int> in_degree;
    for (auto& w : words) for (char c : w) if (!in_degree.count(c)) in_degree[c] = 0;

    for (int i = 0; i + 1 < static_cast<int>(words.size()); ++i) {
        const std::string& w1 = words[i], &w2 = words[i+1];
        size_t len = std::min(w1.size(), w2.size());
        bool found = false;
        for (size_t j = 0; j < len; ++j) {
            if (w1[j] != w2[j]) {
                if (!adj[w1[j]].count(w2[j])) {
                    adj[w1[j]].insert(w2[j]);
                    ++in_degree[w2[j]];
                }
                found = true;
                break;
            }
        }
        if (!found && w1.size() > w2.size()) return "";  // invalid ordering
    }

    std::queue<char> q;
    for (auto& [c, deg] : in_degree) if (deg == 0) q.push(c);
    std::string result;
    while (!q.empty()) {
        char c = q.front(); q.pop();
        result += c;
        for (char next : adj[c])
            if (--in_degree[next] == 0) q.push(next);
    }
    return result.size() == in_degree.size() ? result : "";
}
```

**Complexity**: O(C) where C = total characters across all words.

---

### 19. Design Search Autocomplete System

**Problem**: Design a system that returns the top 3 hottest sentences (by frequency, then lexicographic order) matching a prefix. Support character-by-character input with `#` ending a sentence.

**Approach**: Trie with frequency tracking. Each node stores top-3 sentences for that prefix.

```cpp
struct TrieNode {
    std::array<TrieNode*, 27> children{};  // 26 letters + '#' for space
    std::vector<std::pair<int,std::string>> top3;  // (freq, sentence)
    ~TrieNode() { for (auto* c : children) delete c; }
};

class AutocompleteSystem {
    TrieNode                           root_;
    std::unordered_map<std::string,int> freq_;
    std::string                         current_;

    int idx(char c) { return c == ' ' ? 26 : c - 'a'; }

    void insert(const std::string& s, int f) {
        TrieNode* node = &root_;
        for (char c : s) {
            int i = idx(c);
            if (!node->children[i]) node->children[i] = new TrieNode();
            node = node->children[i];
            // Update top3 in this node
            auto& t3 = node->top3;
            auto it = std::find_if(t3.begin(), t3.end(), [&](auto& p){ return p.second==s; });
            if (it != t3.end()) it->first = f;
            else t3.emplace_back(f, s);
            std::sort(t3.begin(), t3.end(), [](auto& a, auto& b){
                return a.first != b.first ? a.first > b.first : a.second < b.second;
            });
            if (t3.size() > 3) t3.resize(3);
        }
    }

public:
    AutocompleteSystem(std::vector<std::string>& sentences, std::vector<int>& times) {
        for (size_t i = 0; i < sentences.size(); ++i) {
            freq_[sentences[i]] = times[i];
            insert(sentences[i], times[i]);
        }
    }

    std::vector<std::string> input(char c) {
        if (c == '#') {
            ++freq_[current_];
            insert(current_, freq_[current_]);
            current_.clear();
            return {};
        }
        current_ += c;
        TrieNode* node = &root_;
        for (char ch : current_) {
            int i = idx(ch);
            if (!node->children[i]) return {};
            node = node->children[i];
        }
        std::vector<std::string> result;
        for (auto& [f, s] : node->top3) result.push_back(s);
        return result;
    }
};
```

---

### 20. K Closest Points to Origin

**Problem**: Find K closest points to the origin. O(n) average solution.

**Approach**: `std::nth_element`, partial sort in O(n) average time, not O(n log k).

```cpp
std::vector<std::vector<int>> kClosest(std::vector<std::vector<int>>& points, int k) {
    // dist² comparator, no sqrt needed since we only compare
    auto dist2 = [](const std::vector<int>& p) {
        return p[0]*p[0] + p[1]*p[1];
    };
    std::nth_element(points.begin(), points.begin() + k, points.end(),
        [&](const auto& a, const auto& b) { return dist2(a) < dist2(b); });
    return {points.begin(), points.begin() + k};
}
```

**Complexity**: O(n) average time (nth_element uses introselect), O(1) extra space. The max-heap solution is O(n log k), use nth_element when you do not need the result sorted.

**C++ interview note**: Interviewers at Google and Meta specifically look for use of `std::nth_element` here. Reaching for `sort` shows you do not know the STL. Reaching for a heap shows you know algorithms but not C++-specific tools.

---
