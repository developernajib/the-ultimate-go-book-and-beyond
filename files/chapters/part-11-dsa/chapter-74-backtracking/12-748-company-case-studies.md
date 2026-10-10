## 74.10 Company Case Studies

### Interview Classic: Sudoku Solver

Sudoku solving is a classic constraint satisfaction problem where backtracking shines: place a digit, check the three overlapping constraints (row, column, 3×3 box), and undo the placement the moment any is violated. The `isValid` check below folds all three into a single loop, mapping the linear index `i` onto box coordinates via `i/3` and `i%3` so that one pass covers the row, the column, and the box.

Be honest about what that costs. This version *scans the board*: nine cells per constraint, on every candidate digit, at every cell. It is a constant, so O(1) in the formal sense, but the constant is real work and it is repeated across the whole search. The genuinely O(1) design is the one described later in this file: keep three sets (or bitmasks) of digits already used per row, per column, and per box, test membership on placement, and flip the bits on the way down and back up. The scanning version is here because it is short and self-evidently correct. Know that the set version is the upgrade, and know that the two are not the same thing.

```go
// Constraint propagation with backtracking
func solveSudoku(board [][]byte) {
    solve(board)
}

func solve(board [][]byte) bool {
    for i := 0; i < 9; i++ {
        for j := 0; j < 9; j++ {
            if board[i][j] == '.' {
                for c := byte('1'); c <= '9'; c++ {
                    if isValid(board, i, j, c) {
                        board[i][j] = c
                        if solve(board) {
                            return true
                        }
                        board[i][j] = '.'  // Backtrack
                    }
                }
                return false
            }
        }
    }
    return true
}

func isValid(board [][]byte, row, col int, c byte) bool {
    boxRow, boxCol := (row/3)*3, (col/3)*3
    for i := 0; i < 9; i++ {
        if board[row][i] == c || board[i][col] == c ||
           board[boxRow+i/3][boxCol+i%3] == c {
            return false
        }
    }
    return true
}
```

### E-Commerce: Product Bundle Combinations

Bundle recommendation reduces to a subset-sum search: find all product combinations whose total price exactly exhausts a given budget. Backtracking suits it because `remaining` is a running budget constraint, and once a product's price exceeds what is left, that product and its whole subtree are skipped rather than enumerated. That is the difference between this and blindly walking all 2^n subsets.

One caveat on "exactly exhausts", since it is the part that makes this a toy: requiring the total to land on the budget precisely is an unusual product requirement, and most real bundle systems want a range. The generalization is in the senior section below.

```go
// Shopping cart bundle combinations
func findBundleCombinations(products []Product, budget int) [][]Product {
    var results [][]Product
    var current []Product

    var backtrack func(start int, remaining int)
    backtrack = func(start int, remaining int) {
        if remaining <= 0 {
            if remaining == 0 {
                combo := make([]Product, len(current))
                copy(combo, current)
                results = append(results, combo)
            }
            return
        }

        for i := start; i < len(products); i++ {
            if products[i].Price <= remaining {
                current = append(current, products[i])
                backtrack(i+1, remaining-products[i].Price)
                current = current[:len(current)-1]
            }
        }
    }

    backtrack(0, budget)
    return results
}

type Product struct {
    Name  string
    Price int
}
```

### Junior → FAANG: Learning from Case Studies

The Sudoku case study sets up the constraint-checking optimization rather than showing it: the `isValid` above rescans nine cells three times for every candidate digit. Maintaining three sets of used values (one per row, one per column, one per box), testing membership on placement and updating them in the choose/unchoose steps, replaces that scan with a lookup. It is the upgrade that distinguishes a passing solution from an impressive one, and it is worth being able to write both and explain why you would start with the scan.

The bundle combinations case shows how a business problem maps to a backtracking algorithm: a budget constraint maps to the `remaining` parameter, product prices map to "weights," and the subset of products maps to the "path." Practicing this kind of problem mapping (business framing to algorithm framing) is essential for success in behavioral and system design interviews where you must connect your algorithmic knowledge to real product contexts.

Note that the pruning `if products[i].Price <= remaining` is not sorted-based, meaning it does not use `break`. If the products are sorted by price ascending, you can use `break` instead of `continue` when the price exceeds the remaining budget, cutting the inner loop short. Mentioning this optimization is a positive signal in an interview.

### Senior @ FAANG: Case Studies as Platform Architecture Templates

The Sudoku solver points at a pattern that appears broadly in production constraint systems: separate the constraint representation from the search logic. Once row, column, and box occupancy live behind a validity query, the search logic no longer knows or cares how they are stored, and swapping the board scan for bitmasks becomes a local change rather than a rewrite. That separation makes the system extensible: adding a new constraint type (e.g., a diagonal constraint for a variant of Sudoku) requires only adding a new precomputed structure and a new check in the validity method, without touching the search logic.

The bundle combinations case illustrates the general "knapsack with enumeration" pattern that appears in e-commerce (bundle pricing), logistics (package combination to fill a shipment), and ad auction (which ad combinations fit within a display slot budget). The production extension from the case study is: instead of finding all combinations that exactly exhaust the budget, find all combinations whose total price falls within [budget_min, budget_max], a slight generalization that requires adjusting the base case condition from `remaining == 0` to `budget_min <= total <= budget_max`.

At the platform level, both case studies represent systems that must handle concurrent requests. A Sudoku solver service receiving thousands of requests per second must ensure that the board data structure is not shared between request goroutines (each request gets its own board copy). A combination generator handling many concurrent sessions must ensure the backtracking state (current path, results list) is goroutine-local: the closure-captured `current` and `results` in the code above are shared by every call in one search, so two searches must never share them. These are not algorithm concerns. They are platform concurrency concerns that staff engineers must address before deploying backtracking-based services.

### Junior → FAANG: Using Case Studies to Prepare Behavioral Answers

The two case studies (Sudoku solver, product bundle combinations) are templates for behavioral interview answers about algorithmic problem-solving. Practice narrating the bundle case as a "tell me about a time you solved a business problem with an algorithm" story: "I needed to find all product bundles matching a given budget. I recognized it as a combination sum: products are candidates, prices are weights, the budget is the target. I implemented backtracking with budget-based pruning, so once a product's price exceeded the remaining budget that whole subtree was skipped instead of enumerated. I measured the recursive call count before and after to confirm the pruning was doing the work I thought it was."

Note the last sentence, and prefer it to a number you cannot defend. Claiming a specific speedup you never measured is the fastest way to lose an interviewer, because the obvious follow-up is "how did you measure that?" Saying you instrumented the call count is both more credible and more useful.

The sorting detail is worth including: "I sorted products by price first, which upgraded the skip into an early exit: once the current price exceeds the remaining budget, every later product does too, so I break out of the loop instead of testing each one. That break is only valid because of the sort, which is the part worth stating out loud."

### Senior @ FAANG: Case Studies as Platform Pattern Templates

The set-based Sudoku constraint representation (one structure per constraint type) is a specific instance of a general pattern: maintain one data structure per constraint type, each supporting O(1) validity check and, just as importantly, O(1) update *and rollback*. The rollback half is what makes it usable from a backtracking search at all, and it is why bitmasks fit so well here: setting and clearing a bit are exact inverses. This pattern applies to any CSP: for job scheduling, the constraint types are machine capacity, time window, and dependency. For configuration validation, the constraint types are option compatibility, resource limits, and dependency requirements.

The bundle combinations case illustrates the general "constrained enumeration as a service" pattern: recommendation engines that enumerate valid product bundles, advertising systems that enumerate valid ad combinations for a slot, and routing engines that enumerate valid delivery routes satisfying time and capacity constraints. The common architecture is: pre-filter the candidate set to reduce n, run backtracking with domain-specific pruning, apply a result limit (return at most k results), and serve from a cache keyed on the request parameters. Staff engineers who recognize this pattern can reuse the same architectural template across different product domains.

---
