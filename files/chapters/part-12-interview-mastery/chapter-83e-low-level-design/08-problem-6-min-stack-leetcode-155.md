## 83E.8 Problem 6: Min Stack (LeetCode 155)

### Requirements

1. Push, Pop, Top, GetMin - all in O(1)
2. GetMin returns the minimum element in the stack

### Implementation

The min stack problem (LeetCode 155) requires maintaining a secondary stack that tracks the running minimum, enabling O(1) `getMin` without scanning the entire stack. The following Go implementation demonstrates the auxiliary stack approach and the edge case where duplicate minimum values must be handled correctly.

```go
package minstack

type MinStack struct {
	stack    []int
	minStack []int // parallel stack tracking minimums
}

func Constructor() MinStack {
	return MinStack{}
}

func (ms *MinStack) Push(val int) {
	ms.stack = append(ms.stack, val)
	if len(ms.minStack) == 0 || val <= ms.minStack[len(ms.minStack)-1] {
		ms.minStack = append(ms.minStack, val)
	}
}

func (ms *MinStack) Pop() {
	if len(ms.stack) == 0 {
		return
	}
	top := ms.stack[len(ms.stack)-1]
	ms.stack = ms.stack[:len(ms.stack)-1]
	if top == ms.minStack[len(ms.minStack)-1] {
		ms.minStack = ms.minStack[:len(ms.minStack)-1]
	}
}

func (ms *MinStack) Top() int {
	return ms.stack[len(ms.stack)-1]
}

func (ms *MinStack) GetMin() int {
	return ms.minStack[len(ms.minStack)-1]
}
```

**Complexity:** O(1) for all operations. O(n) space.

**Key insight:** Maintain a second stack that only pushes when the new value is <= the current minimum. When we pop, we also pop from the min stack if the popped value equals the current minimum.

### Alternative: Single Stack with Encoding

The min stack problem (LeetCode 155) requires maintaining a secondary stack that tracks the running minimum, enabling O(1) `getMin` without scanning the entire stack. The following Go implementation demonstrates the auxiliary stack approach and the edge case where duplicate minimum values must be handled correctly.

```go
package minstack

type MinStackEncoded struct {
	stack  []int64
	minVal int64
}

func ConstructorEncoded() MinStackEncoded {
	return MinStackEncoded{}
}

func (ms *MinStackEncoded) Push(val int) {
	v := int64(val)
	if len(ms.stack) == 0 {
		ms.stack = append(ms.stack, 0)
		ms.minVal = v
		return
	}
	ms.stack = append(ms.stack, v-ms.minVal)
	if v < ms.minVal {
		ms.minVal = v
	}
}

func (ms *MinStackEncoded) Pop() {
	top := ms.stack[len(ms.stack)-1]
	ms.stack = ms.stack[:len(ms.stack)-1]
	if top < 0 {
		ms.minVal = ms.minVal - top // restore previous min
	}
}

func (ms *MinStackEncoded) Top() int {
	top := ms.stack[len(ms.stack)-1]
	if top < 0 {
		return int(ms.minVal) // top was the min when pushed
	}
	return int(ms.minVal + top)
}

func (ms *MinStackEncoded) GetMin() int {
	return int(ms.minVal)
}
```

This uses O(1) extra space (no separate min stack) by storing the difference from the minimum.


### Junior → FAANG: Min Stack LLD Basics

The Min Stack (LeetCode 155) requires O(1) push, pop, top, and getMin operations. The insight: maintain two stacks, one for the actual elements and one for the minimum values. When pushing a value, push to the main stack. Also push to the min stack if the value is less than or equal to the current minimum. When popping, pop from the main stack. If the popped value equals the current minimum, also pop from the min stack. In Go, this is two slices used as stacks, encapsulated in a struct with the required methods.

### Senior @ FAANG: Min Stack at the Senior Bar: Interface Design and Embedded Validation

At the senior level, the Min Stack LLD discussion extends to interface design: should the MinStack satisfy the standard stack interface, or should it define its own interface that includes GetMin? The correct answer is to define a MinStack interface that extends a Stack interface using Go's interface embedding, which makes the extended capability explicit without requiring callers who only need Stack behavior to depend on the MinStack capability. Senior candidates should also discuss pop-from-empty-stack handling: the standard implementation panics, but a production implementation should return an error or use the 'ok' idiom (value, ok = stack.Pop()). This is a practical engineering quality concern that separates candidates who write code-review-quality code from those who write competition-quality code.

---
