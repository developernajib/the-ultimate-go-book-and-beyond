## Deep Dive: Best Available Seat Selection

When users request "best available" instead of choosing specific seats, the system needs an algorithm to pick the optimal group of adjacent seats. This implementation scores each seat based on proximity to the center of the row (center seats are preferred) and row position (closer rows score higher), then finds the highest-scoring group of N contiguous seats. The algorithm groups available seats by row, checks for adjacency, and returns the best cluster. This matters because splitting a group across rows creates a poor fan experience.

```go
package ticket

import (
	"math"
	"sort"
)

type SeatScore struct {
	SeatID     string
	Section    string
	Row        string
	Number     int
	PriceCents int64
	Score      float64
}

// scoreSeat: center of row > aisle > edges, front rows > back
func scoreSeat(seat SeatScore) float64 {
	score := 100.0
	// Row: lower = better (A = best). Rows are labeled, not numbered, and a
	// venue with more than 26 rows labels them AA, AB, and so on, so an
	// unlabeled or multi-character row must not index blindly into Row[0].
	if len(seat.Row) > 0 {
		rowNum := int(seat.Row[0]) - int('A')
		score -= float64(rowNum) * 2.0
	}
	// Center: middle seats best (assuming 30 per row)
	centerDist := math.Abs(float64(seat.Number) - 15.0)
	score -= centerDist * 1.5
	// Aisle bonus
	if seat.Number == 1 || seat.Number == 30 {
		score += 3.0
	}
	return score
}

// findContiguousGroup finds highest-scoring group of N adjacent seats.
func findContiguousGroup(seats []SeatScore, n int) []SeatScore {
	if n <= 0 || len(seats) < n {
		return nil
	}

	byRow := make(map[string][]SeatScore)
	for _, s := range seats {
		// Score here rather than trusting the caller to have done it. Reading
		// a Score that nothing ever writes leaves every seat at 0.0, every
		// group tied, and "best available" quietly returning whichever group
		// happened to be looked at first.
		s.Score = scoreSeat(s)
		key := s.Section + "-" + s.Row
		byRow[key] = append(byRow[key], s)
	}

	// Iterate rows in a fixed order. Ranging a map directly makes the winner
	// among equally scored groups depend on Go's randomized map order, so the
	// same request returns different seats on each call.
	rowKeys := make([]string, 0, len(byRow))
	for k := range byRow {
		rowKeys = append(rowKeys, k)
	}
	sort.Strings(rowKeys)

	bestScore := math.Inf(-1)
	var bestGroup []SeatScore

	for _, key := range rowKeys {
		rowSeats := byRow[key]
		sort.Slice(rowSeats, func(i, j int) bool {
			return rowSeats[i].Number < rowSeats[j].Number
		})

		for i := 0; i <= len(rowSeats)-n; i++ {
			contiguous := true
			for j := 1; j < n; j++ {
				if rowSeats[i+j].Number != rowSeats[i+j-1].Number+1 {
					contiguous = false
					break
				}
			}
			if !contiguous {
				continue
			}

			groupScore := 0.0
			for j := 0; j < n; j++ {
				groupScore += rowSeats[i+j].Score
			}
			groupScore /= float64(n)

			if groupScore > bestScore {
				bestScore = groupScore
				bestGroup = make([]SeatScore, n)
				copy(bestGroup, rowSeats[i:i+n])
			}
		}
	}
	return bestGroup
}
```

---
