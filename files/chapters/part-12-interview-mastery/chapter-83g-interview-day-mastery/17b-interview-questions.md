## 83G.17 Interview Questions

Five FAANG-style questions on interview day execution and mindset.

### Q1 (Google): What should the first 5 minutes of a coding interview look like?

**Answer:** Greet, confirm format and time, then read the problem aloud in your own words to confirm understanding. Ask 2-4 clarifying questions about input bounds, edge cases (empty, negative, duplicates), output format, and assumptions about uniqueness or ordering. State 2-3 example inputs and walk through expected outputs. Only then propose an approach. Skipping clarification is the most common cause of misread problems and wasted time.

### Q2 (Amazon): How do you recover when you get stuck mid-problem and 15 minutes have passed without progress?

**Answer:** Verbalize where you are: "I have approach X but it fails on case Y. Let me consider whether the data structure is wrong or the algorithm is wrong." Switch to a brute force if you have not stated one, and ask whether optimizing or moving on is preferred. Interviewers reward calm recovery and structured thinking over silent panic. Asking for a hint with a specific framing ("I am between approach A and B because of trade-off C") signals seniority, not weakness.

### Q3 (Meta): What is the right way to handle a system design question when you do not know the canonical answer?

**Answer:** Anchor on requirements gathering: functional, non-functional, scale, and constraints. Then derive a design from first principles using known building blocks (load balancer, cache, queue, primary/replica DB, CDN). Compute capacity math out loud (QPS, storage, bandwidth) so the interviewer sees your reasoning. Pick one sub-system to deep-dive based on what you know best. Lacking a canonical answer is fine. lacking a structured approach is not.

### Q4 (Netflix): How do you handle a behavioral question when your best story does not perfectly fit the prompt?

**Answer:** Reframe: take 10 seconds to map the prompt to the dimension being tested (ownership, conflict, ambiguity), then pick the story that shows that dimension most strongly even if the surface details differ. Bridge with one sentence: "this is not a customer-facing example, but it shows the same trade-off between speed and rigor." Avoid forcing a poor-fit story. senior interviewers reward self-awareness and clear narrative over exact prompt match.

### Q5 (Apple): What do you do in the 30 minutes before a virtual onsite to peak at the right time?

**Answer:** Test the camera, mic, and shared editor 30 minutes early. Have water, paper, and pen ready. Do a 5-minute warm-up problem to load working memory (LeetCode easy, not new). Review your story bank index card, not the full stories. Avoid heavy meals and caffeine spikes. Do 2 minutes of box breathing to lower heart rate. Walk in calm and curious, not over-rehearsed. cognitive load drops when you trust your prep.


### Junior → FAANG: Interview Day Mastery Practice Questions

The interview day mastery practice questions focus on execution, not technical content. Questions include: 'walk me through your between-round reset protocol', 'what is your response when you are completely stuck on a coding problem', 'how do you handle a behavioral question where you do not have a relevant story'. Practice answering each of these out loud, because interview day execution skills are built through verbal practice, not reading.

### Senior @ FAANG: Interview Day Questions as Execution System Validation

Senior candidates should use these questions to validate their execution system, not their technical knowledge. The execution system is the set of protocols, habits, and responses that operate during the interview without deliberate thought. Validating the system requires running it in realistic conditions: mock interviews with real time pressure, real recording, and real feedback. If the execution system has gaps (you do not have a clear getting-stuck protocol, your between-round reset is undefined), address them with deliberate practice before the real loop.
