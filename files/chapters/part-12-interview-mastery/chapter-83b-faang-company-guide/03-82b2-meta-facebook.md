## 83B.2 Meta (Facebook)

```
┌───────────────────────────────────────────────────────────────────┐
│                    META INTERVIEW PIPELINE                        │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  Application/Referral                                             │
│       │                                                           │
│       ▼                                                           │
│  Recruiter Screen (30 min)                                        │
│       │  - Role fit, experience, timeline                         │
│       ▼                                                           │
│  Technical Phone Screen (45 min)                                  │
│       │  - 2 coding problems via CoderPad                         │
│       ▼                                                           │
│  Virtual Onsite (4-5 rounds, 45 min each)                         │
│       │  - 2 Coding rounds (2 problems each)                      │
│       │  - 1 System Design round                                  │
│       │  - 1 Behavioral round ("Why Meta?", past projects)        │
│       │  - 1 Additional coding or design (level dependent)        │
│       ▼                                                           │
│  Debrief & Decision                                               │
│       │  - Interviewers meet to discuss, immediate feedback       │
│       ▼                                                           │
│  Offer                                                            │
│  Timeline: 2-4 weeks (Meta moves fast)                            │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### Interview Process (2026)

Meta's interview process is notably **faster** than Google's. There is no separate hiring committee - your interviewers debrief together and make the decision. This means rapport with your interviewer matters more than at Google. Meta also places heavy emphasis on **speed**: you are expected to solve two coding problems in a single 45-minute round, which means roughly 20 minutes per problem including discussion. This is the fastest pace of any FAANG company and requires significant practice with timed sessions.

The phone screen uses CoderPad, which provides syntax highlighting and a run button - a significant advantage over Google Docs. You will receive two problems and are expected to fully solve both. Partial solutions rarely advance candidates.

The onsite coding rounds also feature two problems per round. The first problem is typically a warm-up (easy to medium), and the second is the real test (medium to hard). Meta interviewers evaluate your ability to write correct code quickly without excessive hints.

### What Meta Tests

**Coding: Speed is paramount.**
- Two problems per 45-minute round - no time for lengthy deliberation
- Emphasis on working code (CoderPad can run it)
- Common patterns: arrays, strings, trees, graphs, dynamic programming
- Less emphasis on exotic data structures, more on clean efficient solutions

**System Design: Social features at scale.**
- Design News Feed, Messenger, Instagram Stories, Live Video
- Emphasis on real-time systems, fan-out strategies, caching layers
- Data model design is heavily weighted
- Expect questions about consistency vs. availability trade-offs

**Behavioral: "Move Fast" culture fit.**
- "Tell me about a time you had to move fast and break things"
- "How did you handle a project with changing requirements?"
- "Describe a technical disagreement and how you resolved it"
- Meta values speed, impact, and boldness over perfection

### Go at Meta

Meta's Go adoption has grown significantly since 2023. Key areas include:
- **Infrastructure services** - internal tooling and platform services
- **High-throughput backend systems** - data processing pipelines
- **API gateways** - high-performance request routing
- **Cache infrastructure** - custom caching layers

While Meta is historically a PHP (Hack) and C++ shop, Go is increasingly used for new backend services where high concurrency and operational simplicity are priorities.

### Level Expectations

**E3 (Software Engineer) - 0-2 years:**
- Solve 4 medium problems across 2 coding rounds (both rounds)
- Basic system design awareness (may not get a full SD round)
- Demonstrate ability to learn quickly and ship code

**E4 (Software Engineer) - 2-5 years:**
- Solve 4 medium-hard problems fluently
- Design a system like URL shortener or chat service
- Show ownership of a feature or component end-to-end

**E5 (Senior Software Engineer) - 5-10 years:**
- Solve hard problems with optimal solutions and clean code
- Design complex systems: News Feed ranking, real-time messaging
- Demonstrate cross-team impact and technical leadership

**E6 (Staff Software Engineer) - 10+ years:**
- System design mastery at Meta's scale (billions of users)
- Architecture ownership across multiple teams
- Strategic technical vision and execution

### Top 20 Meta Interview Questions with Solutions

#### Question 1: Valid Palindrome II (Classic Meta)

*Can you make the string a palindrome by removing at most one character?*

```go
func validPalindrome(s string) bool {
	left, right := 0, len(s)-1
	for left < right {
		if s[left] != s[right] {
			return isPalin(s, left+1, right) || isPalin(s, left, right-1)
		}
		left++
		right--
	}
	return true
}

func isPalin(s string, l, r int) bool {
	for l < r {
		if s[l] != s[r] {
			return false
		}
		l++
		r--
	}
	return true
}
```

#### Question 2: Binary Tree Vertical Order Traversal

Binary Tree Vertical Order Traversal is a classic Meta coding interview question testing breadth-first search and coordinate tracking across columns. The following Go solution uses a FIFO queue to traverse nodes level by level while recording column offsets.

```go
type TreeNode struct {
	Val   int
	Left  *TreeNode
	Right *TreeNode
}

func verticalOrder(root *TreeNode) [][]int {
	if root == nil {
		return nil
	}

	type item struct {
		node *TreeNode
		col  int
	}

	colMap := make(map[int][]int)
	minCol, maxCol := 0, 0
	queue := []item{{root, 0}}

	for len(queue) > 0 {
		curr := queue[0]
		queue = queue[1:]

		colMap[curr.col] = append(colMap[curr.col], curr.node.Val)
		if curr.col < minCol {
			minCol = curr.col
		}
		if curr.col > maxCol {
			maxCol = curr.col
		}

		if curr.node.Left != nil {
			queue = append(queue, item{curr.node.Left, curr.col - 1})
		}
		if curr.node.Right != nil {
			queue = append(queue, item{curr.node.Right, curr.col + 1})
		}
	}

	result := make([][]int, 0, maxCol-minCol+1)
	for c := minCol; c <= maxCol; c++ {
		result = append(result, colMap[c])
	}
	return result
}
```

#### Question 3: Subarray Sum Equals K

Subarray Sum Equals K is a representative problem from this company's interview pool, testing the data structure and algorithm knowledge that the engineering team considers prerequisite for the role. The following Go solution demonstrates the optimal approach, with inline comments explaining the key insight that reduces time or space complexity relative to the brute-force alternative.

```go
func subarraySum(nums []int, k int) int {
	prefixCount := map[int]int{0: 1}
	sum, count := 0, 0

	for _, n := range nums {
		sum += n
		if v, ok := prefixCount[sum-k]; ok {
			count += v
		}
		prefixCount[sum]++
	}
	return count
}
```

#### Question 4: Random Pick with Weight

Random Pick with Weight is a representative problem from this company's interview pool, testing the data structure and algorithm knowledge that the engineering team considers prerequisite for the role. The following Go solution demonstrates the optimal approach, with inline comments explaining the key insight that reduces time or space complexity relative to the brute-force alternative.

```go
import "math/rand/v2"

type WeightedPicker struct {
	prefix []int
	total  int
}

func NewWeightedPicker(w []int) *WeightedPicker {
	prefix := make([]int, len(w))
	prefix[0] = w[0]
	for i := 1; i < len(w); i++ {
		prefix[i] = prefix[i-1] + w[i]
	}
	return &WeightedPicker{prefix: prefix, total: prefix[len(prefix)-1]}
}

func (wp *WeightedPicker) PickIndex() int {
	target := rand.IntN(wp.total) + 1
	lo, hi := 0, len(wp.prefix)-1
	for lo < hi {
		mid := lo + (hi-lo)/2
		if wp.prefix[mid] < target {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	return lo
}
```

#### Question 5: Buildings with Ocean View

*Meta asks this frequently - find buildings that can see the ocean (rightmost side).*

```go
func findBuildings(heights []int) []int {
	result := make([]int, 0)
	maxSoFar := 0

	for i := len(heights) - 1; i >= 0; i-- {
		if heights[i] > maxSoFar {
			result = append(result, i)
			maxSoFar = heights[i]
		}
	}

	// Reverse
	for i, j := 0, len(result)-1; i < j; i, j = i+1, j-1 {
		result[i], result[j] = result[j], result[i]
	}
	return result
}
```

#### Question 6: Lowest Common Ancestor of Binary Tree III (Parent Pointers)

Lowest Common Ancestor of Binary Tree III (Parent Pointers) is a representative problem from this company's interview pool, testing the data structure and algorithm knowledge that the engineering team considers prerequisite for the role. The following Go solution demonstrates the optimal approach, with inline comments explaining the key insight that reduces time or space complexity relative to the brute-force alternative.

```go
type Node struct {
	Val    int
	Left   *Node
	Right  *Node
	Parent *Node
}

func lowestCommonAncestor(p, q *Node) *Node {
	a, b := p, q
	for a != b {
		if a.Parent != nil {
			a = a.Parent
		} else {
			a = q
		}
		if b.Parent != nil {
			b = b.Parent
		} else {
			b = p
		}
	}
	return a
}
```

#### Question 7: Dot Product of Sparse Vectors

Vector embeddings represent semantic meaning as high-dimensional floating-point arrays, enabling similarity search and document clustering without keyword matching. The sparse vector implementation stores only non-zero `(index, value)` pairs so that dot-product computation skips zero dimensions, a critical optimization when embedding dimensionality reaches thousands but most activations are zero, as is typical with bag-of-words or one-hot encodings.

```go
type SparseVector struct {
	pairs []pair // only non-zero indices
}

type pair struct {
	index int
	value int
}

func NewSparseVector(nums []int) *SparseVector {
	var pairs []pair
	for i, v := range nums {
		if v != 0 {
			pairs = append(pairs, pair{i, v})
		}
	}
	return &SparseVector{pairs: pairs}
}

func (sv *SparseVector) DotProduct(other *SparseVector) int {
	i, j := 0, 0
	result := 0

	for i < len(sv.pairs) && j < len(other.pairs) {
		if sv.pairs[i].index == other.pairs[j].index {
			result += sv.pairs[i].value * other.pairs[j].value
			i++
			j++
		} else if sv.pairs[i].index < other.pairs[j].index {
			i++
		} else {
			j++
		}
	}
	return result
}
```

#### Question 8: Nested List Weight Sum

Nested List Weight Sum is a representative problem from this company's interview pool, testing the data structure and algorithm knowledge that the engineering team considers prerequisite for the role. The following Go solution demonstrates the optimal approach, with inline comments explaining the key insight that reduces time or space complexity relative to the brute-force alternative.

```go
type NestedInteger struct {
	isInt bool
	val   int
	list  []*NestedInteger
}

func depthSum(nestedList []*NestedInteger) int {
	return dfs(nestedList, 1)
}

func dfs(list []*NestedInteger, depth int) int {
	sum := 0
	for _, ni := range list {
		if ni.isInt {
			sum += ni.val * depth
		} else {
			sum += dfs(ni.list, depth+1)
		}
	}
	return sum
}
```

#### Question 9: Minimum Remove to Make Valid Parentheses

Minimum Remove to Make Valid Parentheses is a representative problem from this company's interview pool, testing the data structure and algorithm knowledge that the engineering team considers prerequisite for the role. The following Go solution demonstrates the optimal approach, with inline comments explaining the key insight that reduces time or space complexity relative to the brute-force alternative.

```go
func minRemoveToMakeValid(s string) string {
	bytes := []byte(s)
	stack := make([]int, 0)

	for i, ch := range bytes {
		if ch == '(' {
			stack = append(stack, i)
		} else if ch == ')' {
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			} else {
				bytes[i] = '*' // mark for removal
			}
		}
	}

	for _, idx := range stack {
		bytes[idx] = '*'
	}

	result := make([]byte, 0, len(bytes))
	for _, ch := range bytes {
		if ch != '*' {
			result = append(result, ch)
		}
	}
	return string(result)
}
```

#### Question 10: K Closest Points to Origin

K Closest Points to Origin is a representative problem from this company's interview pool, testing the data structure and algorithm knowledge that the engineering team considers prerequisite for the role. The following Go solution demonstrates the optimal approach, with inline comments explaining the key insight that reduces time or space complexity relative to the brute-force alternative.

```go
import "container/heap"

type Point struct {
	x, y int
	dist int
}

type MaxHeap []Point

func (h MaxHeap) Len() int            { return len(h) }
func (h MaxHeap) Less(i, j int) bool  { return h[i].dist > h[j].dist }
func (h MaxHeap) Swap(i, j int)       { h[i], h[j] = h[j], h[i] }
func (h *MaxHeap) Push(x any) { *h = append(*h, x.(Point)) }
func (h *MaxHeap) Pop() any {
	old := *h
	n := len(old)
	x := old[n-1]
	*h = old[:n-1]
	return x
}

func kClosest(points [][]int, k int) [][]int {
	h := &MaxHeap{}

	for _, p := range points {
		dist := p[0]*p[0] + p[1]*p[1]
		if h.Len() < k {
			heap.Push(h, Point{p[0], p[1], dist})
		} else if dist < (*h)[0].dist {
			heap.Pop(h)
			heap.Push(h, Point{p[0], p[1], dist})
		}
	}

	result := make([][]int, k)
	for i := 0; i < k; i++ {
		p := heap.Pop(h).(Point)
		result[i] = []int{p.x, p.y}
	}
	return result
}
```

#### Questions 11-20: Brief Solutions

**Q11: Add Strings**

```go
func addStrings(num1, num2 string) string {
	i, j := len(num1)-1, len(num2)-1
	carry := 0
	result := make([]byte, 0)

	for i >= 0 || j >= 0 || carry > 0 {
		sum := carry
		if i >= 0 {
			sum += int(num1[i] - '0')
			i--
		}
		if j >= 0 {
			sum += int(num2[j] - '0')
			j--
		}
		result = append(result, byte(sum%10)+'0')
		carry = sum / 10
	}

	// Reverse
	for l, r := 0, len(result)-1; l < r; l, r = l+1, r-1 {
		result[l], result[r] = result[r], result[l]
	}
	return string(result)
}
```

**Q12: Range Sum of BST**

```go
func rangeSumBST(root *TreeNode, low, high int) int {
	if root == nil {
		return 0
	}
	if root.Val < low {
		return rangeSumBST(root.Right, low, high)
	}
	if root.Val > high {
		return rangeSumBST(root.Left, low, high)
	}
	return root.Val + rangeSumBST(root.Left, low, high) + rangeSumBST(root.Right, low, high)
}
```

**Q13: Exclusive Time of Functions**

```go
func exclusiveTime(n int, logs []string) []int {
	result := make([]int, n)
	stack := make([]int, 0) // function IDs
	prevTime := 0

	for _, log := range logs {
		parts := strings.Split(log, ":")
		id, _ := strconv.Atoi(parts[0])
		timestamp, _ := strconv.Atoi(parts[2])

		if parts[1] == "start" {
			if len(stack) > 0 {
				result[stack[len(stack)-1]] += timestamp - prevTime
			}
			stack = append(stack, id)
			prevTime = timestamp
		} else {
			result[stack[len(stack)-1]] += timestamp - prevTime + 1
			stack = stack[:len(stack)-1]
			prevTime = timestamp + 1
		}
	}
	return result
}
```

**Q14: Diagonal Traverse**

```go
func findDiagonalOrder(mat [][]int) []int {
	if len(mat) == 0 {
		return nil
	}
	m, n := len(mat), len(mat[0])
	result := make([]int, 0, m*n)
	r, c := 0, 0
	goingUp := true

	for len(result) < m*n {
		result = append(result, mat[r][c])
		if goingUp {
			if c == n-1 {
				r++
				goingUp = false
			} else if r == 0 {
				c++
				goingUp = false
			} else {
				r--
				c++
			}
		} else {
			if r == m-1 {
				c++
				goingUp = true
			} else if c == 0 {
				r++
				goingUp = true
			} else {
				r++
				c--
			}
		}
	}
	return result
}
```

**Q15: Binary Tree Right Side View**

```go
func rightSideView(root *TreeNode) []int {
	if root == nil {
		return nil
	}
	var result []int
	queue := []*TreeNode{root}

	for len(queue) > 0 {
		size := len(queue)
		for i := 0; i < size; i++ {
			node := queue[i]
			if i == size-1 {
				result = append(result, node.Val)
			}
			if node.Left != nil {
				queue = append(queue, node.Left)
			}
			if node.Right != nil {
				queue = append(queue, node.Right)
			}
		}
		queue = queue[size:]
	}
	return result
}
```

**Q16: Move Zeroes**

```go
func moveZeroes(nums []int) {
	insertPos := 0
	for _, n := range nums {
		if n != 0 {
			nums[insertPos] = n
			insertPos++
		}
	}
	for i := insertPos; i < len(nums); i++ {
		nums[i] = 0
	}
}
```

**Q17: Interval List Intersections**

```go
func intervalIntersection(a, b [][]int) [][]int {
	var result [][]int
	i, j := 0, 0

	for i < len(a) && j < len(b) {
		lo := max(a[i][0], b[j][0])
		hi := min(a[i][1], b[j][1])
		if lo <= hi {
			result = append(result, []int{lo, hi})
		}
		if a[i][1] < b[j][1] {
			i++
		} else {
			j++
		}
	}
	return result
}

// Note: Uses builtin min()/max() available since Go 1.21
```

**Q18: Copy List with Random Pointer**

```go
type RandomNode struct {
	Val    int
	Next   *RandomNode
	Random *RandomNode
}

func copyRandomList(head *RandomNode) *RandomNode {
	if head == nil {
		return nil
	}

	// Interleave copies
	curr := head
	for curr != nil {
		copy := &RandomNode{Val: curr.Val, Next: curr.Next}
		curr.Next = copy
		curr = copy.Next
	}

	// Set random pointers
	curr = head
	for curr != nil {
		if curr.Random != nil {
			curr.Next.Random = curr.Random.Next
		}
		curr = curr.Next.Next
	}

	// Separate lists
	dummy := &RandomNode{}
	copyCurr := dummy
	curr = head
	for curr != nil {
		copyCurr.Next = curr.Next
		copyCurr = copyCurr.Next
		curr.Next = curr.Next.Next
		curr = curr.Next
	}
	return dummy.Next
}
```

**Q19: Simplify Path**

```go
func simplifyPath(path string) string {
	parts := strings.Split(path, "/")
	stack := make([]string, 0)

	for _, p := range parts {
		switch p {
		case "", ".":
			continue
		case "..":
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
		default:
			stack = append(stack, p)
		}
	}
	return "/" + strings.Join(stack, "/")
}
```

**Q20: Product of Array Except Self**

```go
func productExceptSelf(nums []int) []int {
	n := len(nums)
	result := make([]int, n)

	result[0] = 1
	for i := 1; i < n; i++ {
		result[i] = result[i-1] * nums[i-1]
	}

	right := 1
	for i := n - 1; i >= 0; i-- {
		result[i] *= right
		right *= nums[i]
	}
	return result
}
```

### Preparation Timeline (6-8 weeks)

| Week | Focus | Daily Hours | Key Activities |
|------|-------|-------------|----------------|
| 1-2 | Speed Coding | 3-4h | Solve 2 problems in 40 min. Focus on Meta's top 50 list |
| 3-4 | System Design | 3h | Practice social-scale systems. Review Chapter 80 |
| 5-6 | Mock Interviews | 3-4h | Timed 2-problem rounds. Practice behavioral stories |
| 7-8 | Final Polish | 2-3h | Review weak areas. Final mock interviews |


### Junior → FAANG: Preparing for Meta Interviews

Meta (Facebook) interviews are structured around a product-focused engineering mindset: the problems you are given often have a product angle, and the evaluation includes whether you can connect technical decisions to product impact. Coding interviews at Meta tend to use medium-difficulty graph and dynamic programming problems. Behavioral interviews at Meta focus on impact, speed of execution, and collaboration. Know Meta's core values (Move Fast, Be Bold, Focus on Long-Term Impact, Build Awesome Things, Live in the Future) and have stories that demonstrate each.

### Senior @ FAANG: Meta E6/E7 Interview: Scope, Speed, and Technical Depth

At Meta's E6 and E7 levels, the interview loop includes a system design round with a very high throughput and scale expectation, and a behavioral round that explicitly assesses organizational impact. Meta moves faster than most FAANG companies and values candidates who can make decisions under ambiguity without waiting for complete information. The bar-raiser equivalent at Meta is the hiring committee, which includes senior engineers from outside the hiring team. For E6 system design, expect the interviewer to push you to consider 100M+ DAU scenarios and to probe on the details of how you handle hotspots, fan-out at celebrity scale, and geographic distribution. Meta's culture of directness means the interviewer will tell you if your answer is not at the right level, which can feel abrupt but is useful signal to adjust your depth.

---
