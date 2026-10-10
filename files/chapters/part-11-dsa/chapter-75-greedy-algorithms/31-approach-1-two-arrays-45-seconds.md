## Approach 1: Two Arrays (45 seconds)
"Separate start and end times, sort both. Walk through starts,
tracking concurrent meetings.

Intuition: At any start, either reuse a freed room (if a
meeting ended) or allocate new room."

### Junior → FAANG: Why Two Arrays Work Without Explicit Pairing

The two-array approach is unintuitive at first because you separate starts and ends without keeping track of which start corresponds to which end. The key insight: you do not need to pair them. You only need to know, at any moment, whether a room has been freed before the current meeting starts. Since ends are sorted, the smallest end in the sorted `ends` array is always the "next room to be freed." If that room is freed before the current meeting starts, you reuse it (advance `endPtr`). Otherwise, you open a new room.

Trace through `[[0,30],[5,10],[15,20]]`. Sorting gives starts = [0, 5, 15] and ends = [10, 20, 30], with `rooms = 0` and `endPtr = 0`:

| Start | Compare against `ends[endPtr]` | Action | rooms | endPtr |
|-------|-------------------------------|--------|-------|--------|
| 0     | 0 < 10                        | No room free yet, open one | 1 | 0 |
| 5     | 5 < 10                        | Still nothing freed, open another | 2 | 0 |
| 15    | 15 >= 10                      | The meeting ending at 10 has finished, reuse its room | 2 | 1 |

The answer is 2. Note what happens on the third row: the two branches are exclusive. When a room is freed you reuse it and consume that end time, so `rooms` does not increase. It is tempting to think a start both frees a room and needs one, and to increment anyway. Nothing in this loop ever decrements `rooms`, so a single spurious increment silently inflates the answer forever after. Do this trace on paper before explaining the code.

### Senior @ FAANG: Decoupled Sorting as a Performance Pattern

The two-array approach is not just an interview trick. It is a performance pattern for streaming systems where you need to count concurrent events. In an event processing system, "meetings" are events with start and end timestamps, and "rooms" are concurrent processing threads. The two-array approach gives you the maximum concurrent thread count in a single O(n log n) sort without any heap operations.

In streaming systems, the input is not available all at once. An online variant of this problem uses a sorted data structure (balanced BST or sorted list) to maintain current end times and query the minimum at each arrival. In Go, the `container/heap` package provides this. The staff engineer chooses between the batch two-array approach and the online heap approach based on whether the full interval list is available upfront or arrives in a stream. The design document states this choice explicitly, with a note on the performance tradeoff (batch: O(n log n) sort cost amortized, online: O(log n) per event, no upfront sort cost, suitable for low-latency streaming).

```go
func minMeetingRooms(intervals [][]int) int {
    starts := make([]int, len(intervals))
    ends := make([]int, len(intervals))

    for i, interval := range intervals {
        starts[i] = interval[0]
        ends[i] = interval[1]
    }

    slices.Sort(starts)
    slices.Sort(ends)

    rooms, endPtr := 0, 0
    for i := 0; i < len(starts); i++ {
        if starts[i] < ends[endPtr] {
            rooms++
        } else {
            endPtr++
        }
    }
    return rooms
}
```
