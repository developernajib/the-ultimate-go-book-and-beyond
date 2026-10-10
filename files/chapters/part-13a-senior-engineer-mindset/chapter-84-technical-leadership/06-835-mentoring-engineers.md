## 84.5 Mentoring Engineers

### The Mentoring Spectrum

Effective mentoring is not one-size-fits-all. Sometimes an engineer needs you to give them a direct answer because they are stuck on an urgent deadline. Other times, asking them a guiding question helps them develop problem-solving skills they will use for the rest of their career. The key is to match your approach to the situation: be directive when urgency or safety demands it, and switch to coaching when there is time for the mentee to learn by working through the problem themselves.

```
┌──────────────────────────────────────────────────────────────────┐
│                   MENTORING APPROACHES                           │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  DIRECTIVE ◄────────────────────────────────────► COACHING       │
│                                                                  │
│  "Here's how to do it"              "What do you think?"         │
│                                                                  │
│  USE WHEN:                          USE WHEN:                    │
│  - Urgent deadline                  - Mentee can solve it        │
│  - Mentee is stuck                 - Growth opportunity          │
│  - Dangerous mistake incoming      - Multiple valid approaches   │
│  - Knowledge transfer needed       - Building independence       │
│                                                                  │
│  EXAMPLES:                          EXAMPLES:                    │
│  "The bug is in line 42"           "What have you tried?"        │
│  "Use a mutex here"                "What happens if X?"          │
│  "Read this doc first"             "How would you test this?"    │
│                                                                  │
│  Match approach to situation and mentee's level                  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Effective Mentoring Techniques

Good mentoring requires structure, not just good intentions. You need to set clear expectations with your mentee, understand how they prefer to learn, and have a framework for productive conversations. The code below models these concepts as Go types to make them concrete and memorable. The GROW model (Goal, Reality, Options, Will) and SBI feedback model (Situation, Behavior, Impact) are two widely-used frameworks that give your mentoring sessions a repeatable structure.

```go
// Mentoring best practices

// 1. Set clear expectations
type MentoringRelationship struct {
    Frequency    time.Duration  // Weekly 1:1s
    Goals        []Goal         // What are we working toward?
    Style        Style          // How do they like to learn?
    Feedback     FeedbackStyle  // How to give feedback?
}

// 2. Understand learning styles
type LearningStyle int
const (
    LearnByDoing LearningStyle = iota  // "Let me try it"
    LearnByReading                      // "Show me docs"
    LearnByWatching                     // "Can I shadow you?"
    LearnByDiscussing                   // "Let's talk through it"
)

// 3. Use the GROW model
type GROWSession struct {
    Goal     string  // "What do you want to achieve?"
    Reality  string  // "Where are you now?"
    Options  string  // "What could you do?"
    Will     string  // "What will you do next?"
}

// 4. Give feedback effectively
type Feedback struct {
    // SBI Model
    Situation  string  // "In yesterday's code review..."
    Behavior   string  // "You dismissed the junior's suggestion..."
    Impact     string  // "This made them hesitant to share ideas"

    // Make it actionable
    Suggestion string  // "Next time, try asking clarifying questions"
}
```

### Common Mentoring Scenarios

One of the most tempting mistakes a senior engineer can make is to take over when a junior is struggling. While this feels productive in the moment, it robs the junior of a learning opportunity and creates a dependency on you. The scenario below demonstrates how to guide someone through a difficult task without doing the work for them. The goal is to provide just enough direction to get them unstuck while leaving room for them to build genuine understanding.

```
SCENARIO: Junior engineer struggling with a complex task

POOR APPROACH:
Take over and solve it yourself.
- Doesn't build their skills
- Creates dependency
- Misses teaching opportunity

BETTER APPROACH:

1. UNDERSTAND THE BLOCK
   "Walk me through what you've tried"
   "Where specifically are you stuck?"

2. PROVIDE MINIMAL GUIDANCE
   "Have you looked at how the auth service handles this?"
   "What if you started with a simpler case?"

3. CHECK UNDERSTANDING
   "Can you summarize the approach?"
   "What's your next step?"

4. SET CHECK-IN
   "Let's sync in an hour and see where you are"

5. FOLLOW UP
   "How did it go? What did you learn?"
```

### Junior → FAANG: Getting Mentored Well Before Mentoring Others

Before you can mentor effectively, you need to have been mentored thoughtfully and reflected on what made it valuable. The most common junior mistake is treating mentorship as a transactional relationship: ask a question, get an answer, move on. The engineers who grow fastest treat mentorship as a learning system: they come prepared with context, bring a specific attempt or hypothesis, and ask for feedback on their reasoning rather than just their conclusions.

For FAANG interviews, have a story ready about a mentor relationship that shaped your technical judgment. The story should show what you actively contributed to the relationship, not just what you received. Interviewers hear dozens of "my mentor taught me X" stories. The one that stands out is "I worked with my mentor on Y by doing Z, and here is how I applied that reasoning to a later decision on my own."

If you are being asked to describe your mentoring of others as a junior or mid-level engineer, the key is scope: you probably mentored interns or more junior engineers. Be specific about what you helped them learn, how you structured your feedback, and what the outcome was for them and the team.

### Senior @ FAANG: Mentoring as Organizational Infrastructure

At senior levels, the distinction between mentoring individuals and building mentoring infrastructure is the difference between L5 and L6 impact. An L5 who is a great mentor improves three or four engineers per year through direct relationship. An L6 who builds a mentoring system, structured 1:1 frameworks, growth conversation templates, documented career expectations, onboarding curricula, multiplies their impact across the entire org without direct involvement in every relationship.

The bar-raiser question for senior mentoring stories is: "What have you done to scale your mentoring impact beyond the engineers you directly work with?" If your answer is limited to named individuals you have coached, you are presenting at L5 scope. The L6 answer includes: systems you built, norms you introduced, processes you documented that other engineers now use to mentor without needing your involvement.

A sophisticated concern for staff engineers: be alert to the difference between mentoring that builds engineer autonomy and mentoring that creates dependency. An engineer who can only produce good work with your active guidance has not been well-mentored. The measure of effective mentoring is not gratitude, it is the quality of decisions the mentee makes when you are not in the room. Design your mentoring practice around that standard.

---
