## 73.6 Decision Making DP

### Best Time to Buy and Sell Stock

Stock trading problems represent decision-making DP where the state encodes past choices (whether you currently hold a stock, how many transactions remain). The single-transaction variant simplifies to tracking the running minimum price and maximum gap, while multi-transaction variants require explicit state machines tracking hold/not-hold across days.

```go
// MaxProfit with one transaction
// LeetCode 121: Best Time to Buy and Sell Stock
func MaxProfit(prices []int) int {
    if len(prices) == 0 {
        return 0
    }

    minPrice := prices[0]
    maxProfit := 0

    for _, price := range prices {
        minPrice = min(minPrice, price)
        maxProfit = max(maxProfit, price-minPrice)
    }

    return maxProfit
}

// MaxProfitUnlimited with unlimited transactions
// LeetCode 122: Best Time to Buy and Sell Stock II
func MaxProfitUnlimited(prices []int) int {
    profit := 0
    for i := 1; i < len(prices); i++ {
        if prices[i] > prices[i-1] {
            profit += prices[i] - prices[i-1]
        }
    }
    return profit
}

// MaxProfitWithCooldown with cooldown
// LeetCode 309: Best Time to Buy and Sell Stock with Cooldown
func MaxProfitWithCooldown(prices []int) int {
    if len(prices) < 2 {
        return 0
    }

    // States: hold, sold, rest
    hold := -prices[0]
    sold := 0
    rest := 0

    for i := 1; i < len(prices); i++ {
        prevHold := hold
        prevSold := sold
        prevRest := rest

        hold = max(prevHold, prevRest-prices[i])
        sold = prevHold + prices[i]
        rest = max(prevRest, prevSold)
    }

    return max(sold, rest)
}

// MaxProfitWithFee with transaction fee
// LeetCode 714: Best Time to Buy and Sell Stock with Transaction Fee
// Time: O(n), Space: O(1)
func MaxProfitWithFee(prices []int, fee int) int {
    if len(prices) == 0 {
        return 0
    }

    cash := 0          // max profit if not holding
    hold := -prices[0] // max profit if holding

    // Note: the second line reads the cash just updated by the first, which
    // permits a same-day sell-then-rebuy. That is harmless rather than a bug:
    // selling and rebuying at one price costs the fee and gains nothing, so it
    // can never beat holding, and the max never selects it.
    for i := 1; i < len(prices); i++ {
        cash = max(cash, hold+prices[i]-fee)
        hold = max(hold, cash-prices[i])
    }

    return cash
}

// MaxProfitKTransactions with at most K transactions
// LeetCode 188: Best Time to Buy and Sell Stock IV
func MaxProfitKTransactions(k int, prices []int) int {
    n := len(prices)
    if n == 0 || k == 0 {
        return 0
    }

    // If k >= n/2, unlimited transactions
    if k >= n/2 {
        return MaxProfitUnlimited(prices)
    }

    // dp[t][i] = max profit using at most t transactions up to day i
    dp := make([][]int, k+1)
    for t := range dp {
        dp[t] = make([]int, n)
    }

    for t := 1; t <= k; t++ {
        maxDiff := -prices[0]
        for i := 1; i < n; i++ {
            dp[t][i] = max(dp[t][i-1], prices[i]+maxDiff)
            maxDiff = max(maxDiff, dp[t-1][i]-prices[i])
        }
    }

    return dp[k][n-1]
}
```

### Junior → FAANG: Stock Problems as State Machine DP

The stock problem family is a state machine in disguise. At each day, you are in one of a finite number of states (holding, not holding, cooling down, etc.), and the transitions between states carry a reward or cost. Recognizing this pattern unlocks all variants of the problem with minimal additional thought.

For interviews, the mental model to carry is: "define the states, define the transitions, write the state update equations." For the cooldown variant, the three states (hold, sold, rest) and their transition rules can be written as six lines of code once the state machine is clear. The difficulty is in the state design, not the implementation.

The k-transaction variant (LeetCode 188) adds the transaction count as a state dimension. When `k >= n/2`, any day can be a profitable transaction day, so the unlimited variant applies. For small `k`, the 2D table `dp[t][i]` over transactions and days fills in O(k*n) time. Explaining why `maxDiff = max(maxDiff, dp[t-1][i] - prices[i])` is tracked separately (it represents the best buy point considering all previous transaction counts) is the part that distinguishes candidates who understand the algorithm from those who memorized it.

### Senior @ FAANG: Decision-Making DP in Financial and Resource Systems

The stock trading DP family directly models financial systems and resource allocation with cooldown or transition costs. In production recommendation systems, the "cooldown" pattern appears as a constraint that the same recommendation cannot be shown to a user within a time window. In bandwidth allocation, the "k transactions" pattern models the maximum number of configuration changes allowed in a billing period.

The state machine formulation has a governance advantage: each state and each transition can be independently audited, logged, and tested. When a regulatory or compliance requirement changes (e.g., "a transaction can only be initiated if the account has been idle for 3 days"), the change maps to a specific transition rule in the state machine, making the audit trail clear. Contrast this with ad-hoc conditional logic, where the same constraint is scattered across multiple code paths.

A staff-level design concern: the k-transaction DP has O(k*n) time and space, which is acceptable for small k. But if k grows with the dataset (e.g., k is proportional to n), the complexity becomes O(n^2). Where n (the number of price ticks) is in the millions, this is unacceptable. The `k >= n/2` threshold in the code above is the first mitigation: past that point no additional transaction can pay for itself, so the problem collapses to the greedy unlimited solution in O(n).

Be precise about what that threshold does and does not buy, because it is easy to over-claim. It rescues the large-k regime only. It does nothing for k just below n/2, which still fills a table of k*n = O(n^2) cells and is the actual worst case. The threshold converts "unbounded k is quadratic" into "k near n/2 is quadratic," which is a real win when k is a small business constant such as 2 or 5, and no win at all when k genuinely scales with n. If your k scales, the honest answer is that this recurrence is the wrong tool and you need a different formulation, not a tighter constant.

### Junior → FAANG: State Machine DP as a Reliable Interview Framework

The stock problem family is one of the most commonly tested decision-making DP categories at FAANG phone screens. The reliable approach is to always start by naming the states. For the cooldown problem, the states are hold (you own a stock), sold (you just sold, in cooldown), and rest (you do not own a stock and are not in cooldown). Write these three states and their transitions as a table before coding. "From hold: you can stay hold or sell to go to sold. From sold: you must go to rest. From rest: you can stay rest or buy to go to hold." This table is the recurrence, and the code is a direct translation of it.

For the k-transaction problem, the additional dimension is the number of transactions completed. Explain the `maxDiff = max(maxDiff, dp[t-1][i] - prices[i])` line verbally before writing it: "I track the maximum profit from all previous transaction counts up to t-1, minus the current price, which represents the best possible cost basis for a new buy on day i given that I've completed at most t-1 transactions before." If you can narrate that in one sentence, you understand it. If you cannot, trace through a 3-day example with k=2 until you can.

### Senior @ FAANG: State Machine Formalism in Regulated Systems

The state machine formulation of decision-making DP has a concrete advantage in regulated industries: every state and transition can be mapped to a business rule that a compliance team can review and approve independently. In financial systems, the transitions "from hold: sell only if price exceeds cost basis plus minimum margin" are compliance requirements, not just algorithmic optimizations. Encoding them as explicit state machine transitions makes the audit trail unambiguous.

Production state machine DP systems should include transition logging: each time the system makes a state transition (buys, sells, enters cooldown), it logs the state, the trigger event, and the decision. This log is the audit trail for regulatory review and also the data source for backtesting alternative strategies. Staff engineers design this logging layer as part of the initial architecture, not as a retrofit after compliance review flags the absence of an audit trail. The performance overhead of logging (typically one write per time step) is negligible compared to the compliance risk of omission.
