## Exercises

### Exercise 1: First Unique Character
Find the first non-repeating character in a string.

### Exercise 2: Isomorphic Strings
Check if two strings are isomorphic (characters can be mapped 1-to-1).

### Exercise 3: Word Pattern
Check if a pattern matches a string of words (e.g., "abba" matches "dog cat cat dog").

### Exercise 4: Find All Anagrams in a String
Find all start indices of anagrams of p in s.

### Junior -> FAANG: Treating Exercises as Timed Drills

Work each exercise under interview conditions: start a timer for 15 minutes, write the solution without reference, and then measure correctness and style. First Unique Character (LC 387) should take 5 minutes with the two-pass frequency count. Isomorphic Strings (LC 205) requires two maps for bidirectional character mapping, a detail that many candidates miss on the first attempt. Word Pattern (LC 290) is structurally identical to isomorphic strings but with words as the mapped unit. Find All Anagrams (LC 438) combines a sliding window with a character frequency map, which is the canonical "sliding window + hash map" template used in longest-substring-without-repeating-characters and minimum-window-substring as well.

After solving each problem, answer these questions before moving on: What is the time complexity? What is the space complexity? Could I solve it with less space? What edge cases would break my current solution?

### Senior @ FAANG: Exercise Patterns as Code Review Signals

These four exercises are also useful as code review benchmarks. When reviewing a junior engineer's PR that involves a frequency-counting pattern, look for: correct use of the two-value map lookup to distinguish absent keys from zero values, appropriate use of `map[rune]int` vs `[26]int` array (the array is faster and more appropriate when the alphabet is fixed), and whether the solution handles empty string inputs without special-casing them (the loops should naturally handle empty inputs if the logic is correct).

The isomorphic strings problem is a proxy for correctness discipline. An engineer who implements only the `sToT` mapping but forgets the `tToS` mapping for bijectivity is applying incomplete invariant checking, a pattern that appears in production code as "I checked the happy path but not the inverse." Noticing this class of missing check in code review is a senior-level skill.
