export default `## 10C.28 Range Loop Argument Evaluation

The expression in a \`for range\` statement is evaluated **exactly once**, before the loop begins. This means modifying the collection during iteration may not have the effect you expect.

### The Disaster

The \`range\` expression is evaluated once when the loop begins, capturing the slice header's length at that moment. Appending during iteration creates a new backing array and updates \`nums\`, but the loop still iterates over the original three elements. Code that expects newly appended items to be visited will silently skip them.

\`\`\`go
package main

import "fmt"

func main() {
    // === TRAP 1: Appending during range does NOT extend the loop ===
    // The range expression (the slice header) is evaluated ONCE at the start.
    // Appending creates a new backing array - the loop still uses the original.

    nums := []int{1, 2, 3}
    for _, v := range nums {
        if v == 2 {
            nums = append(nums, 99) // this DOES modify nums, but...
        }
        fmt.Print(v, " ")
    }
    fmt.Println()
    // Output: 1 2 3  - the loop iterated 3 times, NOT 4
    // nums is now [1 2 3 99] but the range already captured len=3

    fmt.Println("nums after loop:", nums) // [1 2 3 99]

    // === TRAP 2: Modifying elements by index DOES affect the loop ===
    // Because the range captures the slice header (pointer, len, cap),
    // and modifying s[i] writes through the same pointer.

    values := []int{10, 20, 30}
    for i := range values {
        values[i] *= 2 // modifying through index - affects the actual data
    }
    fmt.Println("values:", values) // [20 40 60] - modifications visible

    // === TRAP 3: Range over an array copies the ENTIRE array ===
    // For arrays (not slices), range copies the whole array at the start.

    arr := [3]int{1, 2, 3}
    for i, v := range arr { // arr is COPIED - modifications won't be seen
        arr[0] = 999
        fmt.Printf("i=%d v=%d arr[0]=%d\\n", i, v, arr[0])
    }
    // Output:
    // i=0 v=1 arr[0]=999   ← v=1 (from the copy), arr[0]=999 (modified original)
    // i=1 v=2 arr[0]=999   ← v=2 (from the copy, not the modified original)
    // i=2 v=3 arr[0]=999

    // FIX for arrays: range over a pointer or slice of the array
    arr2 := [3]int{1, 2, 3}
    for i, v := range arr2[:] { // range over slice of the array - no copy
        arr2[0] = 999
        _ = i
        _ = v
    }

    // === TRAP 4: Range over a channel evaluates the channel once ===
    // Reassigning the channel variable inside the loop has no effect.

    ch := make(chan int, 3)
    ch <- 1
    ch <- 2
    ch <- 3
    close(ch)

    for v := range ch {
        // ch = nil // even if you nil the variable, the range uses the original channel
        fmt.Print(v, " ")
    }
    fmt.Println() // 1 2 3
}
\`\`\`

### The Fix: Understand What "Evaluated Once" Means

When you need to process a dynamically growing collection, use a traditional \`for\` loop with an explicit length check instead of \`range\`. For in-place modifications during iteration, use the index form \`for i := range s\` and modify through \`s[i]\`.

\`\`\`go
package main

import "fmt"

func main() {
    // If you NEED to process dynamically growing data, use a traditional for loop:
    queue := []int{1, 2, 3}
    for len(queue) > 0 {
        item := queue[0]
        queue = queue[1:]

        if item < 3 {
            queue = append(queue, item+10) // dynamically grow the queue
        }
        fmt.Print(item, " ")
    }
    fmt.Println() // 1 2 3 11 12

    // If you want to modify elements during range, use the index form:
    scores := []int{85, 92, 78, 96}
    for i := range scores {
        if scores[i] < 80 {
            scores[i] = 80 // apply minimum score - modifies original
        }
    }
    fmt.Println(scores) // [85 92 80 96]
}
\`\`\`

**The Rule:** The \`for range\` expression is a snapshot taken at loop entry. Appending to the slice will not extend iteration, but modifying existing elements by index will be visible. For arrays, range copies the entire array.

---
`;
