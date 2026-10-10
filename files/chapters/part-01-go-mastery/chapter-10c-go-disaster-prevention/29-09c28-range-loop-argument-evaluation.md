## 10C.28 Range Loop Argument Evaluation

The expression in a `for range` statement is evaluated **exactly once**, before the loop begins. This means modifying the collection during iteration may not have the effect you expect.

### The Disaster

The `range` expression is evaluated once when the loop begins, capturing the slice header's length at that moment. Appending during iteration creates a new backing array and updates `nums`, but the loop still iterates over the original three elements. Code that expects newly appended items to be visited will silently skip them.

```go
package main

import "fmt"

func main() {
    // === TRAP 1: Appending during range does NOT extend the loop ===
    // The range expression (the slice header) is evaluated ONCE at the start.
    // The loop's bound comes from that snapshot's len, and reassigning the
    // variable afterwards cannot reach back and change it.

    nums := []int{1, 2, 3}
    for _, v := range nums {
        if v == 2 {
            nums = append(nums, 99) // this DOES update nums, but not the loop
        }
        fmt.Print(v, " ")
    }
    fmt.Println()
    // Output: 1 2 3
    // Three iterations, not four. The range captured len=3 at entry.
    // Note this is a mercy, not a limitation: a loop whose bound could grow
    // from inside the body is a loop that can never terminate.

    fmt.Println("nums after loop:", nums) // [1 2 3 99]

    // === TRAP 2: modifying elements by index DOES affect the loop ===
    // The snapshot copies the slice HEADER, not the array. The pointer in
    // that header still aims at the same memory, so writes through s[i] are
    // visible to iterations that have not happened yet. Length is frozen,
    // contents are not.

    values := []int{10, 20, 30}
    for i := range values {
        values[i] *= 2
    }
    fmt.Println("values:", values) // [20 40 60]

    // The half of this that surprises people: writing ahead of the cursor
    // changes what later iterations read.
    live := []int{1, 2, 3}
    for i, v := range live {
        if i == 0 {
            live[2] = 99 // reached before the loop gets there
        }
        fmt.Print(v, " ")
    }
    fmt.Println() // 1 2 99, not 1 2 3

    // === TRAP 3: Range over an array copies the ENTIRE array ===
    // For arrays (not slices), range copies the whole array at the start.

    // An array is a value, so evaluating the range expression copies all of
    // it. This is the one case where writes are NOT visible to the loop,
    // and it is why the same code behaves differently for [3]int and []int.

    arr := [3]int{1, 2, 3}
    for i, v := range arr { // ranges over a copy of arr
        arr[0] = 999
        fmt.Printf("i=%d v=%d arr[0]=%d\n", i, v, arr[0])
    }
    // Output:
    // i=0 v=1 arr[0]=999   ← v=1 (from the copy), arr[0]=999 (modified original)
    // i=1 v=2 arr[0]=999   ← v=2 (from the copy, not the modified original)
    // i=2 v=3 arr[0]=999

    // FIX for arrays: range over a slice of it, or a pointer to it.
    // arr2[:] yields a header pointing at arr2's storage, so there is no
    // copy and writes land where you expect.
    arr2 := [3]int{1, 2, 3}
    for i, v := range arr2[:] {
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
```

### The Fix: Understand What "Evaluated Once" Means

When you need to process a dynamically growing collection, use a traditional `for` loop with an explicit length check instead of `range`. For in-place modifications during iteration, use the index form `for i := range s` and modify through `s[i]`.

```go
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
            scores[i] = 80 // writes through to the original
        }
    }
    fmt.Println(scores) // [85 92 80 96]
}
```

**The Rule:** The `for range` expression is a snapshot taken at loop entry. Appending to the slice will not extend iteration, but modifying existing elements by index will be visible. For arrays, range copies the entire array.

---
