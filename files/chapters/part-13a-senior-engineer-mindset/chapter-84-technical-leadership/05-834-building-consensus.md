## 84.4 Building Consensus

### The Consensus Spectrum

Building consensus does not mean getting everyone to agree on everything. Different situations call for different levels of involvement from stakeholders. Sometimes you need to simply inform people of a decision you have already made. Other times you need to collaborate deeply and design something together. Being explicit about which mode you are using prevents misunderstandings and sets clear expectations for everyone involved.

```
┌──────────────────────────────────────────────────────────────────┐
│                   CONSENSUS SPECTRUM                             │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  INFORM                                                          │
│  "Here's what we're doing"                                       │
│  Use when: Urgent, minor impact, your domain                     │
│                                                                  │
│  CONSULT                                                         │
│  "Here's my proposal, what do you think?"                        │
│  Use when: You have a strong view, need input                    │
│                                                                  │
│  COLLABORATE                                                     │
│  "Let's design this together"                                    │
│  Use when: Multiple valid approaches, need buy-in                │
│                                                                  │
│  DELEGATE                                                        │
│  "You decide, I'll support"                                      │
│  Use when: It's their domain, empowering others                  │
│                                                                  │
│  Key: Match approach to situation, be explicit about it          │
│                                                                  │
│  "I'd like to consult with you on this decision.                 │
│   I have a proposal, but want your input before proceeding."     │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Handling Disagreement

Disagreement between senior engineers is inevitable and healthy, it means people care about the outcome. The key is to handle disagreement productively rather than letting it devolve into personal conflict or endless debate. The best technical leaders approach disagreements by first seeking to understand the other person's perspective, then finding common ground, and finally proposing objective criteria or experiments to resolve the difference.

```
SCENARIO: You and a colleague disagree on architecture.

WRONG APPROACHES:
- Escalating immediately
- Going around them
- Giving up on your position
- Debating endlessly without progress

RIGHT APPROACH:

1. UNDERSTAND THEIR POSITION
   "Help me understand your concern about approach A"
   "What would success look like from your perspective?"

2. FIND COMMON GROUND
   "We both agree that performance is critical"
   "We both want to minimize operational complexity"

3. MAKE IT ABOUT THE PROBLEM, NOT PEOPLE
   "Let's evaluate both approaches against our requirements"
   Not: "Your idea won't work"

4. PROPOSE EXPERIMENT OR CRITERIA
   "What if we prototype both and measure?"
   "Can we agree on how we'd decide between them?"

5. DISAGREE AND COMMIT
   "I still have concerns, but I'll commit to this approach
   and make it successful. Let's revisit in 3 months."
```

### Junior → FAANG: Consensus vs Unanimity

A gap that shows up repeatedly in mid-level engineer interviews is the confusion between consensus and unanimity. Consensus does not mean everyone agrees. It means everyone has been heard, the reasoning is transparent, and the team can commit to the decision even if some members preferred a different option. Interviewers actively probe for this distinction because engineers who require unanimity become blockers at scale.

When preparing a "building consensus" story for a FAANG loop, choose a case where not everyone agreed at the end. The interesting part of the story is how you ensured that the disagreeing parties still committed to the outcome and what made that commitment genuine rather than forced. That arc: heard, understood, committed even without full agreement, is the narrative structure that resonates with bar-raisers.

Practice the "disagree and commit" framing. "We discussed it, I disagreed with the direction, but I understood the reasoning and committed to making the chosen approach succeed" is a mature answer. "I pushed back until they came around to my view" is a low-collaboration signal.

### Senior @ FAANG: Designing Consensus Processes That Scale

At senior levels, the question is not "how do I build consensus for this decision" but "how do I design a consensus-building process that the organization can run without me for every decision of this type."

This is the governance layer of consensus. It includes: defining which stakeholders must be consulted for which category of decision, establishing timeboxes for consultation (an RFC with no deadline produces no decision), creating explicit escalation paths for irresolvable disagreements, and building the cultural expectation that "disagree and commit" is a respected, first-class outcome rather than a failure mode.

At FAANG, the organizations that make fast decisions at scale have invested heavily in this infrastructure. Google's design doc process, Amazon's six-pager culture, Meta's engineering review boards are all institutionalized consensus mechanisms. The staff engineer who understands this and can articulate how they contributed to building similar infrastructure at their organization is presenting at the right level for L7 bar-raiser evaluation.

One practical tool: the pre-mortem before a decision is finalized. Ask the group "Assume this decision is wrong. What is the most likely reason?" This surfaces hidden concerns faster than any amount of open-ended discussion and gives dissenting voices a structured, non-threatening channel to contribute. Document the concerns and the mitigation plans in the decision record.

---
