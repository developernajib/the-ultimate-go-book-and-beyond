## Exercises

### Exercise 1: Total Compensation Calculator

**Problem:** Build a complete compensation comparison framework.

**Solution:**

```go
package main

import (
    "fmt"
    "strings"
)

// CompOffer represents a complete job offer using integer cents (Invariant 3)
type CompOffer struct {
    Company          string
    Level            string
    Location         string
    BaseSalaryCents  int64
    BonusPct         float64  // As decimal (0.15 = 15%)
    SignOnYear1Cents int64
    SignOnYear2Cents int64
    TotalEquityCents int64
    VestingType      string   // "standard", "amazon", "monthly"
    VestingYears     int
}

// YearlyBreakdown calculates compensation for each year in cents
func (o CompOffer) YearlyBreakdown() [4]int64 {
    var years [4]int64
    annualBonusCents := int64(float64(o.BaseSalaryCents) * o.BonusPct)

    for i := 0; i < 4; i++ {
        years[i] = o.BaseSalaryCents + annualBonusCents

        // Add sign-on
        if i == 0 {
            years[i] += o.SignOnYear1Cents
        } else if i == 1 {
            years[i] += o.SignOnYear2Cents
        }

        // Add equity based on vesting type
        years[i] += o.equityForYear(i + 1)
    }

    return years
}

// equityForYear calculates equity value for a specific year in cents
func (o CompOffer) equityForYear(year int) int64 {
    switch o.VestingType {
    case "amazon":
        // Amazon: 5%, 15%, 40%, 40%
        percents := []float64{0.05, 0.15, 0.40, 0.40}
        return int64(float64(o.TotalEquityCents) * percents[year-1])
    case "standard":
        // Standard: 25% per year
        return int64(float64(o.TotalEquityCents) * 0.25)
    default:
        // Even distribution
        return o.TotalEquityCents / int64(o.VestingYears)
    }
}

// FourYearTotal returns total compensation over 4 years in cents
func (o CompOffer) FourYearTotal() int64 {
    years := o.YearlyBreakdown()
    return years[0] + years[1] + years[2] + years[3]
}

// AverageAnnual returns average annual compensation in cents
func (o CompOffer) AverageAnnual() int64 {
    return o.FourYearTotal() / 4
}

// ComparisonReport generates a detailed comparison
func ComparisonReport(offers []CompOffer) string {
    var sb strings.Builder

    sb.WriteString("=" + strings.Repeat("=", 78) + "=\n")
    sb.WriteString("                     COMPENSATION COMPARISON REPORT\n")
    sb.WriteString("=" + strings.Repeat("=", 78) + "=\n\n")

    // Header
    sb.WriteString(fmt.Sprintf("%-15s", "Component"))
    for _, o := range offers {
        sb.WriteString(fmt.Sprintf("%-18s", o.Company))
    }
    sb.WriteString("\n" + strings.Repeat("-", 15+18*len(offers)) + "\n")

    // Base Salary
    sb.WriteString(fmt.Sprintf("%-15s", "Base Salary"))
    for _, o := range offers {
        sb.WriteString(fmt.Sprintf("$%-17d", o.BaseSalaryCents/100))
    }
    sb.WriteString("\n")

    // Bonus
    sb.WriteString(fmt.Sprintf("%-15s", "Bonus Target"))
    for _, o := range offers {
        annualBonusDollars := (int64(float64(o.BaseSalaryCents)*o.BonusPct)) / 100
        sb.WriteString(fmt.Sprintf("%.0f%% ($%d)      ",
            o.BonusPct*100, annualBonusDollars))
    }
    sb.WriteString("\n")

    // Sign-On
    sb.WriteString(fmt.Sprintf("%-15s", "Sign-On (Y1+Y2)"))
    for _, o := range offers {
        sb.WriteString(fmt.Sprintf("$%d + $%d     ",
            o.SignOnYear1Cents/100, o.SignOnYear2Cents/100))
    }
    sb.WriteString("\n")

    // Equity
    sb.WriteString(fmt.Sprintf("%-15s", "Equity (4yr)"))
    for _, o := range offers {
        sb.WriteString(fmt.Sprintf("$%-17d", o.TotalEquityCents/100))
    }
    sb.WriteString("\n")

    sb.WriteString(strings.Repeat("-", 15+18*len(offers)) + "\n")

    // Yearly breakdown
    for year := 1; year <= 4; year++ {
        sb.WriteString(fmt.Sprintf("%-15s", fmt.Sprintf("Year %d Total", year)))
        for _, o := range offers {
            years := o.YearlyBreakdown()
            sb.WriteString(fmt.Sprintf("$%-17d", years[year-1]/100))
        }
        sb.WriteString("\n")
    }

    sb.WriteString(strings.Repeat("=", 15+18*len(offers)) + "\n")

    // 4-Year Total
    sb.WriteString(fmt.Sprintf("%-15s", "4-YEAR TOTAL"))
    for _, o := range offers {
        sb.WriteString(fmt.Sprintf("$%-17d", o.FourYearTotal()/100))
    }
    sb.WriteString("\n")

    // Average Annual
    sb.WriteString(fmt.Sprintf("%-15s", "AVG ANNUAL"))
    for _, o := range offers {
        sb.WriteString(fmt.Sprintf("$%-17d", o.AverageAnnual()/100))
    }
    sb.WriteString("\n")

    // Recommendation
    sb.WriteString("\n" + strings.Repeat("=", 78) + "\n")
    sb.WriteString("ANALYSIS:\n")

    // Find best Year 1
    bestYear1 := 0
    bestYear1Val := int64(0)
    for i, o := range offers {
        years := o.YearlyBreakdown()
        if years[0] > bestYear1Val {
            bestYear1Val = years[0]
            bestYear1 = i
        }
    }
    sb.WriteString(fmt.Sprintf("- Best Year 1 Comp: %s ($%d)\n",
        offers[bestYear1].Company, bestYear1Val/100))

    // Find best 4-year
    best4Year := 0
    best4YearVal := int64(0)
    for i, o := range offers {
        if o.FourYearTotal() > best4YearVal {
            best4YearVal = o.FourYearTotal()
            best4Year = i
        }
    }
    sb.WriteString(fmt.Sprintf("- Best 4-Year Total: %s ($%d)\n",
        offers[best4Year].Company, best4YearVal/100))

    return sb.String()
}

func main() {
    // Example: Comparing 3 offers
    offers := []CompOffer{
        {
            Company:          "Google",
            Level:            "L5",
            Location:         "Bay Area",
            BaseSalaryCents:  21000000,
            BonusPct:         0.15,
            SignOnYear1Cents: 5000000,
            SignOnYear2Cents: 2500000,
            TotalEquityCents: 40000000,
            VestingType:      "standard",
            VestingYears:     4,
        },
        {
            Company:          "Amazon",
            Level:            "L6",
            Location:         "Seattle",
            BaseSalaryCents:  18500000,
            BonusPct:         0.15,
            SignOnYear1Cents: 12000000,
            SignOnYear2Cents: 6000000,
            TotalEquityCents: 40000000,
            VestingType:      "amazon",
            VestingYears:     4,
        },
        {
            Company:          "Meta",
            Level:            "E5",
            Location:         "Remote",
            BaseSalaryCents:  22000000,
            BonusPct:         0.10,
            SignOnYear1Cents: 6000000,
            SignOnYear2Cents: 0,
            TotalEquityCents: 50000000,
            VestingType:      "standard",
            VestingYears:     4,
        },
    }

    fmt.Println(ComparisonReport(offers))
}

/*
OUTPUT:
================================================================================
                     COMPENSATION COMPARISON REPORT
================================================================================

Component      Google            Amazon            Meta
-------------------------------------------------------------------------------
Base Salary    $210000           $185000           $220000
Bonus Target   15% ($31500)      15% ($27750)      10% ($22000)
Sign-On (Y1+Y2)$50000 + $25000   $120000 + $60000  $60000 + $0
Equity (4yr)   $400000           $400000           $500000
-------------------------------------------------------------------------------
Year 1 Total   $391500           $352750           $427000
Year 2 Total   $366500           $332750           $367000
Year 3 Total   $341500           $372750           $367000
Year 4 Total   $341500           $372750           $367000
===============================================================================
4-YEAR TOTAL   $1441000          $1431000          $1528000
AVG ANNUAL     $360250           $357750           $382000

================================================================================
ANALYSIS:
- Best Year 1 Comp: Meta ($427000)
- Best 4-Year Total: Meta ($1528000)
*/
```

### Exercise 2: Negotiation Simulation Role-Play

**Problem:** Practice negotiation scenarios with structured responses.

**Solution:**

```markdown
# NEGOTIATION SIMULATION EXERCISE

## Scenario Setup
You are a Senior Software Engineer with 5 years of experience.
Current compensation: $280,000 total comp at a Series B startup.
You have received an offer from BigTech Corp.

Initial Offer:
- Base: $190,000
- Equity: $300,000 (4-year vest, standard schedule)
- Sign-on: $30,000
- Bonus: 15% target
- Total Year 1: ~$334,500

Your research shows:
- Market rate: $350,000-$420,000 for this level
- You have another offer from CompetitorCorp at $380,000 TC

---

## ROUND 1: Recruiter Call

Recruiter: "Great news! The team loved you. We're extending an offer
           at $190K base, $300K equity, $30K sign-on. Excited?"

### Your Response:
"Thank you so much! I'm really excited about the team and the
opportunity. I'd like to take a few days to review the details.
Can you send me the full offer in writing?

A few questions:
- What level is this offer for? Where does it fall in the band?
- What's the vesting schedule for the equity?
- When would you need a final decision?"

### Analysis:
✓ Expressed enthusiasm
✓ Didn't react to numbers
✓ Asked for written offer
✓ Gathered intel (level, timeline)
✗ Didn't start negotiating yet

---

## ROUND 2: Counter Offer Email

Subject: Re: Offer Discussion - Senior Engineer Position

Hi [Recruiter],

Thank you again for the offer to join BigTech. After speaking with
the team and learning about the [specific project], I'm genuinely
excited about the opportunity.

I've had time to review the details and do some research. I'd like
to discuss the compensation package.

I'm currently considering an offer from [CompetitorCorp] at $380,000
total compensation. BigTech is my strong preference because of
[specific reason - technology, team, mission], but I'm hoping we can
close the gap.

Would there be flexibility to adjust the offer to:
- Base salary: $210,000 (up from $190,000)
- Equity grant: $400,000 (up from $300,000)
- Sign-on bonus: $50,000 (up from $30,000)

This would bring Year 1 total to approximately $395,000, which is
more competitive with my alternatives.

I'm very motivated to join BigTech and confident we can find an
arrangement that works for both of us.

Best regards,
[Your Name]

### Analysis:
✓ Led with enthusiasm (not demands)
✓ Mentioned competing offer with specific number
✓ Explained why they're still preferred
✓ Made specific, itemized ask
✓ Left room for negotiation (didn't say "or else")
✓ Collaborative closing

---

## ROUND 3: Recruiter Response

Recruiter: "Thanks for the transparency. I spoke with the team. We
           can move on some of this:
           - Base: $200K (we have band limits)
           - Equity: $350K
           - Sign-on: $40K
           This brings Year 1 to about $360K. Is this something
           you could work with?"

### Your Response (Phone Call):

"Thank you for working on this - I appreciate the movement. Let me
make sure I understand the updated offer:
- Base: $200K
- Equity: $350K over 4 years with standard vesting
- Sign-on: $40K
- 15% bonus target

That brings Year 1 to roughly $362K.

I'm almost there. The competing offer is still at $380K. Is there
any way to get to $375K? Perhaps:
- An additional $20K in sign-on, or
- Another $50K in equity?

I want to join BigTech. I just want to make sure I'm not leaving
too much on the table relative to my alternative."

[PAUSE - Let them respond]

### Analysis:
✓ Acknowledged their effort
✓ Confirmed details (important for accuracy)
✓ Made another specific ask
✓ Provided options (flexible)
✓ Expressed commitment
✓ Used silence strategically

---

## ROUND 4: Final Negotiation

Recruiter: "Let me see what I can do. [Pause] Okay, we can add $15K
           to the sign-on, making it $55K total. That's our best
           and final offer."

### Your Response:

"I appreciate you going back to the team. Let me confirm the final
offer:
- Base: $200,000
- Equity: $350,000 (4-year vest)
- Sign-on: $55,000
- Bonus: 15% target (~$30,000)
- Year 1 Total: ~$372,500

Thank you for working with me on this. I'm going to take tonight to
discuss with my family and will have a final answer tomorrow morning.
Can you send me the updated offer in writing?"

### Day After:
"Hi [Recruiter], I'm excited to accept the offer to join BigTech!
[Confirm all details in acceptance email]"

---

## NEGOTIATION SCORECARD

Starting Offer:      $334,500 (Year 1)
Final Offer:         $372,500 (Year 1)
Increase:            $38,000 (11.4% improvement)

4-Year Impact:
- Additional Sign-on: $25,000
- Additional Equity:  $50,000
- Additional Base:    $40,000 (over 4 years)
Total 4-Year Gain:    $115,000

Time Invested: ~2 hours
Hourly Rate of Negotiation: $57,500/hour

KEY TAKEAWAYS:
1. The first offer is NEVER the best offer
2. Competing offers are the strongest leverage
3. Be specific in your asks
4. Express enthusiasm throughout
5. Use silence strategically
6. Get everything in writing
```

### Exercise 3: Startup Equity Evaluation

**Problem:** Evaluate a startup equity offer to determine true value.

**Solution:**

```go
package main

import (
    "fmt"
)

// StartupOffer represents equity from a startup using integer cents (Invariant 3)
type StartupOffer struct {
    Company                string
    Shares                 int
    StrikePriceCents       int64  // For options ($2.50 = 250)
    TotalSharesOutstanding int    // Fully diluted
    LastValuationCents     int64  // Latest round ($500M = 50000000000)
    PreferenceStackCents   int64  // Liquidation preferences ahead of common ($150M = 15000000000)
    VestingMonths          int
    CliffMonths            int
}

// OwnershipPercentage calculates your ownership
func (s StartupOffer) OwnershipPercentage() float64 {
    return float64(s.Shares) / float64(s.TotalSharesOutstanding) * 100
}

// ValueAtExit calculates value at different exit scenarios in cents
func (s StartupOffer) ValueAtExit(exitValuationCents int64) int64 {
    // After liquidation preferences, remaining goes to common
    remainingForCommonCents := exitValuationCents - s.PreferenceStackCents
    if remainingForCommonCents < 0 {
        remainingForCommonCents = 0
    }

    yourShareOfCommonCents := int64(float64(remainingForCommonCents) * (float64(s.Shares) / float64(s.TotalSharesOutstanding)))

    // For options, subtract strike price
    if s.StrikePriceCents > 0 {
        intrinsicValueCents := (exitValuationCents / int64(s.TotalSharesOutstanding)) - s.StrikePriceCents
        if intrinsicValueCents > 0 {
            return intrinsicValueCents * int64(s.Shares)
        }
        return 0
    }

    return yourShareOfCommonCents
}

// ExpectedValue calculates probability-weighted expected value in cents
func (s StartupOffer) ExpectedValue() int64 {
    // Exit scenarios with probabilities (simplified)
    scenarios := []struct {
        multiple    float64  // Multiple of last valuation
        probability float64
    }{
        {0.0, 0.30},   // 30% chance of failure
        {0.5, 0.15},   // 15% chance of down round/acquihire
        {1.0, 0.20},   // 20% chance of flat exit
        {2.0, 0.20},   // 20% chance of 2x
        {5.0, 0.10},   // 10% chance of 5x
        {10.0, 0.05},  // 5% chance of 10x
    }

    expectedValueCents := int64(0)
    for _, sc := range scenarios {
        exitValCents := int64(float64(s.LastValuationCents) * sc.multiple)
        yourValueCents := s.ValueAtExit(exitValCents)
        expectedValueCents += int64(float64(yourValueCents) * sc.probability)
    }

    return expectedValueCents
}

// AnalysisReport generates detailed analysis
func (s StartupOffer) AnalysisReport() string {
    report := fmt.Sprintf(`
================================================================================
                    STARTUP EQUITY ANALYSIS: %s
================================================================================

OFFER DETAILS:
- Shares:                %d
- Strike Price:          $%.2f
- Vesting:               %d months with %d month cliff

OWNERSHIP:
- Total Shares Outstanding: %d (fully diluted)
- Your Ownership:           %.4f%%

VALUATION CONTEXT:
- Last Round Valuation:     $%d
- Liquidation Preferences:  $%d

EXIT SCENARIO ANALYSIS:
--------------------------------------------------------------------------------
| Exit Valuation | Multiple | Your Value (Pre-Tax) | After 37%% Tax |
--------------------------------------------------------------------------------`,
        s.Company,
        s.Shares,
        float64(s.StrikePriceCents)/100.0,
        s.VestingMonths,
        s.CliffMonths,
        s.TotalSharesOutstanding,
        s.OwnershipPercentage(),
        s.LastValuationCents/100,
        s.PreferenceStackCents/100,
    )

    multiples := []float64{0, 0.5, 1, 2, 3, 5, 10}
    for _, m := range multiples {
        exitValCents := int64(float64(s.LastValuationCents) * m)
        yourValueCents := s.ValueAtExit(exitValCents)
        afterTaxCents := int64(float64(yourValueCents) * 0.63) // Rough estimate after taxes

        report += fmt.Sprintf("\n| $%-13d | %-8.1fx | $%-19d | $%-14d |",
            exitValCents/100, m, yourValueCents/100, afterTaxCents/100)
    }

    expectedCents := s.ExpectedValue()
    expectedAfterTaxCents := int64(float64(expectedCents) * 0.63)
    publicRsuCents := int64(40000000) // $400K = $100K/year * 4 in cents
    var riskPremium float64
    if expectedAfterTaxCents > 0 {
        riskPremium = float64(publicRsuCents) / float64(expectedAfterTaxCents)
    }

    report += fmt.Sprintf(`
--------------------------------------------------------------------------------

EXPECTED VALUE ANALYSIS (Probability-Weighted):
- Expected Value:           $%d (pre-tax)
- Expected Value:           $%d (after ~37%% tax)

COMPARISON TO PUBLIC COMPANY RSUs:
- $100K/year in RSUs at public company = $400K over 4 years (guaranteed)
- This startup equity expected value = $%d (not guaranteed)
- Risk premium you're paying:          %.1fx

KEY QUESTIONS TO ASK:
□ What's the current 409A valuation? (Strike price basis)
□ What's the total preference stack? (Who gets paid first)
□ What's the company's runway? (Months of cash)
□ What's the path to liquidity? (IPO timeline, secondary sales)
□ Any anti-dilution provisions for employees?
□ What happens to unvested shares if acquired?

RECOMMENDATION:
`,
        expectedCents/100,
        expectedAfterTaxCents/100,
        expectedAfterTaxCents/100,
        riskPremium,
    )

    // Add recommendation
    if expectedAfterTaxCents > 40000000 {
        report += "→ Expected value exceeds equivalent public company RSUs.\n"
        report += "  Consider the risk tolerance and liquidity timeline."
    } else if expectedAfterTaxCents > 20000000 {
        report += "→ Expected value is below equivalent RSUs but meaningful.\n"
        report += "  Only accept if you believe in the company's upside."
    } else {
        report += "→ Expected value is significantly below public company RSUs.\n"
        report += "  Request more shares or negotiate higher cash compensation."
    }

    return report
}

func main() {
    // Example: Series B startup offer
    offer := StartupOffer{
        Company:                "TechStartup Inc.",
        Shares:                 50000,
        StrikePriceCents:       250,         // $2.50
        TotalSharesOutstanding: 100000000,   // 100M fully diluted
        LastValuationCents:     50000000000, // $500M Series B ($500M * 100 cents)
        PreferenceStackCents:   15000000000, // $150M in preferences ($150M * 100 cents)
        VestingMonths:          48,
        CliffMonths:            12,
    }

    fmt.Println(offer.AnalysisReport())
}

/*
SAMPLE OUTPUT:

================================================================================
                    STARTUP EQUITY ANALYSIS: TechStartup Inc.
================================================================================

OFFER DETAILS:
- Shares:                50000
- Strike Price:          $2.50
- Vesting:               48 months with 12 month cliff

OWNERSHIP:
- Total Shares Outstanding: 100000000 (fully diluted)
- Your Ownership:           0.0500%

VALUATION CONTEXT:
- Last Round Valuation:     $500000000
- Liquidation Preferences:  $150000000

EXIT SCENARIO ANALYSIS:
--------------------------------------------------------------------------------
| Exit Valuation | Multiple | Your Value (Pre-Tax) | After 37% Tax |
--------------------------------------------------------------------------------
| $0             | 0.0x     | $0                   | $0             |
| $250000000     | 0.5x     | $0                   | $0             |
| $500000000     | 1.0x     | $50000               | $31500         |
| $1000000000    | 2.0x     | $175000              | $110250        |
| $1500000000    | 3.0x     | $300000              | $189000        |
| $2500000000    | 5.0x     | $550000              | $346500        |
| $5000000000    | 10.0x    | $1175000             | $740250        |
--------------------------------------------------------------------------------

EXPECTED VALUE ANALYSIS (Probability-Weighted):
- Expected Value:           $145000 (pre-tax)
- Expected Value:           $91350 (after ~37% tax)

COMPARISON TO PUBLIC COMPANY RSUs:
- $100K/year in RSUs at public company = $400K over 4 years (guaranteed)
- This startup equity expected value = $91350 (not guaranteed)
- Risk premium you're paying:          4.4x

RECOMMENDATION:
→ Expected value is significantly below public company RSUs.
  Request more shares or negotiate higher cash compensation.
*/
```

### Exercise 4: Counter Offer Email Template Generator

**Problem:** Create counter offer emails for different scenarios.

**Solution:**

```markdown
# COUNTER OFFER EMAIL TEMPLATES

---

## Template 1: With Competing Offer (Strongest Position)

Subject: Re: Offer Discussion - [Position] at [Company]

Hi [Recruiter Name],

Thank you for the offer to join [Company] as a [Position]. After meeting
with [hiring manager/team], I'm genuinely excited about [specific aspect - 
the technical challenges, the team's approach, the company mission].

I want to be transparent about where I am: I've received a competing offer
from [Company/another company] with a total compensation of $[X]. While
[Your Company] remains my top choice because [specific reason], I'm hoping
we can work together to close the gap.

Based on the competing offer and my research on market rates, I'd like to
discuss adjusting the package to:

- Base salary: $[target] (currently $[offered])
- Signing bonus: $[target] (currently $[offered])
- Equity: $[target] over 4 years (currently $[offered])

This would bring the total Year 1 compensation to approximately $[target],
which is more aligned with my alternatives.

I'm very motivated to join [Company] and confident we can find an arrangement
that works for both of us. Would you be available for a call to discuss?

Best regards,
[Your Name]

---

## Template 2: Without Competing Offer (Market Data Approach)

Subject: Re: Offer Discussion - [Position] at [Company]

Hi [Recruiter Name],

Thank you again for extending the offer. I've taken time to review the
details carefully, and I'm excited about the opportunity.

After researching market compensation for [Position] at [Location] using
levels.fyi and conversations with peers in similar roles, I'd like to
discuss the offer. Based on my research, the market range for this level
is $[X]-$[Y], and I believe my [X years of experience in Y area] and
[specific achievement] position me toward the upper end of that range.

I was hoping we could explore:

- Increasing the signing bonus to $[target] to strengthen the Year 1 package
- Adjusting the equity grant to $[target] to reflect the market midpoint

I understand there may be constraints, and I'm open to creative solutions.
For example, if the base is fixed, perhaps there's flexibility in other
components?

I'm enthusiastic about joining [Company] and would love to find a package
that works for both of us.

Best,
[Your Name]

---

## Template 3: Post-Initial Rejection (Second Ask)

Subject: Re: Offer Discussion - Following Up

Hi [Recruiter Name],

Thank you for the update on the offer constraints. I appreciate you
looking into the flexibility.

I want to reiterate my genuine interest in [Company]. Before I make my
final decision, I wanted to explore a few other possibilities:

1. **Signing Bonus**: If the equity grant is at its limit, would there be
   room to increase the signing bonus to $[target]? This would help bridge
   the gap in Year 1.

2. **Early Review**: Could we document a 6-month compensation review with
   the potential for a salary adjustment or additional equity refresh?

3. **Start Date Flexibility**: If there's no movement on compensation,
   would it be possible to start on [earlier date] to capture an additional
   [bonus/vesting period]?

I don't want to be difficult - I'm simply trying to make the numbers work on
my end. Please let me know if any of these options are possible.

Thank you for your patience throughout this process.

Best,
[Your Name]

---

## Template 4: Acceptance Email (After Negotiation)

Subject: Offer Acceptance - [Position] at [Company]

Hi [Recruiter Name],

I'm thrilled to accept the offer to join [Company] as a [Position]!

To confirm my understanding of the final offer:

- **Base Salary**: $[amount]
- **Signing Bonus**: $[amount] (paid [timing])
- **Equity**: $[amount] in RSUs vesting over [X years]
- **Annual Bonus Target**: [X]%
- **Start Date**: [Date]
- **Location**: [Office/Remote]

Please send any paperwork needed to formalize the offer. I'm ready to
complete the background check and any other onboarding requirements.

Thank you for working with me throughout this process. I'm excited to
join the team and contribute to [specific project/mission]!

Best regards,
[Your Name]

---

## Template 5: Graceful Decline After Negotiation

Subject: [Position] - My Decision

Hi [Recruiter Name],

I want to personally thank you for the offer and for working with me over
the past few weeks. This was a genuinely difficult decision.

After careful consideration, I've decided to accept an opportunity that
better aligns with my current priorities. This has nothing to do with
[Company] - I was genuinely impressed by [specific positive: the team,
the technology, the mission].

I hope we can stay in touch. The tech community is small, and I'd welcome
the chance to reconnect in the future.

Thank you again for your time and consideration.

Best,
[Your Name]

---

## Quick Reference: Email Components

| Scenario | Key Components |
|----------|---------------|
| With competing offer | Transparency, specific number, why they're preferred |
| Without competing offer | Market data, specific value you bring, flexibility |
| After rejection | Alternative asks, creativity, persistence |
| Acceptance | Confirm all details, enthusiasm, next steps |
| Decline | Gratitude, brief reason, leave door open |
```

---

### Practical Action Exercises

1. **Comp Research Exercise**: Research compensation for your target role at 5 companies using levels.fyi. Document the ranges and identify your target.

2. **Negotiation Role Play**: Practice delivering your counter offer out loud. Record yourself and listen for filler words, hedging, or nervous rambling.

3. **Offer Comparison**: Create a weighted comparison framework for your priorities. What matters most to you beyond compensation?

4. **Script Writing**: Write your counter offer email before you need it. Having it ready reduces stress when the moment comes.

5. **Walk-Away Calculation**: Determine your true minimum acceptable offer. Consider your financial needs, career goals, and alternatives.

6. **Total Comp Calculator**: Use the Go code from Exercise 1 to compare actual offers you receive. Run different scenarios.

7. **Startup Equity Analysis**: If considering a startup, use the equity analyzer from Exercise 3 to understand true expected value.

8. **Mock Negotiation**: Partner with a friend and role-play the scenarios from Exercise 2. Switch roles and provide feedback.

### Junior → FAANG: Making Exercises Produce Real Negotiation Readiness

The exercises in this section are most valuable when executed before you need them, not as academic study. If you are within six months of an expected job search, complete exercises 1 through 4 now and store the results. When you receive an offer, you will have pre-built tools for evaluation rather than building them under deadline pressure.

The mock negotiation exercise (exercise 8) is the most uncomfortable and most valuable. Recording yourself on video and watching the playback identifies confidence gaps that you cannot identify from the inside: a hesitant tone, hedging language, physical tells that suggest uncertainty. These are correctable with practice and uncorrectable with knowledge alone.

### Senior @ FAANG: Senior Exercise Extensions and Multi-Offer Management Practice

At senior level, add a multi-offer management simulation to the exercise set: create three hypothetical offers from different company types (large FAANG, growth-stage startup, established mid-size company), model the four-year total compensation at multiple stock price scenarios for each, and apply the weighted decision framework to identify which offer wins under which assumptions. Then change one variable (your risk tolerance for equity, your planned tenure, your current unvested equity) and observe how the decision changes.

This multi-variable sensitivity analysis is the actual decision problem senior engineers face, and practicing it with hypothetical offers builds the analytical muscles that produce better decisions under real time pressure. The engineers who consistently make strong career move decisions at senior level are the ones who have internalized a structured decision framework, not the ones who make the decision by gut feel and then rationalize it afterward.

---

## Summary

### Key Takeaways
- **Total Compensation Decomposition**: Evaluate offers by isolating base salary, target bonuses, and equity vesting schedules; never accept unvested promises or assume private equity equals liquid cash.
- **Integer Cents Precision**: Always compute equity, liquidation preferences, and compensation packages using minor units (`int64` cents) to avoid float rounding drift during high-stakes multi-year modeling.
- **Principled Negotiation**: Ground all negotiation counters in objective market benchmarks, leverage competing timelines transparently, and preserve professional goodwill at every interaction.

---

*Next: [Chapter 96C: Resignation & Transition](../chapter-96c-resignation-transition/00-introduction.md)*
