## 96B.2 Equity Deep Dive

### RSUs vs Stock Options

RSUs and stock options are the two primary forms of equity compensation in tech, and they work very differently. RSUs are shares granted to you that vest over time and have value as long as the stock price is above zero. Stock options give you the right to buy shares at a fixed price, meaning they can be worthless if the stock price falls below the strike price.

```
┌──────────────────────────────────────────────────────────────────┐
│           RSUs (Restricted Stock Units)                          │
├──────────────────────────────────────────────────────────────────┤
│  WHAT: Promise of company shares that vest over time             │
│  VALUE: Current stock price × number of units                    │
│  RISK: Lower - worth something unless stock goes to $0           │
│  TAX: Taxed as ordinary income when vested                       │
│  COMMON AT: Public companies (Google, Meta, Amazon, etc.)        │
│                                                                  │
│  Example: 1000 RSUs at $150/share = $150,000 value               │
│  If stock goes to $200: $200,000 value                           │
│  If stock goes to $50: $50,000 value (still worth something)     │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│           Stock Options (ISO/NSO)                                │
├──────────────────────────────────────────────────────────────────┤
│  WHAT: Right to buy shares at a fixed "strike" price             │
│  VALUE: (Current price - Strike price) × number of options       │
│  RISK: Higher - worthless if stock below strike price            │
│  TAX: Complex - depends on ISO vs NSO, exercise timing           │
│  COMMON AT: Startups and private companies                       │
│                                                                  │
│  Example: 10,000 options at $10 strike                           │
│  If stock at $50: ($50-$10) × 10,000 = $400,000 value            │
│  If stock at $8: $0 value (underwater options)                   │
└──────────────────────────────────────────────────────────────────┘
```

### ISO vs NSO Options

If your offer includes stock options, understanding whether they are ISOs (Incentive Stock Options) or NSOs (Non-Qualified Stock Options) is critical because the tax treatment differs dramatically. ISOs offer a potential tax advantage if you hold the shares long enough, while NSOs are taxed as ordinary income at exercise.

```
INCENTIVE STOCK OPTIONS (ISOs):
├── Only available to employees
├── Tax advantage: No tax at exercise (if held)
├── Must hold 1 year after exercise + 2 years after grant
├── Qualifies for long-term capital gains
├── AMT may apply at exercise
└── $100k limit per year on favorable tax treatment

NON-QUALIFIED STOCK OPTIONS (NSOs):
├── Available to employees, contractors, advisors
├── Taxed as ordinary income at exercise
├── Spread (current price - strike) is W-2 income
├── No holding period requirements
├── No AMT concerns
└── More straightforward but higher tax burden
```

### Evaluating Startup Equity

Equity compensation, RSUs, ISOs, NSOs, creates significant wealth-building opportunity but carries tax complexity and liquidity risk that candidates frequently underestimate. The following analysis explains the key terms, strike price implications, and tax treatment differences that affect the real value of an equity offer.

```
STARTUP EQUITY EVALUATION FRAMEWORK:

1. COMPANY STAGE
   ┌──────────────────────────────────────────────────────────┐
   │ Stage        │ Risk Level │ Typical Equity │ Success %   │
   ├──────────────────────────────────────────────────────────┤
   │ Pre-seed     │ Extreme    │ 0.5-2.0%       │ ~5%         │
   │ Seed         │ Very High  │ 0.1-1.0%       │ ~10%        │
   │ Series A     │ High       │ 0.05-0.5%      │ ~20%        │
   │ Series B     │ Medium     │ 0.02-0.2%      │ ~35%        │
   │ Series C+    │ Lower      │ 0.01-0.1%      │ ~50%        │
   │ Pre-IPO      │ Lowest     │ 0.005-0.05%    │ ~70%        │
   └──────────────────────────────────────────────────────────┘

2. KEY QUESTIONS TO ASK:
   □ What's the current 409A valuation?
   □ What's the strike price of my options?
   □ What's the total share count (fully diluted)?
   □ What percentage do my shares represent?
   □ What's the last funding round valuation?
   □ What's the company's runway (months of cash)?
   □ What are realistic exit scenarios and timelines?
   □ What's the liquidation preference stack?

3. CALCULATE POTENTIAL VALUE:

   Optimistic Exit ($1B):
   Your shares: 10,000
   Total shares: 100,000,000 (fully diluted)
   Your percentage: 0.01%
   Your value: $100,000 (before tax)

   Realistic Exit ($200M):
   Your value: $20,000 (before tax)
   After preferences: Maybe $10,000

   Compare to: $50,000 annual RSU at big tech
```

### The 83(b) Election

An 83(b) election lets you pay taxes on stock at its current (lower) value rather than at vesting when it may be worth much more. This is most relevant for early-stage startup employees who receive restricted stock. The 30-day filing deadline is strict and cannot be extended.

```
83(b) ELECTION EXPLAINED:

WHAT: IRS election to pay tax on stock grant NOW instead of at vesting

WHEN TO USE: Early-stage startup stock with low current value

EXAMPLE:
┌──────────────────────────────────────────────────────────────────┐
│  SCENARIO: 100,000 shares at $0.10/share, 4-year vest            │
│                                                                  │
│  WITHOUT 83(b):                                                  │
│  Year 1: 25,000 shares vest at $1/share = $25,000 income         │
│  Year 2: 25,000 shares vest at $5/share = $125,000 income        │
│  Year 3: 25,000 shares vest at $10/share = $250,000 income       │
│  Year 4: 25,000 shares vest at $20/share = $500,000 income       │
│  TOTAL ORDINARY INCOME: $900,000 (taxed at ~45%)                 │
│                                                                  │
│  WITH 83(b):                                                     │
│  Day 1: Pay tax on $10,000 (100k shares × $0.10)                 │
│  Tax owed: ~$4,500                                               │
│  At exit: All gains taxed as long-term capital gains (~20%)      │
│  SAVINGS: Potentially hundreds of thousands in taxes             │
│                                                                  │
│  RISK: If you leave before vesting or company fails,             │
│  you lose the tax paid and cannot recover it.                    │
└──────────────────────────────────────────────────────────────────┘

FILING REQUIREMENTS:
□ Must file within 30 days of grant (STRICT DEADLINE)
□ File with IRS, give copy to company, keep copy
□ No extensions - miss it and you're out
□ Consult a tax advisor before filing
```

### Junior → FAANG: Equity Fundamentals That Prevent Expensive Mistakes

RSUs at public FAANG companies are simple: you receive shares on a vesting schedule, they are taxed as ordinary income at the time of vesting, and you can sell immediately or hold. The common early-career mistake is holding RSUs as a long-term investment without recognizing that this is a concentrated equity position in a single employer that simultaneously employs you. Diversifying vested RSUs is a basic financial hygiene practice, not a tactical decision.

Stock options at pre-IPO companies are more complex and more dangerous for early-career engineers because the most consequential decisions (exercise timing, tax treatment election) require knowledge that most engineers do not have without advice. The 90-day post-termination exercise window is the most financially consequential term in an early-stage option grant for an engineer who leaves before IPO, and it is rarely understood at the time of offer acceptance.

The minimum preparation: before accepting any offer that includes stock options rather than RSUs, consult with a financial advisor or attorney who specializes in startup equity. The cost of this consultation is trivial relative to the potential financial consequences of an uninformed exercise decision.

### Senior @ FAANG: Equity Architecture Decisions at L6 and Staff Level

At senior level, equity negotiation includes dimensions that early-career negotiations do not: the size of the initial grant relative to what you could reasonably expect from performance-based refreshes, the inclusion of acceleration clauses for double-trigger or single-trigger vesting upon acquisition, and the negotiation of the refresh grant policy for your specific level.

The governance principle for senior equity negotiation: understand that the initial RSU grant and the annual refresh policy are separate levers, and that FAANG companies are often more flexible on one than the other. A company that has a firm band for initial grants may be willing to commit to specific refresh performance targets in writing. Understanding which lever has more flexibility at your target company lets you negotiate more effectively.

For staff-level engineers with significant unvested equity at their current employer: the negotiation should include a specific conversation about signing bonus size relative to the unvested amount you are forfeiting. FAANG companies with strong hiring pipelines have detailed models for computing make-whole packages and will provide them upon request, but you must ask explicitly and provide your unvested equity schedule in writing.

---
