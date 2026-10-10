## 83G.4 The First 5 Minutes: Setting the Tone

Research on first impressions is clear: people form judgments within 7 seconds and spend the rest of the interaction confirming those judgments. In technical interviews, the first 5 minutes set the tone for the entire session. A strong start builds interviewer goodwill that carries you through rough patches later. A weak start creates a deficit you'll spend the rest of the interview trying to overcome.

### Making a Strong First Impression

**Virtual:** Camera on. Smile. Make "eye contact" by looking at the camera (not the screen). Ensure your audio and video are working before the interviewer joins. When they appear, greet them warmly.

**In-person:** Stand up when they enter. Firm handshake (match their pressure). Smile. Make eye contact. Walk to the whiteboard or desk with purpose.

**Both:** Use their name. "Hi Sarah, great to meet you." People respond positively to hearing their own name. It signals that you are paying attention and engaged.

### The Perfect Self-Introduction (30 Seconds)

Most interviews begin with "Tell me about yourself." This is not an invitation to recite your resume. It is your chance to frame the conversation. Keep it under 30 seconds.

**The Formula:**

```
[Current role] + [Relevant experience] + [Why you're here] + [Enthusiasm]
```

**Example for a Go developer:**

> "I'm currently a backend engineer at [Company], where I've spent the last three years building distributed services in Go --- things like our real-time event processing pipeline that handles about 200K events per second. Before that, I was at [Previous Company] working on API infrastructure. I'm really excited about this role because [specific reason related to the team/product], and I think my experience with high-throughput Go systems maps well to what you're building."

**What to Say:**
- Specific, quantified accomplishments ("200K events per second")
- Direct connection to the role you are interviewing for
- Genuine enthusiasm about the opportunity

**What NOT to Say:**
- "Well, I graduated from [University] in [year] and then I..." (too far back, not relevant)
- "I'm a full-stack developer who knows a little of everything." (too vague, no signal)
- "I'm really nervous, sorry." (understandable but sets a negative frame)
- A 3-minute monologue about your career history (too long, interviewer zones out)

### Reading the Interviewer's Style and Adapting

Within the first 2 minutes, you should identify which type of interviewer you are dealing with:

**The Guide:** Gives hints, asks leading questions, smiles encouragingly. With this interviewer, think aloud freely --- they will steer you if you go off track.

**The Observer:** Sits back, takes notes, gives minimal feedback. With this interviewer, do not interpret silence as disapproval. They are giving you space to work. Think aloud, but do not seek validation after every statement.

**The Challenger:** Pushes back on your ideas, asks "Why not X instead?" This is not hostility. They are testing how you defend technical decisions. Stay calm, explain your reasoning, and acknowledge when their suggestion is better.

**The Clock-Watcher:** Focused on pace, may say "Let's move on" or "Can you code that up now?" With this interviewer, be concise. Skip lengthy explanations and get to the code.

### Establishing Rapport Quickly

Interviewers are humans. They have been in interviews all day. They are tired. They would rather talk to someone pleasant than someone robotic.

Quick rapport builders:
- "I saw that your team recently launched [feature]. That's really impressive."
- "I noticed you've been at [Company] for [X years]. What keeps you here?"
- "Are you based in [city]? I've heard great things about the office there."

Keep it brief --- 15-30 seconds. Do not force it. If the interviewer is all business, match their energy.

### Asking the Right Clarifying Questions

The single most impactful thing you can do in the first 5 minutes of a coding interview is ask good clarifying questions. This signals experience, thoroughness, and communication skills. Jumping straight into coding signals inexperience.

**Always ask:**

1. **Input constraints.** "What's the expected size of the input? Are we talking about hundreds of elements or millions?"
2. **Edge cases.** "What should I return for an empty input? What about nil?"
3. **Duplicates.** "Can there be duplicate values? How should I handle them?"
4. **Sorting.** "Is the input sorted? Can I assume any ordering?"
5. **Data types.** "Are we working with integers only, or could there be floats?"
6. **Return type.** "Should I return the values themselves, or their indices?"
7. **Optimization priority.** "Should I optimize for time or space?"

**What to Say:**
> "Before I start coding, let me make sure I understand the problem. We're given [restate problem]. Can I clarify a few things?"

**What NOT to Say:**
> "OK, I think I know what to do." (proceeds to code without clarifying)
> "Is this a dynamic programming problem?" (reveals you're trying to pattern-match, not understand)

### The Confidence/Humility Balance

The ideal interview persona sits exactly between confidence and humility. Too much confidence and you seem arrogant or unwilling to take feedback. Too much humility and you seem unsure of yourself.

```
TOO HUMBLE                   JUST RIGHT                    TOO CONFIDENT
─────────────────────────────────────────────────────────────────────────
"I'm not sure if          "Let me walk you through      "Obviously the answer
this is right..."          my thinking on this..."        is binary search."

"Sorry, I'm                "I'm going to start           "I don't need to think
probably wrong, but..."    with brute force and           about this, it's
                           optimize from there."           straightforward."

"I don't think I           "I haven't seen this           "I can solve anything
can solve this."           exact pattern before,           you throw at me."
                           but it reminds me of..."

"Can you tell me          "I want to make sure           "I already know
the answer?"               I understand the                everything about
                           requirements."                  this problem."
```


### Junior → FAANG: Setting the Tone in the First 5 Minutes

The first 5 minutes of an interview round establishes the interviewer's initial impression, which is difficult to reverse. Be concise and clear in your self-introduction (30-45 seconds, covering your current role, your most relevant recent project, and why you are excited about the role). Ask 1-2 targeted clarifying questions at the start of a coding or design problem to demonstrate that you do not jump to solutions before understanding the problem. Maintain an engaged, curious tone: interviewers respond well to candidates who appear genuinely interested in the problem.

### Senior @ FAANG: First 5 Minutes at the Senior Level: Establishing Peer Credibility

At the senior level, the first 5 minutes are about establishing peer credibility with the interviewer, who is likely a senior or staff engineer themselves. The self-introduction should briefly mention the scale and complexity of your most recent senior-level work: 'I've been leading the infrastructure migration for a service handling 50k RPS, which required a careful incremental approach to avoid downtime'. This level of specificity signals immediately that you operate at the right scope. The clarifying questions at the start of a system design problem should demonstrate that you think at the right level: not just 'what are the functional requirements?' but also 'what is the consistency requirement for the user data, and is this a global system or geographically constrained?'. These questions signal L6 thinking in the first 2 minutes.

---
