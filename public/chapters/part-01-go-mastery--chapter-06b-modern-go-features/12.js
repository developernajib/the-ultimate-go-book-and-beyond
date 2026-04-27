export default `## Section 9: Min/Max Builtins and Slices/Maps Packages

### 9.1 Built-in min/max (Go 1.21+)

The built-in \`min\` and \`max\` functions introduced in Go 1.21 accept any ordered type and any number of arguments, replacing verbose conditional expressions for finding extrema.

\`\`\`go
package builtins

import (
	"cmp"
	"slices"
	"maps"
)

func MinMaxExamples() {
	// Built-in min/max - no more math.Min/Max with float64 conversion
	a, b := 5, 3
	smaller := min(a, b)   // 3
	larger := max(a, b)    // 5
	_ = smaller
	_ = larger

	// Works with any ordered type
	s1, s2 := "apple", "banana"
	_ = min(s1, s2) // "apple"

	// Multi-argument
	_ = max(1, 2, 3, 4, 5) // 5
}

func SlicesExamples() {
	// slices.Sort - generic, no interface boxing
	nums := []int{5, 2, 8, 1, 9, 3}
	slices.Sort(nums)

	// slices.SortFunc - custom comparator
	type Person struct{ Name string; Age int }
	people := []Person{{"Alice", 30}, {"Bob", 25}, {"Charlie", 35}}
	slices.SortFunc(people, func(a, b Person) int {
		return cmp.Compare(a.Age, b.Age)
	})

	// slices.BinarySearch - on sorted slices
	idx, found := slices.BinarySearch(nums, 5)
	_, _ = idx, found

	// slices.Contains, slices.Index
	_ = slices.Contains(nums, 8)
	_ = slices.Index(nums, 8)

	// slices.Compact - remove consecutive duplicates
	dupes := []int{1, 1, 2, 3, 3, 3, 4}
	_ = slices.Compact(dupes) // [1, 2, 3, 4]

	// slices.Reverse, slices.Clone
	_ = slices.Clone(nums)
	slices.Reverse(nums)

	// slices.Chunk (Go 1.23+)
	for chunk := range slices.Chunk(nums, 3) {
		_ = chunk // process chunk of 3
	}
}

func MapsExamples() {
	m := map[string]int{"a": 1, "b": 2, "c": 3}

	// maps.Keys, maps.Values
	keys := slices.Collect(maps.Keys(m))     // returns iter.Seq[K]
	vals := slices.Collect(maps.Values(m))   // returns iter.Seq[V]
	_, _ = keys, vals

	// maps.Clone - shallow copy
	clone := maps.Clone(m)
	_ = clone

	// maps.Copy - merge maps
	dst := map[string]int{"x": 10}
	maps.Copy(dst, m) // dst now has x, a, b, c

	// maps.DeleteFunc - delete matching entries
	maps.DeleteFunc(m, func(k string, v int) bool {
		return v < 2
	})

	// maps.Equal - compare maps
	_ = maps.Equal(m, clone)
}
\`\`\`

### Adoption Story

\`slices\`, \`maps\`, \`cmp\`, \`min\`, \`max\`, and \`clear\` are the daily-driver additions from Go 1.21. Every new Go codebase uses them. Every old codebase should migrate to them. The migration is mechanical:

- Replace \`sort.Slice(s, less)\` with \`slices.SortFunc(s, cmp)\`.
- Replace \`sort.Ints(s)\` with \`slices.Sort(s)\`.
- Replace hand-rolled \`min\`/\`max\` helpers with the builtins.
- Replace "collect keys then sort" with \`slices.Sorted(maps.Keys(m))\`.
- Replace "loop and clear" with \`clear(m)\` for maps or \`clear(s)\` for slices.

The test is the grep: if your codebase still has \`func Min(a, b int) int\`, it is overdue for migration. This is one of the easiest code-cleanup wins available.

### Code-Review Lens (Senior Track)

Two patterns to flag:

1. **A hand-rolled helper that duplicates a \`slices\` or \`maps\` function.** Always replaceable. File the refactor.
2. **Use of \`sort.Slice\` in new code.** Replace with \`slices.SortFunc\`. Type-safe, faster, and the idiom the team will standardise on.

### Migration Lens

The closest analogues are Java's \`java.util.Collections\` plus \`Stream\`, Python's \`sorted\`, \`min\`, \`max\` builtins plus \`collections\`, and Rust's \`slice\` methods. Go's \`slices\` package is deliberately smaller than Java's \`Stream\` but covers the common cases that every team was hand-rolling before 1.21.

---
`;
