## 83B.6 Microsoft

```
┌───────────────────────────────────────────────────────────────────┐
│                  MICROSOFT INTERVIEW PIPELINE                     │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  Application/Referral                                             │
│       │                                                           │
│       ▼                                                           │
│  Recruiter Screen (30 min)                                        │
│       │  - Role alignment, experience overview, logistics         │
│       ▼                                                           │
│  Technical Phone Screen (45-60 min)                               │
│       │  - 1-2 coding problems with thorough discussion           │
│       ▼                                                           │
│  Virtual Onsite (4-5 rounds, 45 min each)                         │
│       │  - 2-3 Coding rounds (one problem each, deeply explored)  │
│       │  - 1 System Design round                                  │
│       │  - 1 "As Appropriate" (AA) round with senior leader       │
│       ▼                                                           │
│  Debrief                                                          │
│       │  - AA interviewer has the deciding vote                   │
│       ▼                                                           │
│  Offer                                                            │
│  Timeline: 2-4 weeks (Microsoft moves fast)                       │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### Company Overview for Go Engineers

Microsoft under Satya Nadella is a fundamentally different company from the Microsoft of the Ballmer era. The "growth mindset" transformation has made Microsoft one of the most developer-friendly companies in tech, and its embrace of open source - including significant Go projects - has positioned it as a top destination for Go engineers. Microsoft's cloud platform Azure generates over $100 billion in annual revenue, and much of the tooling, infrastructure, and developer experience layer is built with Go.

**How Microsoft Uses Go Internally:**

Go has a significant and growing presence at Microsoft, driven by three major forces: Azure's infrastructure needs, the GitHub acquisition, and Microsoft's leadership in the Kubernetes ecosystem. Microsoft's Go engineering teams are among the largest outside Google, and the company actively contributes to the Go ecosystem through open-source projects.

**Key Products and Teams That Use Go:**

- **Azure Kubernetes Service (AKS)** - Microsoft's managed Kubernetes offering. The control plane tooling, cluster management services, and the developer experience layer are heavily Go-based. AKS is one of Microsoft's fastest-growing cloud services.
- **Dapr (Distributed Application Runtime)** - A major Microsoft open-source project written entirely in Go. Dapr provides building blocks for distributed applications (service invocation, state management, pub/sub, bindings). It is deployed in production at Microsoft and hundreds of other companies.
- **KEDA (Kubernetes Event-Driven Autoscaling)** - Another Microsoft-maintained Go project. KEDA enables fine-grained autoscaling of Kubernetes workloads based on event sources (Azure Service Bus, Kafka, RabbitMQ, etc.).
- **GitHub infrastructure** - Since Microsoft's $7.5 billion acquisition of GitHub, GitHub's extensive Go codebase counts as part of Microsoft's Go footprint. GitHub uses Go for many backend services, including parts of GitHub Actions, Codespaces backend, and internal infrastructure tooling.
- **Azure backend services** - Many Azure services' backend components are written in Go, particularly newer microservices in the compute, networking, and storage teams. Go's compilation speed and low memory footprint make it attractive for Azure's scale requirements.
- **VS Code language servers and tooling** - The Go extension for VS Code (gopls) is maintained by the Go team at Google, but Microsoft's tooling team contributes to the broader language server ecosystem, and Go-based tooling services power parts of the developer experience.
- **Azure DevOps pipeline agents** - Build agents and pipeline orchestration components for Azure DevOps use Go for cross-platform compilation and deployment simplicity.
- **CBL-Mariner / Azure Linux** - Microsoft's internal Linux distribution used across Azure, and associated container and OS tooling written in Go.

**Engineering Culture and Values:**

Microsoft's engineering culture has undergone a dramatic transformation since 2014, and understanding this transformation is critical for your interview.

1. **Growth mindset.** This is the defining cultural value of modern Microsoft. Satya Nadella's mantra - "learn-it-all, not know-it-all" - permeates every aspect of the interview. Microsoft interviewers explicitly evaluate whether you demonstrate curiosity, humility, willingness to learn, and ability to change your mind when presented with new information. This is not lip service - it is the single most important behavioral signal.

2. **Customer obsession.** Microsoft serves developers, enterprises, and consumers. Every technical decision should connect to customer impact. In your interview, framing solutions in terms of customer benefit ("This design reduces deployment time for our customers from 30 minutes to 3 minutes") is significantly more impactful than purely technical framing.

3. **Diversity and inclusion.** Microsoft actively values diverse perspectives and inclusive team dynamics. Behavioral questions will probe how you work with people different from you, how you create environments where everyone can contribute, and how you handle situations where someone is excluded or marginalized.

4. **One Microsoft.** The "stack ranking" era of internal competition is over. Microsoft now values cross-team collaboration, sharing, and collective success. Your interview answers should reflect collaborative instincts, not solo heroics.

5. **Responsible AI and ethical technology.** Microsoft has invested heavily in responsible AI practices, and this mindset extends to all engineering. Expect interviewers to appreciate candidates who proactively consider ethical implications, privacy concerns, and accessibility in their technical decisions.

**Interview Process Unique Aspects:**

Microsoft's process has three distinctive features. First, the **"As Appropriate" (AA) round** - a final interview with a senior leader (Partner, Director, or VP level) who has read all previous interview feedback and makes the ultimate hire/no-hire decision. This person specifically probes any areas of concern raised by previous interviewers. If the AA says no, you do not get an offer regardless of other feedback. Second, **Microsoft values correctness over speed** - unlike Meta's two-problems-in-45-minutes sprint, Microsoft gives you one problem per round and expects thorough exploration with tests, edge cases, and extensions. Third, **Microsoft's process is fast** - typically 2-4 weeks from first screen to offer, making it one of the quickest FAANG pipelines.

### Interview Process Deep Dive

**Application to Offer: The Complete Pipeline**

**Stage 1: Application or Referral (Week 0)**

Microsoft has a large engineering organization (200,000+ employees, approximately 100,000 in engineering roles) with many open positions. Referrals are helpful but not as critical as at smaller companies like Netflix or Apple - Microsoft actively recruits from the market. Apply through careers.microsoft.com. Microsoft's job postings are detailed and specific, making it easy to target the right team.

**Stage 2: Recruiter Screen (30 minutes, Week 1)**

Microsoft recruiters assess role fit, experience level, and logistics. They will ask about your preferred team and location (Microsoft has major engineering hubs in Redmond, Silicon Valley, New York, Atlanta, and internationally). The recruiter screen is straightforward and primarily logistical.

**Stage 3: Technical Phone Screen (45-60 minutes, Week 1-2)**

One or two coding problems, typically medium difficulty. Microsoft uses a shared coding environment (often Visual Studio Code Live Share or a similar tool). Expect to write, run, and test your code. The interviewer values:
- Clarifying the problem before coding (asking about constraints, edge cases)
- Writing clean, structured code with good naming
- Testing your solution with multiple inputs
- Discussing time and space complexity
- Handling follow-up extensions gracefully

**Stage 4: Virtual Onsite Interview (4-5 rounds, 45 minutes each, Week 2-3)**

The onsite consists of:
- **2-3 Coding rounds:** One problem per round, deeply explored. Microsoft's problems tend to be practical - implement a feature, design a data structure, solve a real-world optimization problem. Interviewers give you time to think, write clean code, test thoroughly, and discuss trade-offs. They often extend the problem: "Now what if the input could be streaming?" or "How would you modify this for concurrent access?"
- **1 System Design round (Level 62+):** Design scalable systems using cloud-native patterns. Azure awareness helps - knowing about Cosmos DB, Service Bus, Azure Functions, Event Hubs, and AKS demonstrates alignment. Microsoft interviewers focus on reliability, fault tolerance, global distribution, and multi-region architecture.
- **1 "As Appropriate" (AA) round:** The AA interviewer is a senior leader who has read all previous feedback. They focus on areas of concern, behavioral assessment, and a final technical discussion. The AA round often includes a mix of behavioral questions (growth mindset), high-level technical discussion, and career/motivation assessment. This round is decisive.

**Who interviews you:** A mix of engineers from the hiring team and adjacent teams. Coding interviewers are typically the same level or one level above the target role. The system design interviewer is usually a senior or principal engineer. The AA interviewer is a Partner (Level 67+), Director, or VP.

**Stage 5: Debrief (Week 2-3)**

All interviewers submit written feedback through Microsoft's internal hiring tool. The AA interviewer makes the final decision, informed by all feedback. The AA has effective veto power - if they say no, the candidate is rejected regardless of other feedback.

**Stage 6: Offer (Week 2-4)**

Microsoft's offers include base salary, annual bonus (15-25% of base at senior levels), and RSUs vesting over 4 years (with equal annual vesting). Microsoft's total compensation is competitive with other FAANG companies, though typically slightly below Google and Meta at the same level. Microsoft also provides strong benefits including a generous 401(k) match, ESPP, and relocation packages.

**Timeline: 2-4 weeks from first screen to offer.** Microsoft is one of the fastest FAANG pipelines. They can move even faster for competitive candidates.

### Level Expectations

**SDE (Level 59-60) - New Grad / 0-2 years:**
- Solve medium problems correctly with solid code quality and edge case handling
- Basic system design understanding (design a URL shortener, design a cache)
- Demonstrate curiosity, eagerness to learn, and growth mindset
- Show ability to ask good questions and communicate thought process
- Approximate total compensation (2025-2026): $160,000-$220,000

**SDE II (Level 61-62) - 2-5 years:**
- Solve medium-hard problems with thorough testing and discussion of alternatives
- Design moderate-scale systems with cloud patterns (multi-region, eventual consistency)
- Show independence, ownership of features, and ability to mentor junior engineers
- Demonstrate growth through specific examples of learning from mistakes
- Approximate total compensation (2025-2026): $230,000-$370,000

**Senior SDE (Level 63-64) - 5-10 years:**
- Solve hard problems and discuss multiple approaches with quantitative trade-off analysis
- Design complex distributed systems at global scale with fault tolerance and observability
- Technical leadership: drove architecture decisions, influenced team practices, mentored
- Cross-team collaboration with measurable impact
- Approximate total compensation (2025-2026): $370,000-$550,000

**Principal SDE (Level 65-67) - 10+ years:**
- System design mastery with deep understanding of distributed systems, performance, and reliability
- Organization-level technical strategy and direction
- Defined standards, patterns, or frameworks adopted across multiple teams
- The AA round may be conducted by a CVP (Corporate Vice President) or Technical Fellow
- Approximate total compensation (2025-2026): $550,000-$1,000,000+

**Distinguished Engineer / Technical Fellow (Level 68+) - Rare:**
- Company-wide technical influence and industry-level impact
- Typically involves direct reports or large informal influence networks
- Approximate total compensation (2025-2026): $1,000,000-$2,000,000+

### Top 20 Microsoft Go Interview Questions with Solutions

#### Question 1: Implement a Text Editor with Undo/Redo (Medium - Microsoft-Specific)

*Microsoft loves editor and productivity tool problems. This tests the Command pattern and clean OOP design in Go.*

**Key Insight:** The Command pattern encapsulates operations as objects, enabling undo by reversing the operation. The redo stack is cleared on any new action to maintain a linear history.

```go
package main

import "fmt"

type Command interface {
	Execute()
	Undo()
}

type InsertCommand struct {
	editor   *TextEditor
	position int
	text     string
}

func (c *InsertCommand) Execute() {
	c.editor.content = c.editor.content[:c.position] + c.text + c.editor.content[c.position:]
	c.editor.cursor = c.position + len(c.text)
}

func (c *InsertCommand) Undo() {
	c.editor.content = c.editor.content[:c.position] + c.editor.content[c.position+len(c.text):]
	c.editor.cursor = c.position
}

type DeleteCommand struct {
	editor   *TextEditor
	position int
	length   int
	deleted  string
}

func (c *DeleteCommand) Execute() {
	c.deleted = c.editor.content[c.position : c.position+c.length]
	c.editor.content = c.editor.content[:c.position] + c.editor.content[c.position+c.length:]
	c.editor.cursor = c.position
}

func (c *DeleteCommand) Undo() {
	c.editor.content = c.editor.content[:c.position] + c.deleted + c.editor.content[c.position:]
	c.editor.cursor = c.position + len(c.deleted)
}

type TextEditor struct {
	content   string
	cursor    int
	undoStack []Command
	redoStack []Command
}

func NewTextEditor() *TextEditor {
	return &TextEditor{}
}

func (e *TextEditor) Insert(position int, text string) {
	cmd := &InsertCommand{editor: e, position: position, text: text}
	cmd.Execute()
	e.undoStack = append(e.undoStack, cmd)
	e.redoStack = nil
}

func (e *TextEditor) Delete(position, length int) {
	cmd := &DeleteCommand{editor: e, position: position, length: length}
	cmd.Execute()
	e.undoStack = append(e.undoStack, cmd)
	e.redoStack = nil
}

func (e *TextEditor) Undo() bool {
	if len(e.undoStack) == 0 {
		return false
	}
	cmd := e.undoStack[len(e.undoStack)-1]
	e.undoStack = e.undoStack[:len(e.undoStack)-1]
	cmd.Undo()
	e.redoStack = append(e.redoStack, cmd)
	return true
}

func (e *TextEditor) Redo() bool {
	if len(e.redoStack) == 0 {
		return false
	}
	cmd := e.redoStack[len(e.redoStack)-1]
	e.redoStack = e.redoStack[:len(e.redoStack)-1]
	cmd.Execute()
	e.undoStack = append(e.undoStack, cmd)
	return true
}

func (e *TextEditor) String() string { return e.content }

func main() {
	editor := NewTextEditor()
	editor.Insert(0, "Hello World")
	fmt.Println(editor) // "Hello World"

	editor.Insert(5, ",")
	fmt.Println(editor) // "Hello, World"

	editor.Delete(5, 1)
	fmt.Println(editor) // "Hello World"

	editor.Undo()
	fmt.Println(editor) // "Hello, World"

	editor.Redo()
	fmt.Println(editor) // "Hello World"
}
```

**Time Complexity:** O(n) per operation due to string manipulation. **Space Complexity:** O(n * ops) for the undo/redo stacks.

**Microsoft follow-up:** "How would you support collaborative editing? How would you handle concurrent undo operations from different users?"

#### Question 2: Key-Value Store with Nested Transactions (Medium-Hard)

*Microsoft values database and storage primitives. This tests your understanding of transaction isolation and rollback mechanics.*

**Key Insight:** Use a stack of transaction layers. Each transaction records its changes, and on commit, changes propagate to the parent layer (or base store). On rollback, discard the layer.

```go
package main

import "fmt"

type KVStore struct {
	data         map[string]string
	transactions []map[string]*string // nil value = deleted
}

func NewKVStore() *KVStore {
	return &KVStore{data: make(map[string]string)}
}

func (kv *KVStore) Set(key, value string) {
	if len(kv.transactions) > 0 {
		tx := kv.transactions[len(kv.transactions)-1]
		val := value
		tx[key] = &val
	} else {
		kv.data[key] = value
	}
}

func (kv *KVStore) Get(key string) (string, bool) {
	for i := len(kv.transactions) - 1; i >= 0; i-- {
		if val, ok := kv.transactions[i][key]; ok {
			if val == nil {
				return "", false
			}
			return *val, true
		}
	}
	val, ok := kv.data[key]
	return val, ok
}

func (kv *KVStore) Delete(key string) {
	if len(kv.transactions) > 0 {
		tx := kv.transactions[len(kv.transactions)-1]
		tx[key] = nil
	} else {
		delete(kv.data, key)
	}
}

func (kv *KVStore) Begin() {
	kv.transactions = append(kv.transactions, make(map[string]*string))
}

func (kv *KVStore) Commit() bool {
	if len(kv.transactions) == 0 {
		return false
	}
	tx := kv.transactions[len(kv.transactions)-1]
	kv.transactions = kv.transactions[:len(kv.transactions)-1]

	if len(kv.transactions) > 0 {
		parent := kv.transactions[len(kv.transactions)-1]
		for k, v := range tx {
			parent[k] = v
		}
	} else {
		for k, v := range tx {
			if v == nil {
				delete(kv.data, k)
			} else {
				kv.data[k] = *v
			}
		}
	}
	return true
}

func (kv *KVStore) Rollback() bool {
	if len(kv.transactions) == 0 {
		return false
	}
	kv.transactions = kv.transactions[:len(kv.transactions)-1]
	return true
}

func main() {
	store := NewKVStore()
	store.Set("a", "1")
	fmt.Println(store.Get("a")) // "1", true

	store.Begin()
	store.Set("a", "2")
	fmt.Println(store.Get("a")) // "2", true

	store.Begin() // nested transaction
	store.Set("a", "3")
	fmt.Println(store.Get("a")) // "3", true

	store.Rollback()
	fmt.Println(store.Get("a")) // "2", true

	store.Commit()
	fmt.Println(store.Get("a")) // "2", true
}
```

**Time Complexity:** O(d) for Get where d is transaction depth. O(k) for Commit where k is keys modified in the transaction. **Space Complexity:** O(d * k) for transaction layers.

#### Question 3: Clone Graph (Medium)

*Microsoft frequently asks graph problems. This tests understanding of reference semantics and avoiding infinite loops with visited tracking.*

**Key Insight:** Use a map from original node to cloned node. DFS recursively, returning the clone if already visited to handle cycles.

```go
package main

import "fmt"

type GraphNode struct {
	Val       int
	Neighbors []*GraphNode
}

func cloneGraph(node *GraphNode) *GraphNode {
	if node == nil {
		return nil
	}

	visited := make(map[*GraphNode]*GraphNode)

	var clone func(n *GraphNode) *GraphNode
	clone = func(n *GraphNode) *GraphNode {
		if c, ok := visited[n]; ok {
			return c
		}

		c := &GraphNode{Val: n.Val}
		visited[n] = c

		for _, neighbor := range n.Neighbors {
			c.Neighbors = append(c.Neighbors, clone(neighbor))
		}
		return c
	}

	return clone(node)
}

func main() {
	n1 := &GraphNode{Val: 1}
	n2 := &GraphNode{Val: 2}
	n3 := &GraphNode{Val: 3}
	n1.Neighbors = []*GraphNode{n2, n3}
	n2.Neighbors = []*GraphNode{n1, n3}
	n3.Neighbors = []*GraphNode{n1, n2}

	cloned := cloneGraph(n1)
	fmt.Printf("Original: %d, Clone: %d\n", n1.Val, cloned.Val)
	fmt.Printf("Same pointer? %v\n", n1 == cloned) // false
	fmt.Printf("Neighbors count: %d\n", len(cloned.Neighbors))
}
```

**Time Complexity:** O(V + E). **Space Complexity:** O(V) for the visited map.

#### Question 4: Design a Cache with TTL Expiration (Medium - Azure Pattern)

*Microsoft's Azure services rely on caching patterns. This tests practical production code with background cleanup.*

**Key Insight:** Combine a map with per-entry expiration. Use lazy expiration on read plus periodic background cleanup for entries never re-accessed.

```go
package main

import (
	"fmt"
	"sync"
	"time"
)

type cacheItem struct {
	value     any
	expiresAt time.Time
}

type ExpiringCache struct {
	mu    sync.RWMutex
	items map[string]cacheItem
	done  chan struct{}
}

func NewExpiringCache(cleanupInterval time.Duration) *ExpiringCache {
	cache := &ExpiringCache{
		items: make(map[string]cacheItem),
		done:  make(chan struct{}),
	}
	go cache.backgroundCleanup(cleanupInterval)
	return cache
}

func (c *ExpiringCache) Set(key string, value any, ttl time.Duration) {
	c.mu.Lock()
	c.items[key] = cacheItem{value: value, expiresAt: time.Now().Add(ttl)}
	c.mu.Unlock()
}

func (c *ExpiringCache) Get(key string) (any, bool) {
	c.mu.RLock()
	item, ok := c.items[key]
	c.mu.RUnlock()
	if !ok || time.Now().After(item.expiresAt) {
		return nil, false
	}
	return item.value, true
}

func (c *ExpiringCache) Delete(key string) {
	c.mu.Lock()
	delete(c.items, key)
	c.mu.Unlock()
}

func (c *ExpiringCache) backgroundCleanup(interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			c.mu.Lock()
			now := time.Now()
			for k, v := range c.items {
				if now.After(v.expiresAt) {
					delete(c.items, k)
				}
			}
			c.mu.Unlock()
		case <-c.done:
			return
		}
	}
}

func (c *ExpiringCache) Close() {
	close(c.done)
}

func main() {
	cache := NewExpiringCache(5 * time.Second)
	defer cache.Close()

	cache.Set("session-abc", "user-123", 2*time.Second)
	if v, ok := cache.Get("session-abc"); ok {
		fmt.Println("Found:", v) // Found: user-123
	}

	time.Sleep(3 * time.Second)
	if _, ok := cache.Get("session-abc"); !ok {
		fmt.Println("Expired") // Expired
	}
}
```

**Time Complexity:** O(1) for Get and Set. O(n) for background cleanup. **Space Complexity:** O(n).

#### Question 5: Reverse Words in a String (Easy)

*A classic Microsoft warm-up problem. Simple but tests clean code habits.*

**Key Insight:** Split on whitespace, reverse the slice, join. Go's strings.Fields handles multiple spaces cleanly.

```go
package main

import (
	"fmt"
	"strings"
)

func reverseWords(s string) string {
	words := strings.Fields(s)
	for i, j := 0, len(words)-1; i < j; i, j = i+1, j-1 {
		words[i], words[j] = words[j], words[i]
	}
	return strings.Join(words, " ")
}

func main() {
	fmt.Println(reverseWords("the sky is blue"))   // "blue is sky the"
	fmt.Println(reverseWords("  hello world  "))    // "world hello"
	fmt.Println(reverseWords("a good   example"))   // "example good a"
}
```

**Time Complexity:** O(n). **Space Complexity:** O(n).

#### Question 6: Spiral Matrix (Medium)

*Microsoft frequently asks matrix traversal problems. This tests careful boundary management.*

**Key Insight:** Use four boundaries (top, bottom, left, right) and contract them after each traversal direction.

```go
package main

import "fmt"

func spiralOrder(matrix [][]int) []int {
	if len(matrix) == 0 {
		return nil
	}
	top, bottom := 0, len(matrix)-1
	left, right := 0, len(matrix[0])-1
	var result []int

	for top <= bottom && left <= right {
		for c := left; c <= right; c++ {
			result = append(result, matrix[top][c])
		}
		top++
		for r := top; r <= bottom; r++ {
			result = append(result, matrix[r][right])
		}
		right--
		if top <= bottom {
			for c := right; c >= left; c-- {
				result = append(result, matrix[bottom][c])
			}
			bottom--
		}
		if left <= right {
			for r := bottom; r >= top; r-- {
				result = append(result, matrix[r][left])
			}
			left++
		}
	}
	return result
}

func main() {
	matrix := [][]int{{1, 2, 3}, {4, 5, 6}, {7, 8, 9}}
	fmt.Println(spiralOrder(matrix)) // [1 2 3 6 9 8 7 4 5]
}
```

**Time Complexity:** O(m * n). **Space Complexity:** O(1) excluding the result.

#### Question 7: Word Break (Medium)

*Microsoft tests dynamic programming fundamentals. This problem has clear subproblem structure.*

**Key Insight:** dp[i] is true if s[0:i] can be segmented into dictionary words. For each position, check all possible last words.

```go
package main

import "fmt"

func wordBreak(s string, wordDict []string) bool {
	wordSet := make(map[string]bool)
	for _, w := range wordDict {
		wordSet[w] = true
	}
	dp := make([]bool, len(s)+1)
	dp[0] = true

	for i := 1; i <= len(s); i++ {
		for j := 0; j < i; j++ {
			if dp[j] && wordSet[s[j:i]] {
				dp[i] = true
				break
			}
		}
	}
	return dp[len(s)]
}

func main() {
	fmt.Println(wordBreak("leetcode", []string{"leet", "code"}))   // true
	fmt.Println(wordBreak("applepenapple", []string{"apple", "pen"})) // true
	fmt.Println(wordBreak("catsandog", []string{"cats", "dog", "sand", "and", "cat"})) // false
}
```

**Time Complexity:** O(n^2 * m) where n is string length and m is max word length. **Space Complexity:** O(n).

#### Question 8: Group Anagrams (Easy-Medium)

*Tests hash map usage and creative key design. Microsoft values clean, efficient solutions.*

**Key Insight:** Use a character frequency array as the map key. This avoids the O(k log k) cost of sorting each string.

```go
package main

import "fmt"

func groupAnagrams(strs []string) [][]string {
	groups := make(map[[26]byte][]string)
	for _, s := range strs {
		var key [26]byte
		for _, c := range s {
			key[c-'a']++
		}
		groups[key] = append(groups[key], s)
	}

	result := make([][]string, 0, len(groups))
	for _, group := range groups {
		result = append(result, group)
	}
	return result
}

func main() {
	strs := []string{"eat", "tea", "tan", "ate", "nat", "bat"}
	groups := groupAnagrams(strs)
	for _, g := range groups {
		fmt.Println(g)
	}
}
```

**Time Complexity:** O(n * k) where n is the number of strings and k is the average string length. **Space Complexity:** O(n * k).

#### Question 9: Min Stack with O(1) Operations (Easy)

*A Microsoft staple. Tests understanding of auxiliary data structures for constant-time operations.*

**Key Insight:** Maintain a parallel min stack. Push to the min stack when the new value is less than or equal to the current minimum.

```go
package main

import "fmt"

type MinStack struct {
	stack    []int
	minStack []int
}

func NewMinStack() *MinStack { return &MinStack{} }

func (ms *MinStack) Push(val int) {
	ms.stack = append(ms.stack, val)
	if len(ms.minStack) == 0 || val <= ms.minStack[len(ms.minStack)-1] {
		ms.minStack = append(ms.minStack, val)
	}
}

func (ms *MinStack) Pop() {
	val := ms.stack[len(ms.stack)-1]
	ms.stack = ms.stack[:len(ms.stack)-1]
	if val == ms.minStack[len(ms.minStack)-1] {
		ms.minStack = ms.minStack[:len(ms.minStack)-1]
	}
}

func (ms *MinStack) Top() int    { return ms.stack[len(ms.stack)-1] }
func (ms *MinStack) GetMin() int { return ms.minStack[len(ms.minStack)-1] }

func main() {
	ms := NewMinStack()
	ms.Push(-2)
	ms.Push(0)
	ms.Push(-3)
	fmt.Println(ms.GetMin()) // -3
	ms.Pop()
	fmt.Println(ms.Top())    // 0
	fmt.Println(ms.GetMin()) // -2
}
```

**Time Complexity:** O(1) for all operations. **Space Complexity:** O(n).

#### Question 10: String to Integer (atoi) (Easy-Medium)

*Microsoft tests attention to detail with parsing problems. The edge cases (overflow, whitespace, signs) are the real challenge.*

**Key Insight:** Handle whitespace trimming, sign detection, digit parsing, and overflow checking in sequence. Each step has specific edge cases.

```go
package main

import (
	"fmt"
	"math"
	"strings"
)

func myAtoi(s string) int {
	s = strings.TrimSpace(s)
	if len(s) == 0 {
		return 0
	}

	sign := 1
	idx := 0
	if s[0] == '+' || s[0] == '-' {
		if s[0] == '-' {
			sign = -1
		}
		idx++
	}

	result := 0
	for idx < len(s) && s[idx] >= '0' && s[idx] <= '9' {
		digit := int(s[idx] - '0')
		if result > (math.MaxInt32-digit)/10 {
			if sign == 1 {
				return math.MaxInt32
			}
			return math.MinInt32
		}
		result = result*10 + digit
		idx++
	}
	return sign * result
}

func main() {
	fmt.Println(myAtoi("42"))           // 42
	fmt.Println(myAtoi("   -42"))       // -42
	fmt.Println(myAtoi("4193 with words")) // 4193
	fmt.Println(myAtoi("999999999999")) // 2147483647 (overflow)
}
```

**Time Complexity:** O(n). **Space Complexity:** O(1).

#### Question 11: Maximum Subarray - Kadane's Algorithm (Easy)

*A Microsoft warm-up classic. Tests DP thinking in its simplest form.*

**Key Insight:** Track the current sum. If it goes negative, reset to the current element. Track the global maximum throughout.

```go
package main

import "fmt"

func maxSubArray(nums []int) int {
	maxSum, currSum := nums[0], nums[0]
	for i := 1; i < len(nums); i++ {
		if currSum < 0 {
			currSum = nums[i]
		} else {
			currSum += nums[i]
		}
		if currSum > maxSum {
			maxSum = currSum
		}
	}
	return maxSum
}

func main() {
	fmt.Println(maxSubArray([]int{-2, 1, -3, 4, -1, 2, 1, -5, 4})) // 6
	fmt.Println(maxSubArray([]int{1}))                                // 1
	fmt.Println(maxSubArray([]int{-1}))                               // -1
}
```

**Time Complexity:** O(n). **Space Complexity:** O(1).

#### Question 12: Valid Parentheses (Easy)

*Microsoft uses this as a warm-up or phone screen problem. Clean, correct implementation is expected.*

**Key Insight:** Use a stack. Push opening brackets, pop and match on closing brackets.

```go
package main

import "fmt"

func isValid(s string) bool {
	stack := make([]byte, 0, len(s))
	pairs := map[byte]byte{')': '(', ']': '[', '}': '{'}
	for i := 0; i < len(s); i++ {
		if s[i] == '(' || s[i] == '[' || s[i] == '{' {
			stack = append(stack, s[i])
		} else {
			if len(stack) == 0 || stack[len(stack)-1] != pairs[s[i]] {
				return false
			}
			stack = stack[:len(stack)-1]
		}
	}
	return len(stack) == 0
}

func main() {
	fmt.Println(isValid("()"))     // true
	fmt.Println(isValid("()[]{}")) // true
	fmt.Println(isValid("(]"))     // false
	fmt.Println(isValid("([)]"))   // false
}
```

**Time Complexity:** O(n). **Space Complexity:** O(n).

#### Question 13: 3Sum (Medium)

*Microsoft asks this frequently. Tests two-pointer technique and deduplication logic.*

**Key Insight:** Sort the array, fix one element, then use two pointers for the remaining pair. Skip duplicates at all three positions.

```go
package main

import (
	"fmt"
	"slices"
)

func threeSum(nums []int) [][]int {
	slices.Sort(nums)
	var result [][]int

	for i := 0; i < len(nums)-2; i++ {
		if i > 0 && nums[i] == nums[i-1] {
			continue
		}
		lo, hi := i+1, len(nums)-1
		for lo < hi {
			sum := nums[i] + nums[lo] + nums[hi]
			if sum == 0 {
				result = append(result, []int{nums[i], nums[lo], nums[hi]})
				for lo < hi && nums[lo] == nums[lo+1] {
					lo++
				}
				for lo < hi && nums[hi] == nums[hi-1] {
					hi--
				}
				lo++
				hi--
			} else if sum < 0 {
				lo++
			} else {
				hi--
			}
		}
	}
	return result
}

func main() {
	fmt.Println(threeSum([]int{-1, 0, 1, 2, -1, -4}))
	// [[-1,-1,2],[-1,0,1]]
}
```

**Time Complexity:** O(n^2). **Space Complexity:** O(1) excluding the result.

#### Question 14: Binary Search - Search in Rotated Sorted Array (Medium)

*Microsoft tests binary search variations. This requires careful handling of which half is sorted.*

**Key Insight:** In a rotated sorted array, one half is always sorted. Determine which half is sorted, then decide if the target falls within the sorted half.

```go
package main

import "fmt"

func searchRotated(nums []int, target int) int {
	lo, hi := 0, len(nums)-1

	for lo <= hi {
		mid := lo + (hi-lo)/2
		if nums[mid] == target {
			return mid
		}

		if nums[lo] <= nums[mid] {
			// Left half is sorted
			if target >= nums[lo] && target < nums[mid] {
				hi = mid - 1
			} else {
				lo = mid + 1
			}
		} else {
			// Right half is sorted
			if target > nums[mid] && target <= nums[hi] {
				lo = mid + 1
			} else {
				hi = mid - 1
			}
		}
	}
	return -1
}

func main() {
	fmt.Println(searchRotated([]int{4, 5, 6, 7, 0, 1, 2}, 0)) // 4
	fmt.Println(searchRotated([]int{4, 5, 6, 7, 0, 1, 2}, 3)) // -1
	fmt.Println(searchRotated([]int{1}, 0))                     // -1
}
```

**Time Complexity:** O(log n). **Space Complexity:** O(1).

#### Question 15: Implement pow(x, n) - Fast Exponentiation (Easy-Medium)

*Tests mathematical thinking and handling of negative exponents. Microsoft values correctness for edge cases.*

**Key Insight:** Binary exponentiation: square x and halve n at each step. Handle negative n by inverting x.

```go
package main

import "fmt"

func myPow(x float64, n int) float64 {
	if n < 0 {
		x = 1 / x
		n = -n
	}
	result := 1.0
	for n > 0 {
		if n%2 == 1 {
			result *= x
		}
		x *= x
		n /= 2
	}
	return result
}

func main() {
	fmt.Println(myPow(2.0, 10))  // 1024
	fmt.Println(myPow(2.1, 3))   // 9.261
	fmt.Println(myPow(2.0, -2))  // 0.25
}
```

**Time Complexity:** O(log n). **Space Complexity:** O(1).

#### Question 16: Design a Logger Rate Limiter (Easy)

*Practical systems problem. Microsoft uses these patterns in Azure's logging infrastructure.*

**Key Insight:** Track the last print timestamp for each message. Only allow printing if at least 10 seconds have passed.

```go
package main

import "fmt"

type Logger struct {
	timestamps map[string]int
}

func NewLogger() *Logger {
	return &Logger{timestamps: make(map[string]int)}
}

func (l *Logger) ShouldPrintMessage(timestamp int, message string) bool {
	if ts, ok := l.timestamps[message]; ok && timestamp-ts < 10 {
		return false
	}
	l.timestamps[message] = timestamp
	return true
}

func main() {
	logger := NewLogger()
	fmt.Println(logger.ShouldPrintMessage(1, "foo"))  // true
	fmt.Println(logger.ShouldPrintMessage(2, "bar"))  // true
	fmt.Println(logger.ShouldPrintMessage(3, "foo"))  // false
	fmt.Println(logger.ShouldPrintMessage(8, "bar"))  // false
	fmt.Println(logger.ShouldPrintMessage(10, "foo")) // false
	fmt.Println(logger.ShouldPrintMessage(11, "foo")) // true
}
```

**Time Complexity:** O(1). **Space Complexity:** O(unique messages).

#### Question 17: Design a Concurrent Task Scheduler (Medium-Hard - Microsoft-Specific)

*Microsoft builds scheduling systems for Azure Batch, Azure Functions, and Azure DevOps pipelines. This tests concurrent Go programming applied to a real problem.*

**Key Insight:** Use a priority queue for scheduling, a worker pool for execution, and dependency tracking to ensure tasks run in the correct order.

```go
package main

import (
	"container/heap"
	"context"
	"fmt"
	"sync"
	"time"
)

type Task struct {
	ID       string
	Priority int // lower = higher priority
	Deps     []string
	Fn       func() error
	index    int // for heap interface
}

type TaskQueue []*Task

func (tq TaskQueue) Len() int            { return len(tq) }
func (tq TaskQueue) Less(i, j int) bool  { return tq[i].Priority < tq[j].Priority }
func (tq TaskQueue) Swap(i, j int)       { tq[i], tq[j] = tq[j], tq[i]; tq[i].index = i; tq[j].index = j }
func (tq *TaskQueue) Push(x any)         { t := x.(*Task); t.index = len(*tq); *tq = append(*tq, t) }
func (tq *TaskQueue) Pop() any           { old := *tq; n := len(old); t := old[n-1]; t.index = -1; *tq = old[:n-1]; return t }

type TaskScheduler struct {
	mu        sync.Mutex
	queue     TaskQueue
	completed map[string]bool
	workers   int
	results   map[string]error
}

func NewTaskScheduler(workers int) *TaskScheduler {
	ts := &TaskScheduler{
		completed: make(map[string]bool),
		workers:   workers,
		results:   make(map[string]error),
	}
	heap.Init(&ts.queue)
	return ts
}

func (ts *TaskScheduler) AddTask(task *Task) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	heap.Push(&ts.queue, task)
}

func (ts *TaskScheduler) depsReady(task *Task) bool {
	for _, dep := range task.Deps {
		if !ts.completed[dep] {
			return false
		}
	}
	return true
}

func (ts *TaskScheduler) Run(ctx context.Context) map[string]error {
	sem := make(chan struct{}, ts.workers)
	var wg sync.WaitGroup

	for {
		ts.mu.Lock()
		if ts.queue.Len() == 0 {
			ts.mu.Unlock()
			break
		}

		// Find a ready task
		var ready *Task
		deferred := make([]*Task, 0)
		for ts.queue.Len() > 0 {
			candidate := heap.Pop(&ts.queue).(*Task)
			if ts.depsReady(candidate) {
				ready = candidate
				break
			}
			deferred = append(deferred, candidate)
		}
		for _, d := range deferred {
			heap.Push(&ts.queue, d)
		}
		ts.mu.Unlock()

		if ready == nil {
			time.Sleep(10 * time.Millisecond)
			continue
		}

		sem <- struct{}{}
		wg.Add(1)
		go func(t *Task) {
			defer wg.Done()
			defer func() { <-sem }()

			err := t.Fn()

			ts.mu.Lock()
			ts.results[t.ID] = err
			if err == nil {
				ts.completed[t.ID] = true
			}
			ts.mu.Unlock()
		}(ready)
	}

	wg.Wait()
	return ts.results
}

func main() {
	scheduler := NewTaskScheduler(2)

	scheduler.AddTask(&Task{
		ID: "build", Priority: 1,
		Fn: func() error { fmt.Println("Building..."); time.Sleep(50 * time.Millisecond); return nil },
	})
	scheduler.AddTask(&Task{
		ID: "test", Priority: 2, Deps: []string{"build"},
		Fn: func() error { fmt.Println("Testing..."); time.Sleep(30 * time.Millisecond); return nil },
	})
	scheduler.AddTask(&Task{
		ID: "deploy", Priority: 3, Deps: []string{"test"},
		Fn: func() error { fmt.Println("Deploying..."); return nil },
	})

	results := scheduler.Run(context.Background())
	for id, err := range results {
		status := "OK"
		if err != nil {
			status = err.Error()
		}
		fmt.Printf("%s: %s\n", id, status)
	}
}
```

**Time Complexity:** O(n log n) for scheduling n tasks. **Space Complexity:** O(n).

#### Question 18: Number of Islands (Medium)

*Classic BFS/DFS problem. Microsoft expects clean, well-structured solutions with clear traversal logic.*

**Key Insight:** Iterate through the grid. When you find a '1', increment the count and flood-fill (BFS or DFS) to mark the entire island as visited.

```go
package main

import "fmt"

func numIslands(grid [][]byte) int {
	if len(grid) == 0 {
		return 0
	}
	rows, cols := len(grid), len(grid[0])
	count := 0

	var dfs func(r, c int)
	dfs = func(r, c int) {
		if r < 0 || r >= rows || c < 0 || c >= cols || grid[r][c] != '1' {
			return
		}
		grid[r][c] = '0' // mark visited
		dfs(r+1, c)
		dfs(r-1, c)
		dfs(r, c+1)
		dfs(r, c-1)
	}

	for r := 0; r < rows; r++ {
		for c := 0; c < cols; c++ {
			if grid[r][c] == '1' {
				count++
				dfs(r, c)
			}
		}
	}
	return count
}

func main() {
	grid := [][]byte{
		{'1', '1', '0', '0', '0'},
		{'1', '1', '0', '0', '0'},
		{'0', '0', '1', '0', '0'},
		{'0', '0', '0', '1', '1'},
	}
	fmt.Println(numIslands(grid)) // 3
}
```

**Time Complexity:** O(m * n). **Space Complexity:** O(m * n) for the recursion stack in the worst case.

#### Question 19: LRU Cache (Medium)

*A universal interview problem, but Microsoft expects particularly clean implementation with good Go idioms.*

**Key Insight:** Doubly linked list for O(1) move-to-front and removal. Hash map for O(1) key lookup. The combination gives O(1) for both Get and Put.

```go
package main

import (
	"container/list"
	"fmt"
)

type lruEntry struct {
	key   int
	value int
}

type LRUCache struct {
	capacity int
	items    map[int]*list.Element
	order    *list.List
}

func NewLRUCache(capacity int) *LRUCache {
	return &LRUCache{
		capacity: capacity,
		items:    make(map[int]*list.Element, capacity),
		order:    list.New(),
	}
}

func (c *LRUCache) Get(key int) int {
	elem, ok := c.items[key]
	if !ok {
		return -1
	}
	c.order.MoveToFront(elem)
	return elem.Value.(*lruEntry).value
}

func (c *LRUCache) Put(key, value int) {
	if elem, ok := c.items[key]; ok {
		elem.Value.(*lruEntry).value = value
		c.order.MoveToFront(elem)
		return
	}

	if c.order.Len() == c.capacity {
		oldest := c.order.Back()
		c.order.Remove(oldest)
		delete(c.items, oldest.Value.(*lruEntry).key)
	}

	entry := &lruEntry{key: key, value: value}
	elem := c.order.PushFront(entry)
	c.items[key] = elem
}

func main() {
	cache := NewLRUCache(2)
	cache.Put(1, 1)
	cache.Put(2, 2)
	fmt.Println(cache.Get(1)) // 1
	cache.Put(3, 3)           // evicts key 2
	fmt.Println(cache.Get(2)) // -1
}
```

**Time Complexity:** O(1) for both operations. **Space Complexity:** O(capacity).

#### Question 20: Design a Multi-Region Configuration Service (Hard - Microsoft-Specific)

*Azure operates in 60+ regions globally. This tests distributed systems design applied to Microsoft's actual infrastructure challenges.*

**Key Insight:** Use eventual consistency with vector clocks for conflict detection. Each region maintains a local copy that syncs asynchronously, with a conflict resolution strategy for concurrent updates.

```go
package main

import (
	"fmt"
	"sync"
	"time"
)

type ConfigEntry struct {
	Key       string
	Value     string
	Version   int64
	Region    string
	UpdatedAt time.Time
}

type RegionStore struct {
	mu      sync.RWMutex
	region  string
	configs map[string]*ConfigEntry
	version int64
}

func NewRegionStore(region string) *RegionStore {
	return &RegionStore{
		region:  region,
		configs: make(map[string]*ConfigEntry),
	}
}

func (rs *RegionStore) Set(key, value string) *ConfigEntry {
	rs.mu.Lock()
	defer rs.mu.Unlock()

	rs.version++
	entry := &ConfigEntry{
		Key:       key,
		Value:     value,
		Version:   rs.version,
		Region:    rs.region,
		UpdatedAt: time.Now(),
	}
	rs.configs[key] = entry
	return entry
}

func (rs *RegionStore) Get(key string) (*ConfigEntry, bool) {
	rs.mu.RLock()
	defer rs.mu.RUnlock()
	entry, ok := rs.configs[key]
	return entry, ok
}

// Merge applies a remote entry using last-writer-wins with region tiebreaker.
func (rs *RegionStore) Merge(remote *ConfigEntry) bool {
	rs.mu.Lock()
	defer rs.mu.Unlock()

	local, exists := rs.configs[remote.Key]
	if !exists {
		rs.configs[remote.Key] = remote
		return true
	}

	// Last-writer-wins with deterministic tiebreaker
	if remote.UpdatedAt.After(local.UpdatedAt) ||
		(remote.UpdatedAt.Equal(local.UpdatedAt) && remote.Region > local.Region) {
		rs.configs[remote.Key] = remote
		return true
	}
	return false
}

// MultiRegionConfigService coordinates config across regions.
type MultiRegionConfigService struct {
	mu      sync.RWMutex
	regions map[string]*RegionStore
}

func NewMultiRegionConfigService(regionNames []string) *MultiRegionConfigService {
	svc := &MultiRegionConfigService{
		regions: make(map[string]*RegionStore),
	}
	for _, name := range regionNames {
		svc.regions[name] = NewRegionStore(name)
	}
	return svc
}

func (svc *MultiRegionConfigService) SetInRegion(region, key, value string) error {
	svc.mu.RLock()
	rs, ok := svc.regions[region]
	svc.mu.RUnlock()
	if !ok {
		return fmt.Errorf("unknown region: %s", region)
	}

	entry := rs.Set(key, value)

	// Async replication to other regions
	go svc.replicate(region, entry)
	return nil
}

func (svc *MultiRegionConfigService) GetFromRegion(region, key string) (string, bool) {
	svc.mu.RLock()
	rs, ok := svc.regions[region]
	svc.mu.RUnlock()
	if !ok {
		return "", false
	}

	entry, exists := rs.Get(key)
	if !exists {
		return "", false
	}
	return entry.Value, true
}

func (svc *MultiRegionConfigService) replicate(sourceRegion string, entry *ConfigEntry) {
	svc.mu.RLock()
	defer svc.mu.RUnlock()

	for name, rs := range svc.regions {
		if name == sourceRegion {
			continue
		}
		rs.Merge(entry)
	}
}

func main() {
	svc := NewMultiRegionConfigService([]string{"us-east", "us-west", "eu-west"})

	svc.SetInRegion("us-east", "feature.enabled", "true")
	svc.SetInRegion("eu-west", "max.connections", "1000")

	time.Sleep(100 * time.Millisecond) // allow replication

	for _, region := range []string{"us-east", "us-west", "eu-west"} {
		v1, _ := svc.GetFromRegion(region, "feature.enabled")
		v2, _ := svc.GetFromRegion(region, "max.connections")
		fmt.Printf("%s: feature.enabled=%s, max.connections=%s\n", region, v1, v2)
	}
}
```

**Time Complexity:** O(R) per write for replication where R is number of regions. O(1) for reads. **Space Complexity:** O(K * R) where K is number of config keys.

### System Design Topics Microsoft Favors

**Top 5 System Design Questions Asked at Microsoft:**

1. **Design a Global File Sync Service (OneDrive)** - Multi-device file synchronization with conflict resolution, offline support, and efficient delta sync. Microsoft expects deep understanding of file system semantics, chunked uploads, deduplication, and cross-platform consistency. How do you handle a user editing the same file on two devices while offline?

2. **Design a Multi-Region Database (Cosmos DB)** - Globally distributed database with configurable consistency levels (strong, bounded staleness, session, consistent prefix, eventual). Microsoft expects you to understand the CAP theorem trade-offs for each consistency level and when to use which. How does automatic failover work? How do you handle partition splits?

3. **Design a CI/CD Pipeline System (Azure DevOps)** - Build and deployment orchestration with dependency management, parallelism, artifact management, and multi-environment promotion. Focus on the agent architecture, task scheduling, and how to handle flaky tests and partial failures. This is a bread-and-butter Microsoft question.

4. **Design a Real-Time Collaboration System (Microsoft Teams)** - Real-time messaging, presence, file sharing, and video call orchestration for millions of concurrent users. Focus on WebSocket management at scale, message ordering guarantees, and the read/write path separation for message history vs. live updates.

5. **Design an Enterprise Identity and Access Management System (Azure AD / Entra ID)** - Authentication, authorization, and identity management for millions of enterprise tenants. Topics include OAuth 2.0/OIDC flows, token management, conditional access policies, and multi-tenant data isolation.

**How deep they go:** Microsoft system design rounds are 45 minutes and typically cover high-level architecture (10 min), detailed component design (20 min), and trade-off discussion (15 min). Azure awareness gives you a significant advantage - you can reference specific Azure services and discuss their characteristics.

**What they look for:** Reliability and fault tolerance (what happens when a datacenter goes down?), global distribution (multi-region active-active vs. active-passive), cloud-native patterns (event-driven, serverless, containerized), security (authentication, authorization, encryption at rest and in transit), and customer impact (SLA guarantees, latency requirements, data residency compliance).

### Behavioral Focus

Microsoft's behavioral interviews are heavily centered on three themes.

**Growth Mindset:**
- "Tell me about a time you were wrong about something technical. How did you realize it and what did you do?"
- "Describe a technology or approach you initially resisted but later adopted. What changed your mind?"
- "How do you stay current with technology? Give a specific example of how something you learned recently influenced your work."
- Microsoft wants to hear genuine stories of learning, adaptation, and intellectual humility. The ideal candidate says "I was wrong, I learned, I changed." Candidates who present themselves as always right signal the opposite of growth mindset.

**Customer Obsession:**
- "Describe a time you changed a technical approach based on customer feedback."
- "Tell me about a trade-off you made between technical elegance and customer needs."
- "How do you decide which technical problems are most important to solve?"
- Microsoft wants engineers who think about the end user, not just the technology. Connecting technical decisions to customer outcomes is a strong signal.

**Diversity and Inclusion:**
- "Tell me about a time you worked with someone whose background or perspective was very different from yours. How did that affect the project?"
- "Describe a situation where you noticed someone being excluded from a discussion. What did you do?"
- "How do you ensure that your technical decisions are inclusive and accessible?"
- Microsoft takes D&I seriously in interviews. Genuine stories about collaboration across differences, creating inclusive environments, and considering accessibility are strong positive signals.

### Preparation Timeline (6-10 weeks)

| Week | Focus | Daily Hours | Key Activities |
|------|-------|-------------|----------------|
| 1-2 | Coding Foundations | 3h | Medium problems with thorough edge case handling. Practice one-problem-deep format: solve, test, extend, optimize. Write clean Go code with proper error handling. |
| 3-4 | System Design | 3-4h | Azure-aware cloud patterns. Multi-region design, eventual consistency, event-driven architecture. Study Cosmos DB consistency models, Service Bus patterns. |
| 5-6 | Advanced Coding + Go OSS | 3h | Medium-hard problems. Study Dapr and KEDA source code for architecture patterns. Build small Go services that integrate with cloud patterns. |
| 7-8 | Growth Mindset Stories | 2-3h | Prepare 8+ behavioral stories emphasizing learning, changing your mind, and collaboration. Practice the AA round format: deep behavioral + technical discussion. |
| 9-10 | Mock Interviews | 3-4h | Full loop mocks including AA round simulation. Practice one-problem-per-round format with thorough testing and extension handling. |

**Key differences from generic FAANG prep:** Microsoft's one-problem-per-round format means depth beats breadth. Practice solving fewer problems more thoroughly rather than racing through many. The AA round is unique - practice having a senior technical leader probe your weaknesses and growth areas. Azure awareness (even surface-level) differentiates you from candidates who prepare generically.

### Insider Tips

**What most candidates get wrong:**
- Rushing through problems like they are at a Meta interview. Microsoft gives you one problem and 45 minutes - use the time to write clean code, test thoroughly, and discuss thoughtfully.
- Not preparing for the AA round. The AA interviewer has read all previous feedback and will probe your weakest area. If one interviewer flagged your system design as average, the AA will ask a system design follow-up. Be ready for targeted deep-dives.
- Underestimating the behavioral bar. Microsoft's growth mindset assessment is genuine, not a formality. Candidates who present themselves as always right, who never admit mistakes, or who cannot describe how they have grown are rejected even with strong technical performance.

**What makes a "strong hire" signal:**
- Writing correct, clean code on the first attempt with proper edge case handling and testing. Microsoft values getting it right the first time over iterating quickly.
- Connecting technical decisions to customer outcomes. "This design choice reduces deployment risk for our enterprise customers" resonates more than "This is more elegant architecturally."
- Demonstrating genuine growth mindset through specific stories. "I was wrong about X, here's what I learned, and here's how it changed my approach" is the strongest behavioral signal.
- Asking insightful questions about the team's technical challenges, Microsoft's approach to a specific problem, or the interviewer's own engineering journey.

**Red flags that lead to rejection:**
- Arrogance or inability to accept feedback. If the interviewer suggests a different approach and you dismiss it without consideration, that is a rejection signal.
- Generic FAANG preparation without Microsoft awareness. Not knowing what Azure is, not being aware of Microsoft's open-source Go projects, or treating Microsoft like it is still a 2008-era company signals low interest.
- Poor communication. Microsoft values engineers who explain their thinking clearly. Coding in silence without narrating your approach is a red flag.
- Not testing your code. Microsoft interviewers expect you to test with multiple inputs, including edge cases, before declaring your solution complete.

**How to stand out from other candidates:**
- Mention and discuss Microsoft's open-source Go projects (Dapr, KEDA). "I studied Dapr's actor model implementation and found the approach to distributed state management elegant" demonstrates genuine interest and technical depth.
- In system design, reference Azure services by name and discuss their trade-offs. This signals alignment with Microsoft's ecosystem without requiring deep Azure expertise.
- Demonstrate growth mindset in real-time during the interview. When you make a mistake, acknowledge it openly: "I see the bug - my initial assumption about the invariant was wrong. Let me reconsider." This is exactly what Microsoft wants to see.
- Ask the AA interviewer about their own career journey and what they have learned. AAs appreciate candidates who demonstrate genuine curiosity about others.

---
- Focus on reliability, fault tolerance, and global distribution
- Expect questions about multi-region architecture and disaster recovery

**Behavioral: Growth mindset.**
- "Tell me about a time you were wrong about something technical"
- "How do you approach learning a new technology?"
- "Describe a time you changed your approach based on feedback"
- Microsoft values humility, learning orientation, and collaboration

### Go at Microsoft

Go has significant presence at Microsoft:
- **Azure services** - many Azure backend services are written in Go
- **VS Code extensions backend** - language server protocols, tooling
- **GitHub infrastructure** - since Microsoft acquired GitHub, much of GitHub's Go codebase counts
- **Kubernetes tooling** - AKS (Azure Kubernetes Service) tooling
- **KEDA** - Kubernetes Event-Driven Autoscaling (open source, Microsoft-maintained)
- **Dapr** - Distributed Application Runtime, a major Microsoft open-source Go project

### Level Expectations

**SDE (59-60) - 0-2 years:**
- Solve medium problems correctly with solid code quality
- Basic system design understanding
- Demonstrate curiosity and growth mindset

**SDE II (61-62) - 2-5 years:**
- Solve medium-hard problems with thorough edge case handling
- Design moderate-scale systems with cloud patterns
- Show independence and ability to mentor others

**Senior SDE (63-64) - 5-10 years:**
- Solve hard problems and discuss multiple approaches with trade-offs
- Design complex distributed systems at global scale
- Demonstrate technical leadership and cross-team influence

**Principal SDE (65-67) - 10+ years:**
- System design mastery, architecture vision
- Org-level technical strategy and direction
- AA round may be with a CVP or Technical Fellow

### Top 15 Microsoft Interview Questions with Solutions

#### Question 1: Implement a Text Editor with Undo/Redo

*Microsoft loves editor/productivity tool problems.*

```go
package main

import (
	"fmt"
)

type Command interface {
	Execute()
	Undo()
}

type InsertCommand struct {
	editor   *TextEditor
	position int
	text     string
}

func (c *InsertCommand) Execute() {
	c.editor.content = c.editor.content[:c.position] + c.text + c.editor.content[c.position:]
	c.editor.cursor = c.position + len(c.text)
}

func (c *InsertCommand) Undo() {
	c.editor.content = c.editor.content[:c.position] + c.editor.content[c.position+len(c.text):]
	c.editor.cursor = c.position
}

type DeleteCommand struct {
	editor   *TextEditor
	position int
	length   int
	deleted  string
}

func (c *DeleteCommand) Execute() {
	c.deleted = c.editor.content[c.position : c.position+c.length]
	c.editor.content = c.editor.content[:c.position] + c.editor.content[c.position+c.length:]
	c.editor.cursor = c.position
}

func (c *DeleteCommand) Undo() {
	c.editor.content = c.editor.content[:c.position] + c.deleted + c.editor.content[c.position:]
	c.editor.cursor = c.position + len(c.deleted)
}

type TextEditor struct {
	content   string
	cursor    int
	undoStack []Command
	redoStack []Command
}

func NewTextEditor() *TextEditor {
	return &TextEditor{}
}

func (e *TextEditor) Insert(position int, text string) {
	cmd := &InsertCommand{editor: e, position: position, text: text}
	cmd.Execute()
	e.undoStack = append(e.undoStack, cmd)
	e.redoStack = nil // clear redo stack on new action
}

func (e *TextEditor) Delete(position, length int) {
	cmd := &DeleteCommand{editor: e, position: position, length: length}
	cmd.Execute()
	e.undoStack = append(e.undoStack, cmd)
	e.redoStack = nil
}

func (e *TextEditor) Undo() bool {
	if len(e.undoStack) == 0 {
		return false
	}
	cmd := e.undoStack[len(e.undoStack)-1]
	e.undoStack = e.undoStack[:len(e.undoStack)-1]
	cmd.Undo()
	e.redoStack = append(e.redoStack, cmd)
	return true
}

func (e *TextEditor) Redo() bool {
	if len(e.redoStack) == 0 {
		return false
	}
	cmd := e.redoStack[len(e.redoStack)-1]
	e.redoStack = e.redoStack[:len(e.redoStack)-1]
	cmd.Execute()
	e.undoStack = append(e.undoStack, cmd)
	return true
}

func (e *TextEditor) String() string {
	return e.content
}

func main() {
	editor := NewTextEditor()
	editor.Insert(0, "Hello World")
	fmt.Println(editor) // "Hello World"

	editor.Insert(5, ",")
	fmt.Println(editor) // "Hello, World"

	editor.Delete(5, 1)
	fmt.Println(editor) // "Hello World"

	editor.Undo()
	fmt.Println(editor) // "Hello, World"

	editor.Redo()
	fmt.Println(editor) // "Hello World"
}
```

#### Question 2: Design a Key-Value Store with Transactions

Database transactions ensure atomicity across multiple related operations, preventing partial updates that leave data in an inconsistent state. The following example demonstrates correct transaction demarcation with deferred rollback to guarantee cleanup on all exit paths.

```go
package main

import (
	"fmt"
)

type KVStore struct {
	data         map[string]string
	transactions []map[string]*string // nil value = deleted
}

func NewKVStore() *KVStore {
	return &KVStore{data: make(map[string]string)}
}

func (kv *KVStore) Set(key, value string) {
	if len(kv.transactions) > 0 {
		tx := kv.transactions[len(kv.transactions)-1]
		val := value
		tx[key] = &val
	} else {
		kv.data[key] = value
	}
}

func (kv *KVStore) Get(key string) (string, bool) {
	// Check transactions from newest to oldest
	for i := len(kv.transactions) - 1; i >= 0; i-- {
		if val, ok := kv.transactions[i][key]; ok {
			if val == nil {
				return "", false // deleted in this tx
			}
			return *val, true
		}
	}
	val, ok := kv.data[key]
	return val, ok
}

func (kv *KVStore) Delete(key string) {
	if len(kv.transactions) > 0 {
		tx := kv.transactions[len(kv.transactions)-1]
		tx[key] = nil
	} else {
		delete(kv.data, key)
	}
}

func (kv *KVStore) Begin() {
	kv.transactions = append(kv.transactions, make(map[string]*string))
}

func (kv *KVStore) Commit() bool {
	if len(kv.transactions) == 0 {
		return false
	}
	tx := kv.transactions[len(kv.transactions)-1]
	kv.transactions = kv.transactions[:len(kv.transactions)-1]

	if len(kv.transactions) > 0 {
		// Merge into parent transaction
		parent := kv.transactions[len(kv.transactions)-1]
		for k, v := range tx {
			parent[k] = v
		}
	} else {
		// Apply to data store
		for k, v := range tx {
			if v == nil {
				delete(kv.data, k)
			} else {
				kv.data[k] = *v
			}
		}
	}
	return true
}

func (kv *KVStore) Rollback() bool {
	if len(kv.transactions) == 0 {
		return false
	}
	kv.transactions = kv.transactions[:len(kv.transactions)-1]
	return true
}

func main() {
	store := NewKVStore()
	store.Set("a", "1")
	fmt.Println(store.Get("a")) // "1", true

	store.Begin()
	store.Set("a", "2")
	fmt.Println(store.Get("a")) // "2", true

	store.Begin() // nested transaction
	store.Set("a", "3")
	fmt.Println(store.Get("a")) // "3", true

	store.Rollback()
	fmt.Println(store.Get("a")) // "2", true

	store.Commit()
	fmt.Println(store.Get("a")) // "2", true
}
```

#### Question 3: Clone Graph

Clone Graph is a representative problem from this company's interview pool, testing the data structure and algorithm knowledge that the engineering team considers prerequisite for the role. The following Go solution demonstrates the optimal approach, with inline comments explaining the key insight that reduces time or space complexity relative to the brute-force alternative.

```go
type GraphNode struct {
	Val       int
	Neighbors []*GraphNode
}

func cloneGraph(node *GraphNode) *GraphNode {
	if node == nil {
		return nil
	}

	visited := make(map[*GraphNode]*GraphNode)

	var clone func(n *GraphNode) *GraphNode
	clone = func(n *GraphNode) *GraphNode {
		if c, ok := visited[n]; ok {
			return c
		}

		c := &GraphNode{Val: n.Val}
		visited[n] = c

		for _, neighbor := range n.Neighbors {
			c.Neighbors = append(c.Neighbors, clone(neighbor))
		}
		return c
	}

	return clone(node)
}
```

#### Questions 4-15: Microsoft Favorites

The reference implementation below is written to the standard an interviewer expects: correct complexity and idiomatic use of the standard library.

```go
// Q4: Reverse Words in a String
func reverseWords(s string) string {
	words := strings.Fields(s)
	for i, j := 0, len(words)-1; i < j; i, j = i+1, j-1 {
		words[i], words[j] = words[j], words[i]
	}
	return strings.Join(words, " ")
}

// Q5: Spiral Matrix
func spiralOrder(matrix [][]int) []int {
	if len(matrix) == 0 {
		return nil
	}
	top, bottom := 0, len(matrix)-1
	left, right := 0, len(matrix[0])-1
	var result []int

	for top <= bottom && left <= right {
		for c := left; c <= right; c++ {
			result = append(result, matrix[top][c])
		}
		top++
		for r := top; r <= bottom; r++ {
			result = append(result, matrix[r][right])
		}
		right--
		if top <= bottom {
			for c := right; c >= left; c-- {
				result = append(result, matrix[bottom][c])
			}
			bottom--
		}
		if left <= right {
			for r := bottom; r >= top; r-- {
				result = append(result, matrix[r][left])
			}
			left++
		}
	}
	return result
}

// Q6: Design a Min Stack
type MinStack struct {
	stack    []int
	minStack []int
}

func NewMinStack() *MinStack {
	return &MinStack{}
}

func (ms *MinStack) Push(val int) {
	ms.stack = append(ms.stack, val)
	if len(ms.minStack) == 0 || val <= ms.minStack[len(ms.minStack)-1] {
		ms.minStack = append(ms.minStack, val)
	}
}

func (ms *MinStack) Pop() {
	val := ms.stack[len(ms.stack)-1]
	ms.stack = ms.stack[:len(ms.stack)-1]
	if val == ms.minStack[len(ms.minStack)-1] {
		ms.minStack = ms.minStack[:len(ms.minStack)-1]
	}
}

func (ms *MinStack) Top() int {
	return ms.stack[len(ms.stack)-1]
}

func (ms *MinStack) GetMin() int {
	return ms.minStack[len(ms.minStack)-1]
}

// Q7: Word Break
func wordBreak(s string, wordDict []string) bool {
	wordSet := make(map[string]bool)
	for _, w := range wordDict {
		wordSet[w] = true
	}
	dp := make([]bool, len(s)+1)
	dp[0] = true

	for i := 1; i <= len(s); i++ {
		for j := 0; j < i; j++ {
			if dp[j] && wordSet[s[j:i]] {
				dp[i] = true
				break
			}
		}
	}
	return dp[len(s)]
}

// Q8: Group Anagrams
func groupAnagrams(strs []string) [][]string {
	groups := make(map[[26]byte][]string)
	for _, s := range strs {
		var key [26]byte
		for _, c := range s {
			key[c-'a']++
		}
		groups[key] = append(groups[key], s)
	}

	result := make([][]string, 0, len(groups))
	for _, group := range groups {
		result = append(result, group)
	}
	return result
}

// Q9: Design a Cache with Expiration (Azure Cache pattern)
type ExpiringCache struct {
	mu    sync.RWMutex
	items map[string]cacheItem
}

type cacheItem struct {
	value     any
	expiresAt time.Time
}

func NewExpiringCache() *ExpiringCache {
	cache := &ExpiringCache{items: make(map[string]cacheItem)}
	go cache.evictExpired()
	return cache
}

func (c *ExpiringCache) Set(key string, value any, ttl time.Duration) {
	c.mu.Lock()
	c.items[key] = cacheItem{value: value, expiresAt: time.Now().Add(ttl)}
	c.mu.Unlock()
}

func (c *ExpiringCache) Get(key string) (any, bool) {
	c.mu.RLock()
	item, ok := c.items[key]
	c.mu.RUnlock()
	if !ok || time.Now().After(item.expiresAt) {
		return nil, false
	}
	return item.value, true
}

func (c *ExpiringCache) evictExpired() {
	ticker := time.NewTicker(30 * time.Second)
	for range ticker.C {
		c.mu.Lock()
		now := time.Now()
		for k, v := range c.items {
			if now.After(v.expiresAt) {
				delete(c.items, k)
			}
		}
		c.mu.Unlock()
	}
}

// Q10: String to Integer (atoi)
func myAtoi(s string) int {
	s = strings.TrimSpace(s)
	if len(s) == 0 {
		return 0
	}

	sign := 1
	idx := 0
	if s[0] == '+' || s[0] == '-' {
		if s[0] == '-' {
			sign = -1
		}
		idx++
	}

	result := 0
	for idx < len(s) && s[idx] >= '0' && s[idx] <= '9' {
		digit := int(s[idx] - '0')
		if result > (math.MaxInt32-digit)/10 {
			if sign == 1 {
				return math.MaxInt32
			}
			return math.MinInt32
		}
		result = result*10 + digit
		idx++
	}
	return sign * result
}

// Q11: Maximum Subarray (Kadane's)
func maxSubArray(nums []int) int {
	maxSum, currSum := nums[0], nums[0]
	for i := 1; i < len(nums); i++ {
		if currSum < 0 {
			currSum = nums[i]
		} else {
			currSum += nums[i]
		}
		if currSum > maxSum {
			maxSum = currSum
		}
	}
	return maxSum
}

// Q12: Valid Parentheses
func isValid(s string) bool {
	stack := make([]byte, 0)
	pairs := map[byte]byte{')': '(', ']': '[', '}': '{'}
	for i := 0; i < len(s); i++ {
		if s[i] == '(' || s[i] == '[' || s[i] == '{' {
			stack = append(stack, s[i])
		} else {
			if len(stack) == 0 || stack[len(stack)-1] != pairs[s[i]] {
				return false
			}
			stack = stack[:len(stack)-1]
		}
	}
	return len(stack) == 0
}

// Q13: Implement pow(x, n)
func myPow(x float64, n int) float64 {
	if n < 0 {
		x = 1 / x
		n = -n
	}
	result := 1.0
	for n > 0 {
		if n%2 == 1 {
			result *= x
		}
		x *= x
		n /= 2
	}
	return result
}

// Q14: 3Sum
func threeSum(nums []int) [][]int {
	slices.Sort(nums)
	var result [][]int
	for i := 0; i < len(nums)-2; i++ {
		if i > 0 && nums[i] == nums[i-1] {
			continue
		}
		lo, hi := i+1, len(nums)-1
		for lo < hi {
			sum := nums[i] + nums[lo] + nums[hi]
			if sum == 0 {
				result = append(result, []int{nums[i], nums[lo], nums[hi]})
				for lo < hi && nums[lo] == nums[lo+1] { lo++ }
				for lo < hi && nums[hi] == nums[hi-1] { hi-- }
				lo++; hi--
			} else if sum < 0 {
				lo++
			} else {
				hi--
			}
		}
	}
	return result
}

// Q15: Design a Logger Rate Limiter
type Logger struct {
	timestamps map[string]int
}

func NewLogger() *Logger {
	return &Logger{timestamps: make(map[string]int)}
}

func (l *Logger) ShouldPrintMessage(timestamp int, message string) bool {
	if ts, ok := l.timestamps[message]; ok && timestamp-ts < 10 {
		return false
	}
	l.timestamps[message] = timestamp
	return true
}
```

### Preparation Timeline (6-10 weeks)

| Week | Focus | Daily Hours | Key Activities |
|------|-------|-------------|----------------|
| 1-2 | Coding Foundations | 3h | Medium problems with thorough edge case handling |
| 3-4 | System Design | 3h | Azure-aware cloud patterns. Multi-region design |
| 5-6 | Growth Mindset Stories | 2h | Prepare behavioral stories emphasizing learning |
| 7-8 | Go + Microsoft OSS | 2-3h | Study Dapr, KEDA architectures. Go tooling |
| 9-10 | Mock Interviews | 3-4h | Full loop mocks including AA round simulation |


### Junior → FAANG: Preparing for Microsoft Interviews

Microsoft's interview process is structured around problem-solving, collaboration, and culture fit assessed through behavioral questions. Coding interviews at Microsoft are typically medium-difficulty and include design-as-you-go discussions rather than pure algorithmic problems. Behavioral interviews use a growth mindset lens: Microsoft values learning agility, collaboration, and a willingness to challenge assumptions. Know Microsoft's core products and engineering challenges relevant to the team you are targeting (Azure, Office, Teams, Xbox).

### Senior @ FAANG: Microsoft Senior SWE and Principal Engineer: Growth Mindset at Scale

Microsoft's growth mindset culture, championed since Satya Nadella's tenure began, has reshaped what senior engineering leadership looks like inside the company. At the Principal Engineer level, Microsoft probes for evidence that you have invested in others' growth, changed your own position based on new information, and driven organizational learning through incidents and retrospectives. The Principal Engineer role at Microsoft is explicitly cross-team: the expectation is that you influence the technical direction of multiple teams, produce reusable patterns and guidelines, and represent engineering quality standards in product and planning discussions. Interview stories should reflect this scope. Microsoft also has a strong emphasis on customer impact for its enterprise products, which means senior stories should connect technical decisions to enterprise customer outcomes where possible.

---
