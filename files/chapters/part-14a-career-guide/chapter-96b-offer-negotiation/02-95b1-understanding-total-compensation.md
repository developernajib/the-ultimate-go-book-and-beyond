## 96B.1 Understanding Total Compensation

### The Compensation Stack

Before any negotiation, you need to know what you are actually negotiating over. Total compensation at tech companies is a stack of components with very different risk and liquidity profiles:

```
┌──────────────────────────────────────────────────────────────────┐
│                  TOTAL COMPENSATION BREAKDOWN                    │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  BASE SALARY                                                     │
│  └── Fixed annual amount, paid bi-weekly or monthly              │
│  └── Typically 50-70% of total comp at big tech                  │
│                                                                  │
│  ANNUAL BONUS                                                    │
│  └── Performance-based (typically 10-25% of base)                │
│  └── Company + individual performance multipliers                │
│  └── Not guaranteed - depends on company performance             │
│                                                                  │
│  SIGN-ON BONUS                                                   │
│  └── One-time payment (sometimes split Year 1 & Year 2)          │
│  └── May have clawback clause if you leave early                 │
│  └── Used to bridge equity cliff                                 │
│                                                                  │
│  EQUITY (RSU/Options)                                            │
│  └── Restricted Stock Units (RSUs) - most common at big tech     │
│  └── Stock Options (ISOs/NSOs) - common at startups              │
│  └── Vests over time (typically 4 years)                         │
│                                                                  │
│  BENEFITS                                                        │
│  └── Health insurance ($15-25k value)                            │
│  └── 401k match (up to $10k+)                                    │
│  └── Other perks (meals, transit, etc.)                          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Real Example: Senior Engineer Offer

Here is how the stack composes into a concrete senior-level offer:

```
COMPANY: Large Tech Company (L5/E5 Level)
LOCATION: San Francisco Bay Area

┌──────────────────────────────────────────────────────────────────┐
│  COMPONENT          │  YEAR 1    │  YEAR 2    │  YEAR 3          │
├──────────────────────────────────────────────────────────────────┤
│  Base Salary        │  $210,000  │  $210,000  │  $210,000        │
│  Annual Bonus (15%) │  $31,500   │  $31,500   │  $31,500         │
│  Sign-On Bonus      │  $50,000   │  $25,000   │  $0              │
│  RSU (4yr/$400k)    │  $50,000   │  $100,000  │  $125,000        │
│  ─────────────────────────────────────────────────────────────   │
│  TOTAL CASH + EQUITY│  $341,500  │  $366,500  │  $366,500        │
│                                                                  │
│  Benefits Value     │  ~$25,000  │  ~$25,000  │  ~$25,000        │
│  ─────────────────────────────────────────────────────────────   │
│  TRUE TOTAL COMP    │  $366,500  │  $391,500  │  $391,500        │
└──────────────────────────────────────────────────────────────────┘

Note: RSU value assumes stock price stays flat. Actual value varies.
```

### Understanding Vesting Schedules

Vesting schedules determine when your equity actually becomes yours. A four-year vesting schedule with a one-year cliff means you receive nothing if you leave before twelve months, then vest monthly or quarterly after that. The schedule structure significantly affects the real value of your compensation package.

```
COMMON VESTING SCHEDULES:

1. STANDARD 4-YEAR WITH 1-YEAR CLIFF (Most common)
   Year 1: 25% vests on 1-year anniversary
   Year 2-4: Monthly or quarterly vesting

   $400,000 RSU grant example:
   ├── Month 0-11: $0 vested
   ├── Month 12: $100,000 vests (cliff)
   ├── Month 13-48: ~$8,333/month vests
   └── Month 48: Fully vested

2. AMAZON BACKLOADED SCHEDULE
   Year 1: 5%   = $20,000
   Year 2: 15%  = $60,000
   Year 3: 40%  = $160,000
   Year 4: 40%  = $160,000

   (Compensated with higher Year 1-2 sign-on bonuses)

3. GOOGLE/META FRONT-LOADED
   Equal quarterly vesting over 4 years
   More predictable, higher Year 1 equity value

4. MONTHLY VESTING (No cliff)
   Common at some companies
   Lower risk if you leave early
```

### Calculating True Annual Compensation

Vesting schedules and one-time bonuses make year-one comp differ from steady-state comp. Compute both before comparing offers:

```go
// Framework for calculating true compensation using integer cents
type CompensationPackage struct {
    BaseSalaryCents   int64
    BonusPercent      float64  // As decimal (0.15 for 15%)
    SignOnYear1Cents  int64
    SignOnYear2Cents  int64
    TotalEquityCents  int64
    VestingYears      int
    VestingType       string   // "standard", "amazon", "monthly"
}

func (c CompensationPackage) Year1TotalCents() int64 {
    bonusCents := int64(float64(c.BaseSalaryCents) * c.BonusPercent)

    var equityCents int64
    switch c.VestingType {
    case "amazon":
        equityCents = int64(float64(c.TotalEquityCents) * 0.05)
    case "standard":
        equityCents = int64(float64(c.TotalEquityCents) * 0.25)
    default:
        equityCents = c.TotalEquityCents / int64(c.VestingYears)
    }

    return c.BaseSalaryCents + bonusCents + c.SignOnYear1Cents + equityCents
}

func (c CompensationPackage) FourYearTotalCents() int64 {
    baseTotal := c.BaseSalaryCents * 4
    bonusTotal := int64(float64(c.BaseSalaryCents)*c.BonusPercent) * 4
    signOnTotal := c.SignOnYear1Cents + c.SignOnYear2Cents

    return baseTotal + bonusTotal + signOnTotal + c.TotalEquityCents
}

func (c CompensationPackage) AverageAnnualCents() int64 {
    return c.FourYearTotalCents() / 4
}
```

### Junior → FAANG: Total Compensation Literacy as a First-Job Prerequisite

Most early-career engineers accept their first FAANG offer without understanding what they are actually agreeing to. Base salary is the smallest lever in the compensation stack at senior levels, but it also happens to be the most familiar. RSU grants, vesting schedules, and the relationship between compensation bands and equity refresh rates are not intuitive and are not explained clearly in offer letters.

The most important concept to understand before evaluating any offer: the four-year total compensation, not the annual number. An offer of $150K base with a $200K RSU grant over four years is $200K per year in total, but that number obscures the fact that year one is $150K base plus 25 percent of the RSU grant, while year four depends entirely on the stock price at vesting time. Model the offer at three stock price scenarios: flat, up 50 percent, down 30 percent. This range gives you a realistic picture of your compensation exposure.

### Senior @ FAANG: Compensation Architecture Analysis at L6 and the Compounding Refresh Model

At senior level, total compensation analysis requires modeling not just the offer but the expected compensation trajectory over your full tenure at the company. RSU refresh grants are the most significant compensation variable over a multi-year tenure, and they are also the most opaque part of the offer process.

The governance analysis: understand your company's refresh grant policy before accepting. At Google, refresh grants are tied to performance ratings and are substantial for strong performers. At Amazon, base salary is capped at a relatively low level and the total compensation model depends heavily on the RSU schedule structure. At Meta, refresh grants are determined by a combination of performance rating and calibration relative to peer group. Knowing these mechanics lets you project your compensation trajectory three to four years out, which is essential for making informed tenure decisions.

For senior engineers, the equity component of compensation also includes the option value of joining a pre-IPO company. Evaluating pre-IPO equity requires understanding the company's capitalization table, the liquidation preference structure, and the realistic exit probability and timeline. This analysis is substantially more complex than evaluating public company RSUs and often requires advice from an attorney or financial advisor who specializes in startup equity.

---
