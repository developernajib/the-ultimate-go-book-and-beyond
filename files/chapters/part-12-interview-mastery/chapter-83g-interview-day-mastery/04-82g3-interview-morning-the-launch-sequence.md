## 83G.3 Interview Morning: The Launch Sequence

The morning of your interview should be boring. Every decision should already be made. Every outfit should already be chosen. Every route should already be planned. You are not making choices. You are executing a checklist.

### Wake-Up Routine and Timing

```
INTERVIEW MORNING TIMELINE (adjust based on your interview time)

Interview at 10:00 AM? Here's your morning:

7:00 AM  Wake up (3 hours before)
7:05 AM  Drink a glass of water
7:10 AM  Shower and get dressed (clothes already laid out)
7:30 AM  Breakfast (already planned)
7:50 AM  Read your Confidence List
7:55 AM  Warm-up problems (2-3 easy ones, 15 minutes)
8:15 AM  Review quick reference card
8:25 AM  Pack bag / final tech check
8:45 AM  Leave for interview (arrive 15 min early)
         OR
8:45 AM  Final virtual setup check
9:00 AM  At interview location / at desk, settled
9:50 AM  5-minute centering exercise
9:55 AM  Open interview link / walk to interview room
10:00 AM Interview begins

KEY PRINCIPLES:
- No rushing. If you're rushing, you started too late.
- No studying. If you don't know it by now, you don't know it.
- No social media, no news, no negative content.
- Treat yourself like an athlete before a competition.
```

### Morning Warm-Up: 2--3 Easy Problems to Activate Your Brain

Do not attempt hard problems on interview morning. That path leads to frustration and self-doubt. Instead, solve 2--3 problems you have already solved before --- problems rated Easy that take you 5--7 minutes each. The purpose is not to learn. The purpose is to activate the neural pathways you need: reading a problem statement, structuring your approach, writing code, testing. Think of it as stretching before a race.

**Good morning warm-up problems in Go:**

```go
// Warm-up 1: Reverse a string (easy, activates basic Go syntax)
func reverseString(s string) string {
    runes := []rune(s)
    for i, j := 0, len(runes)-1; i < j; i, j = i+1, j-1 {
        runes[i], runes[j] = runes[j], runes[i]
    }
    return string(runes)
}

// Warm-up 2: Two Sum (easy, activates map usage and problem-solving)
func twoSum(nums []int, target int) []int {
    seen := make(map[int]int)
    for i, num := range nums {
        if j, ok := seen[target-num]; ok {
            return []int{j, i}
        }
        seen[num] = i
    }
    return nil
}

// Warm-up 3: Valid parentheses (easy, activates stack thinking)
func isValid(s string) bool {
    stack := []rune{}
    pairs := map[rune]rune{')': '(', ']': '[', '}': '{'}
    for _, ch := range s {
        if ch == '(' || ch == '[' || ch == '{' {
            stack = append(stack, ch)
        } else {
            if len(stack) == 0 || stack[len(stack)-1] != pairs[ch] {
                return false
            }
            stack = stack[:len(stack)-1]
        }
    }
    return len(stack) == 0
}
```

Do not time yourself. Do not judge yourself. Just solve them, verify they work, and move on. Your brain is now warmed up.

### Breakfast for Peak Cognitive Performance

Your brain consumes approximately 20% of your body's energy. Feed it properly.

**The ideal interview breakfast:**
- Complex carbohydrates for sustained energy (oatmeal, whole grain toast)
- Protein for alertness (eggs, Greek yogurt, nuts)
- Fruit for quick-release energy and vitamins (berries, banana)
- Water (your brain is 75% water. dehydration impairs cognition)

**Eat 1.5--2 hours before the interview.** This gives your body time to digest so blood is flowing to your brain, not your stomach.

**Caffeine strategy:** If you normally drink coffee, drink your normal amount. This is not the day to go without (withdrawal headaches) or to double your intake (jitters, anxiety). One cup, maybe two, at your normal time.

### The 5-Minute Centering Exercise Before the First Round

This technique is adapted from sports psychology and is used by Olympic athletes, Navy SEALs, and surgeons. Do it in the 5 minutes before your first interview round.

```
THE 5-MINUTE CENTERING EXERCISE

1. BREATHE (60 seconds)
   - Box breathing: inhale 4 seconds, hold 4 seconds,
     exhale 4 seconds, hold 4 seconds
   - Repeat 4 times
   - This activates your parasympathetic nervous system
     (the "rest and digest" counterpart to "fight or flight")

2. GROUND (30 seconds)
   - Feel your feet on the floor
   - Feel your hands on your thighs
   - Notice 3 things you can see, 2 things you can hear
   - This pulls you out of anxious thoughts and into the present

3. AFFIRM (30 seconds)
   - "I have prepared for this."
   - "I know this material."
   - "Getting stuck is normal. I know how to recover."
   - "This interviewer is a potential colleague, not a judge."

4. VISUALIZE (60 seconds)
   - See yourself calmly reading the problem
   - See yourself asking good clarifying questions
   - See yourself thinking aloud and writing clean code
   - See yourself handling a difficult moment with composure

5. ACTIVATE (60 seconds)
   - Smile (tricks your brain into positive affect)
   - Sit up straight (power posture)
   - Roll your shoulders back
   - Unclench your jaw
   - Say quietly: "Let's go."
```

### Power Poses and Confidence Techniques

Amy Cuddy's research on power poses has been debated, but the underlying principle holds: your body posture affects your psychological state. Before your interview:

- Stand tall for 2 minutes. Shoulders back, head up, hands on hips.
- Smile. Even a forced smile reduces cortisol and increases serotonin.
- Move. Walk around, do a few stretches, shake out your hands.
- Speak. Say something confident aloud, even if it feels silly: "I'm ready for this."

Do these in a bathroom stall, your car, or your home office. Not in the lobby where the interviewer might see you doing a Superman pose.

### Last-Minute Reminders Card

Create a small index card or phone note with these reminders. Read it right before the interview starts.

```
MY INTERVIEW REMINDERS

1. Think aloud. Silence is my enemy.
2. Start with brute force. Optimize after.
3. Ask clarifying questions before coding.
4. Test my code with a small example.
5. If stuck: breathe, draw, try smaller input.
6. It's OK to not know. Show how I think.
7. Be curious, not defensive.
8. Errors happen. Fix them calmly.
9. I have prepared. I am ready.
```


### Junior → FAANG: Interview Morning Routine

A consistent morning routine on interview day primes your cognitive performance. Recommended routine: wake up 2 hours before the first round (not earlier, to avoid fatigue accumulation), eat a normal breakfast (blood glucose stability matters for sustained cognitive function), do 20 minutes of light physical activity (reduces cortisol and increases focus), review 3 key behavioral stories and 2 system design patterns (prime the relevant memory networks), and log in or arrive at the interview location 10-15 minutes early. Avoid intensive study in the morning. The preparation is done and the morning is about execution priming.

### Senior @ FAANG: Morning Launch Sequence as a Professional Performance Ritual

Senior candidates should develop and practice their morning launch sequence in mock interviews until it is a reliable ritual. The specificity matters: not 'do some exercise' but 'a 20-minute walk with no phone'. Not 'review your stories' but 'read the first sentence of each of your 8 behavioral stories to prime the memory trace'. Rituals work because they remove decision-making in high-stakes moments. You execute the sequence without deliberating. Senior engineers who have navigated high-stakes presentations, board meetings, or production incidents often already have personal rituals for these situations. Adapt those rituals for the interview context.

---
