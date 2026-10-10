## 73.10 Company Case Studies

### Netflix: Video Compression Optimization

This one is grounded in public engineering: Netflix's published dynamic-optimizer work frames per-shot video encoding as exactly this optimization, choose an encode level per segment to maximize perceptual quality under a bitrate budget. Here is the DP shape of that problem:

```go
// Netflix-style video encoding optimization
package video

// OptimalBitrateAllocation finds best bitrate distribution across video segments
// to maximize quality within a bandwidth budget.
//
// Simplifying assumption: a level's index IS its cost, so level 2 costs 2 budget
// units. That keeps the recurrence readable. A real encoder carries an explicit
// costs[segment][level] table and indexes dp[i-1][b-costs[i][level]] instead.
// Level 0 costing 0 is what makes every state reachable.
//
// Time: O(n * budget * levels), Space: O(n * budget)
func OptimalBitrateAllocation(segmentQualities [][]float64, totalBudget int) []int {
    n := len(segmentQualities)
    bitrateLevels := len(segmentQualities[0])

    // dp[i][budget] = max quality for segments 0..i with given budget
    dp := make([][]float64, n)
    choice := make([][]int, n)
    for i := range dp {
        dp[i] = make([]float64, totalBudget+1)
        choice[i] = make([]int, totalBudget+1)
    }

    // Initialize first segment
    for b := 0; b <= totalBudget; b++ {
        for level := 0; level < bitrateLevels && level <= b; level++ {
            if segmentQualities[0][level] > dp[0][b] {
                dp[0][b] = segmentQualities[0][level]
                choice[0][b] = level
            }
        }
    }

    // Fill DP table
    for i := 1; i < n; i++ {
        for b := 0; b <= totalBudget; b++ {
            for level := 0; level < bitrateLevels && level <= b; level++ {
                quality := segmentQualities[i][level] + dp[i-1][b-level]
                if quality > dp[i][b] {
                    dp[i][b] = quality
                    choice[i][b] = level
                }
            }
        }
    }

    // Backtrack to find optimal choices
    allocation := make([]int, n)
    budget := totalBudget
    for i := n - 1; i >= 0; i-- {
        allocation[i] = choice[i][budget]
        budget -= allocation[i]
    }

    return allocation
}
```

### Google: Text Autocomplete with Edit Distance

Edit distance (Levenshtein distance) quantifies how many single-character insertions, deletions, or substitutions are needed to transform one string into another, making it the foundation of spelling correction and fuzzy search in autocomplete systems. Rather than storing the full `m×n` DP table, this implementation uses two rolling rows (`prev` and `curr`) to cut space from O(m·n) to O(n), which matters when scanning large dictionaries at query time. `FindClosestWords` then applies a distance threshold to filter candidates.

Read `FindClosestWords` as an illustration of the recurrence, not as a design. It is a linear scan of the entire dictionary, one full DP per word, which is exactly what no production spell-corrector does. Real systems prune first with something cheap (a prefix or n-gram index, a phonetic key such as Soundex or Metaphone, a BK-tree, or a Levenshtein automaton) and run the full DP only on the survivors. The edit-distance recurrence stays as the exact scoring function at the end of that funnel. It is just never the first filter.

```go
// Google-style autocomplete using edit distance DP
package autocomplete

func MinEditDistance(word1, word2 string) int {
    m, n := len(word1), len(word2)

    // Space-optimized DP
    prev := make([]int, n+1)
    curr := make([]int, n+1)

    for j := 0; j <= n; j++ {
        prev[j] = j
    }

    for i := 1; i <= m; i++ {
        curr[0] = i
        for j := 1; j <= n; j++ {
            if word1[i-1] == word2[j-1] {
                curr[j] = prev[j-1]
            } else {
                curr[j] = 1 + min(prev[j-1], min(prev[j], curr[j-1]))
            }
        }
        prev, curr = curr, prev
    }

    return prev[n]
}

// FindClosestWords returns words within maxDistance
func FindClosestWords(query string, dictionary []string, maxDistance int) []string {
    var results []string
    for _, word := range dictionary {
        if MinEditDistance(query, word) <= maxDistance {
            results = append(results, word)
        }
    }
    return results
}
```

### Junior → FAANG: Reading Case Studies as Interview Preparation

The two case studies above (Netflix bitrate allocation and Google autocomplete) are worth studying as templates for how to connect a DP algorithm to a real business problem. In behavioral interviews ("tell me about a time you solved a hard technical problem") and system design interviews ("design a video streaming service"), being able to describe the knapsack structure of bitrate allocation or the edit-distance foundation of autocomplete demonstrates that you think in algorithms, not just in features.

For autocomplete specifically, understand that the full edit distance computation is the slow, exact path. In a real interview about search infrastructure, follow up by describing the pre-filtering that makes it practical: n-gram overlap, prefix indexing, or phonetic keys (Soundex, Metaphone) to reduce the candidate set before running the DP. Showing awareness of this two-phase approach is a significant differentiator.

For the Netflix case study, trace through `OptimalBitrateAllocation` manually with two segments and three bitrate levels. This 2x3 table traces quickly and reveals how `choice[i][budget]` stores the per-segment decisions that the backtracking step reconstructs. Practicing reconstruction is the part candidates most often skip, but interviewers frequently ask "how would you print the actual solution, not just the optimal value?"

### Senior @ FAANG: Case Studies as Platform Design Inputs

The Netflix bitrate allocation DP is a simplified model of Adaptive Bitrate (ABR) streaming. In production, the "budget" is not a fixed integer but a dynamic estimate of available bandwidth that fluctuates during playback. This turns the static knapsack into an online problem, where decisions must be made in real time with incomplete future information. The offline DP keeps its value even so, as the oracle: because it is allowed to see the whole bandwidth trace in advance, its result is the best any algorithm could have done, and that upper bound is what online ABR algorithms (BOLA, MPC, and learned approaches such as Pensieve) are scored against. The gap between an online algorithm and the offline optimum is the quantity that matters, and you cannot report it without computing the DP. This "compare the online policy to the offline optimum" framing recurs across systems, and it is the same reasoning behind Belady's rule for cache eviction, though the two are different algorithms for different problems.

For the autocomplete case study, the architectural point is that a web-scale system cannot run the edit-distance DP at query time against a full dictionary, and so it does not. The work moves offline: an indexing pipeline precomputes correction candidates into a structure the online path can traverse cheaply (a trie or FST of terms, with a bounded-distance search, is the usual shape), and the request path becomes an index lookup rather than a scan. The DP does not disappear, it relocates to the pipeline that builds the index. The engineering then lives in choosing the maximum edit distance threshold (recall against index size, since candidate counts grow steeply with distance), and in how the index is invalidated as the dictionary evolves with new words and shifting frequency ranks. These are platform-level DP applications where the algorithm's correctness is a precondition but the engineering challenge is in the surrounding infrastructure.

### Junior → FAANG: Reading Case Studies for Interview Storytelling

The two case studies (Netflix bitrate allocation, Google autocomplete) are templates for the behavioral interview question "tell me about a time you used an algorithm to solve a real business problem." If you do not yet have a personal example, adapt one of these: "In a project I studied, adaptive bitrate streaming uses a knapsack-style DP where each video segment is an item with a quality value and a bandwidth cost, and the total bandwidth is the capacity constraint. The DP chooses the bitrate for each segment to maximize total quality within the bandwidth budget." This is a legitimate answer that demonstrates algorithmic depth even without personal production experience.

Practice tracing `OptimalBitrateAllocation` by hand for a tiny example: 2 segments, 3 bitrate levels (costs 0, 1, 2), qualities (1.0, 2.0, 3.0) for segment 1 and (1.5, 2.5, 3.5) for segment 2, total budget 3. Fill the 2x3 DP table and backtrack to find the allocation. This trace makes the algorithm concrete and gives you a specific number to refer to in an interview.

### Senior @ FAANG: Case Studies as Platform ADR Templates

Both case studies illustrate the structure of a platform-level ADR for a DP-based system. The Netflix ADR would include: the state definition (segment index, remaining bandwidth), the recurrence (for each segment, try each bitrate level and accumulate quality), the choice of offline versus online DP (offline because the full segment list is known before playback begins), the space optimization applied (rolling array over segments), and the degradation strategy (if bandwidth estimate is wrong, recompute the allocation online using the last 3 segments' actual bandwidth). Each of these sections answers a question that the next engineer maintaining the system will have.

The autocomplete ADR would include: why edit distance is the similarity metric (it is the standard model for typographic errors), why the computation is offline (a per-keystroke latency budget in the low milliseconds cannot absorb an online DP against a full dictionary), how the maximum distance threshold was chosen (empirical evaluation of correction accuracy versus false positive rate at each threshold), and how the index is invalidated when the dictionary changes (versioned index with background recomputation triggered by dictionary diff). These ADR sections transform a DP algorithm into a maintainable production system.

---
