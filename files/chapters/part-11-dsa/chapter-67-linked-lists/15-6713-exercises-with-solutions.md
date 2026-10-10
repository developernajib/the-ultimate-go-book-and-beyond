## 67.13 Exercises with Solutions

### Exercise 1: Remove Duplicates from Sorted List II

Given a sorted linked list, delete all nodes that have duplicate numbers, leaving only distinct numbers.

```go
// Solution
func deleteDuplicates(head *ListNode) *ListNode {
    dummy := &ListNode{Next: head}
    prev := dummy

    for head != nil {
        // Check if current node is start of duplicates
        if head.Next != nil && head.Val == head.Next.Val {
            // Skip all nodes with this value
            for head.Next != nil && head.Val == head.Next.Val {
                head = head.Next
            }
            // Skip last duplicate
            prev.Next = head.Next
        } else {
            // No duplicate, move prev
            prev = prev.Next
        }
        head = head.Next
    }

    return dummy.Next
}

// Test
func TestDeleteDuplicates(t *testing.T) {
    tests := []struct {
        input    []int
        expected []int
    }{
        {[]int{1, 2, 3, 3, 4, 4, 5}, []int{1, 2, 5}},
        {[]int{1, 1, 1, 2, 3}, []int{2, 3}},
        {[]int{1, 1}, []int{}},
        {[]int{1, 2, 3}, []int{1, 2, 3}},
    }

    for _, tt := range tests {
        head := FromSlice(tt.input)
        result := deleteDuplicates(head)
        got := ToSlice(result)

        if !equal(got, tt.expected) {
            t.Errorf("deleteDuplicates(%v) = %v, want %v", tt.input, got, tt.expected)
        }
    }
}

func ToSlice(head *ListNode) []int {
    var result []int
    for head != nil {
        result = append(result, head.Val)
        head = head.Next
    }
    return result
}

func equal(a, b []int) bool {
    if len(a) != len(b) {
        return false
    }
    for i := range a {
        if a[i] != b[i] {
            return false
        }
    }
    return true
}
```

### Exercise 2: Split Linked List in Parts

Given a linked list and k, split it into k consecutive parts with sizes differing by at most 1.

```go
// Solution
func splitListToParts(head *ListNode, k int) []*ListNode {
    // Find length
    length := 0
    curr := head
    for curr != nil {
        length++
        curr = curr.Next
    }

    // Calculate part sizes
    baseSize := length / k
    extra := length % k  // First 'extra' parts get one more element

    result := make([]*ListNode, k)
    curr = head

    for i := 0; i < k && curr != nil; i++ {
        result[i] = curr
        partSize := baseSize
        if i < extra {
            partSize++
        }

        // Move to end of this part
        for j := 1; j < partSize; j++ {
            curr = curr.Next
        }

        // Cut the connection
        next := curr.Next
        curr.Next = nil
        curr = next
    }

    return result
}

// Test
func TestSplitListToParts(t *testing.T) {
    tests := []struct {
        input    []int
        k        int
        expected [][]int
    }{
        {
            []int{1, 2, 3},
            5,
            [][]int{{1}, {2}, {3}, {}, {}},
        },
        {
            []int{1, 2, 3, 4, 5, 6, 7, 8, 9, 10},
            3,
            [][]int{{1, 2, 3, 4}, {5, 6, 7}, {8, 9, 10}},
        },
    }

    for _, tt := range tests {
        head := FromSlice(tt.input)
        result := splitListToParts(head, tt.k)

        for i, part := range result {
            got := ToSlice(part)
            if !equal(got, tt.expected[i]) {
                t.Errorf("Part %d: got %v, want %v", i, got, tt.expected[i])
            }
        }
    }
}
```

### Junior -> FAANG: Testing Discipline for Exercise Solutions

The solutions in this section are correct but the test coverage is illustrative, not exhaustive. For each exercise, extend the test cases before submitting in an interview or a code review.

**For `deleteDuplicates`:** Add test cases for all duplicates (`[1,1,1]` expected `[]`), no duplicates (`[1,2,3]` expected `[1,2,3]`), duplicates at the end (`[1,2,2]` expected `[1]`), and single element (`[1]` expected `[1]`). The four existing test cases cover the most common patterns but do not cover single element.

**For `splitListToParts`:** Add test cases for k greater than the list length (parts beyond the list length are nil), k equal to one (single part containing the entire list), and an empty list. The two existing tests cover the primary distribution but miss the nil-part case.

**Understanding `equal` and `ToSlice` as test utilities:** These two helper functions are the testing infrastructure for all linked list exercises. Writing them once and reusing them across all tests reduces test boilerplate and makes test failures easier to diagnose because `t.Errorf` prints the full slice representation rather than just a pointer.

**Gotcha in `splitListToParts`:** The loop `for i := 0; i < k && curr != nil; i++` means that if the list has fewer nodes than k, the outer loop terminates when `curr` is nil, leaving nil entries in the remaining result positions. That is the specified behavior, not a bug. Note that `ToSlice(nil)` returns a nil slice, not `[]int{}`, because it starts from `var result []int` and never appends. The tests still pass because `equal` compares lengths first, and `len(nil) == 0`. This is worth understanding rather than "fixing": in Go a nil slice and an empty slice behave identically for `len`, `range`, and `append`, and they differ only under `==` against nil and in JSON encoding, where nil marshals to `null` and `[]int{}` marshals to `[]`. If these parts are ever serialized to an API response, that distinction becomes a real contract difference.

Also note `splitListToParts` divides by `k` without checking it. LeetCode guarantees `k >= 1`, but as written `k == 0` panics with an integer divide by zero rather than returning an empty result.

### Senior @ FAANG: Solution Quality as a Production Signal

**`deleteDuplicates` as a code quality benchmark.** This is the same algorithm as `deleteDuplicatesGood` in the extended common mistakes file, and comparing the two is instructive precisely because they are identical: the interesting contrast is against `deleteDuplicatesBad` in that file, which is correct as well but roughly twice the length because it special-cases head removal instead of using a dummy node. That is the review signal worth naming. Length here is a proxy for how many distinct cases the author had to hold in their head, and the dummy node collapses two of them into one. The invariant that makes this version short is worth stating in a comment: `prev` always points at the last node confirmed to be unique, and `head` scans ahead, so `prev.Next` is only rewired when a duplicate run is skipped.

**`splitListToParts` as an API design exercise.** The return type `[]*ListNode` couples the caller to the linked list representation. If the caller needs a slice of slices (for JSON serialization or further processing), they must convert each part. A production API might return `[][]int` (values only) or accept a callback per part. The decision depends on whether the caller needs to maintain pointer identity to the original nodes (for in-place mutation) or just the values (for read-only processing). Document this in the function's godoc.

**`ToSlice` and `equal` as internal test utilities.** These belong in a `_test.go` file, and that is all the mechanism you need: the go tool compiles `_test.go` files only for the test binary, so they cannot reach a production build. No build tag is involved. Be careful with the folklore here, because `//go:build ignore` does the opposite of what it is often claimed to do: it excludes the file from *every* build, tests included, and a `_test.go` file referencing it fails to compile with "undefined". The tag exists for standalone files run via `go run`, such as generators. If you need helpers shared across several packages' tests, the real options are an exported helper package under `internal/`, or a file named `export_test.go` in the package itself.

**Sizing helpers and allocation failure.** `FromSlice` is called without error checking (`head := FromSlice(tt.input)`) because its signature returns no error, and that is the right design. Do not add an `error` return in the hope of handling out-of-memory gracefully: in Go you cannot. Heap exhaustion is not a `panic` and is not recoverable. The runtime calls `throw`, which prints "fatal error: out of memory" and kills the process with no unwinding, so a deferred `recover` never runs. Return an error for conditions the caller can actually act on, such as a malformed input or a size exceeding a limit you chose to enforce, and let the runtime own genuine OOM. If you need to survive memory pressure, the lever is admission control and bounded structures at the design level, not error returns at the allocation site.

---
