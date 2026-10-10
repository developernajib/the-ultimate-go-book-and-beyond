# Chapter 83C: Mock Interviews - Complete Practice Sessions

> *"You don't rise to the level of your goals. You fall to the level of your practice."*
> - James Clear

The difference between engineers who pass FAANG interviews and those who don't is rarely raw intelligence or years of experience. It is practice - specifically, deliberate practice that simulates real interview conditions with real time pressure, real ambiguity, and real evaluation criteria. Reading about interviews is to passing interviews what reading about swimming is to crossing the English Channel. You must get in the water. You must feel the panic of a blank whiteboard, the awkward silence when you're stuck, the time pressure of a ticking clock, and you must learn to perform anyway.

This chapter provides complete mock interview scripts - not outlines, not summaries, but full practice sessions you can run alone or with a partner. Each mock interview includes the exact problem statement an interviewer would read, the timeline you should follow, the complete solution with Go code, the follow-up questions interviewers actually ask, and the scoring rubric hiring committees use. When you practice with these scripts, you are not approximating an interview - you are doing one, minus the laptop camera and the recruiter's scheduling email.

The mock interviews in this chapter are calibrated to specific companies and levels. Google-style coding interviews emphasize algorithmic elegance and edge case handling. Meta-style interviews favor speed and working code over theoretical optimality. Amazon-style interviews weave leadership principles into technical discussions. The system design interviews are tiered by level: L4/L5 candidates face bounded problems with clear requirements, while L6/Staff candidates face open-ended problems where the ability to drive ambiguity, make trade-offs, and identify what matters most is the primary signal. The behavioral interviews follow the STAR format and map directly to the leadership principles and cultural values that hiring committees evaluate.

Every problem in this chapter has been selected because it tests multiple skills simultaneously - exactly as real interviews do. A coding problem is never just about getting the right answer. It tests your ability to communicate, manage time, handle edge cases, and respond to hints. A system design problem is never just about drawing boxes. It tests your ability to estimate, prioritize, and make principled trade-offs under uncertainty. A behavioral question is never just about telling a story. It tests your self-awareness, your values, and your ability to reflect honestly on your own performance.

**What you'll learn in this chapter:**

- How to structure self-practice and peer-practice sessions for maximum learning
- Four complete mock coding interviews with realistic problems, timing, and evaluation
- Three complete mock system design interviews calibrated to different seniority levels
- Two complete mock behavioral interviews covering leadership, conflict, and failure
- A Go-specific technical deep dive simulating a senior engineer screen
- Self-assessment scorecards you can use to track your readiness over time
- The specific signals that move candidates from "Lean Hire" to "Strong Hire"

**How to use this chapter:**

Start with Section 83C.1 to understand the practice methodology. Then work through the mock interviews in order - they are sequenced from lower to higher difficulty. For coding interviews, set a real 45-minute timer, write code in a plain editor (not an IDE with autocomplete), and do not look at the solution until time expires. For system design, speak your answers aloud - even if alone - because the ability to articulate your design is half the evaluation. For behavioral interviews, write out your STAR stories before practicing delivery. After each mock, score yourself using the provided rubric, identify your weakest area, and focus your next practice session there. Repeat each mock at least twice with a one-week gap between attempts.

**Prerequisites:** Completion of Chapters 79-82 (Technical Interview Prep, System Design Interviews, Behavioral Interviews, and Negotiation). Familiarity with Go concurrency primitives, standard library data structures, and basic distributed systems concepts.


### Junior → FAANG: Getting the Most from Mock Interviews

Mock interviews are the single most effective preparation activity because they simulate the real constraints: time pressure, think-aloud narration, and another person evaluating your reasoning. Reading about interview techniques is not the same as practicing under realistic conditions. The common mistake is doing too few mocks or doing them in a low-fidelity way (no time pressure, no real feedback). Aim for at least 5 full mock interviews before the real loop, with at least two conducted with people who have interviewed at your target level.

### Senior @ FAANG: Mock Interview Programs as a Calibration Infrastructure

Senior candidates should treat mock interviews as a calibration infrastructure rather than a rehearsal activity. The goal is not to confirm that you are ready but to identify the specific gaps between your current performance and the target bar. This requires honest feedback from interviewers who know what the target bar looks like. For L6 preparation, ideal mock interviewers are engineers who have conducted L6 interviews at FAANG companies and can give you a calibrated score ('this answer is L5 scope, you need an L6 story here'). If you do not have access to these people, use platforms like Interviewing.io or Pramp, which pair you with engineers from target companies. After each mock, spend as much time reviewing the feedback as you spent in the mock itself: the reflection is where the calibration happens.

---
