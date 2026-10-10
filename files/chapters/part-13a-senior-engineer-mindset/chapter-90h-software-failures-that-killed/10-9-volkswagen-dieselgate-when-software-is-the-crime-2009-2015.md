## 90H.9 Volkswagen Dieselgate: When Software Is the Crime (2009-2015)

### The Background

Between 2009 and 2015, Volkswagen Group installed software in approximately 11 million diesel vehicles worldwide
that was specifically designed to detect when the vehicle was undergoing emissions testing and to activate
emissions controls only during those tests. During normal driving, the emissions controls were deactivated or
significantly reduced, causing the vehicles to emit nitrogen oxides (NOx) at levels up to 40 times the legal
limit.

This was not a bug. This was not an oversight. This was a deliberate, engineered defeat device - software
explicitly programmed to cheat regulatory testing.

### The Technical Implementation

The defeat device software was embedded in the engine control unit (ECU). It used multiple signals to determine
whether the vehicle was being driven normally or was undergoing a laboratory emissions test:

**Test Detection Heuristics:**
1. **Steering wheel position:** During the standard emissions test cycle (FTP-75 in the US, NEDC in Europe), the
   steering wheel remains perfectly straight because the vehicle is on a dynamometer (rolling road). The software
   detected the absence of steering wheel movement.
2. **Speed pattern matching:** The emissions test cycle has a precise, predefined speed profile. The software
   compared the vehicle's actual speed pattern against the known test cycle profile.
3. **Duration:** The test cycle has a specific duration. The software tracked the elapsed time.
4. **Barometric pressure and temperature:** Laboratory conditions differ from outdoor driving conditions.
5. **Vehicle speed vs. wheel speed:** On a dynamometer, the front wheels spin while the rear wheels do not.

When the software determined the vehicle was being tested, it activated "Mode 1" - full emissions control. The
vehicle met all regulatory requirements. When the software determined the vehicle was being driven normally on the
road, it activated "Mode 0" - reduced or disabled emissions control. This dramatically improved fuel economy and
engine performance while producing illegal levels of NOx.

### The Discovery

The scheme was uncovered by researchers at West Virginia University (WVU) who were conducting an independent
study of diesel vehicle emissions for the International Council on Clean Transportation (ICCT):

- In 2013, WVU researchers used portable emissions measurement systems (PEMS) to measure the real-world
  emissions of three diesel vehicles, including a VW Jetta and a VW Passat.
- The laboratory emissions tests showed the vehicles met regulatory limits.
- The real-world driving tests showed NOx emissions 15 to 35 times higher than the laboratory results.
- The researchers published their findings in May 2014.
- The California Air Resources Board (CARB) and the EPA began investigating.
- Volkswagen initially claimed the discrepancy was due to "technical issues" and "unexpected in-use conditions."
- In September 2015, after more than a year of investigation and increasing pressure, Volkswagen admitted that
  the software was designed to cheat emissions tests.

### Volkswagen's Reaction

The revelation triggered the largest corporate scandal in automotive history:

- VW CEO Martin Winterkorn resigned on September 23, 2015, five days after the EPA's public notice. He was later
  charged with fraud and conspiracy by US prosecutors.
- Several VW engineers and managers were arrested and charged. Engineer James Liang was sentenced to 40 months in
  prison. Manager Oliver Schmidt was sentenced to 7 years in prison.
- Volkswagen's stock price fell by approximately one-third in the days following the disclosure, wiping out
  approximately $30 billion in market value.
- In total, Volkswagen has paid more than $33.3 billion in fines, penalties, civil settlements, and vehicle
  buyback costs.
- The scandal extended beyond VW - Audi, Porsche, and other VW Group brands were affected. Other manufacturers
  were also found to have used various forms of defeat devices or emissions test optimization.

### The Resolution

1. **Vehicle recalls and buybacks:** VW offered to buy back or fix approximately 500,000 affected vehicles in
   the US alone. Globally, 11 million vehicles required software updates or hardware modifications.
2. **Criminal prosecutions:** Multiple VW employees were criminally charged. Winterkorn was indicted by US
   prosecutors but has not been extradited from Germany.
3. **Regulatory changes:** Emissions testing procedures were reformed. The EU introduced Real Driving Emissions
   (RDE) testing that measures emissions on public roads using portable equipment, making defeat devices much
   harder to deploy.
4. **Environmental remediation:** VW was required to invest $2 billion in zero-emission vehicle infrastructure
   and $2.7 billion in environmental mitigation projects.
5. **Corporate restructuring:** VW overhauled its governance structure and compliance programs.

### The Ethics Dimension

Dieselgate is unique among the incidents in this chapter because the software functioned exactly as designed.
There was no bug, no race condition, no overflow. The software was deliberately engineered to deceive regulators
and the public. This raises questions that every software engineer must confront:

**What should an engineer do when asked to write unethical code?**

The engineers who implemented the defeat device software were not freelancing - they were following management
directives. But the Nuremberg defense ("I was just following orders") does not hold in engineering ethics any more
than it does in other domains. Engineers have a professional and moral obligation to refuse to participate in
activities that deceive regulators, endanger public health, or violate the law.

**The duty to refuse:**
- Professional engineering codes of ethics (IEEE, ACM, NSPE) all include provisions requiring engineers to
  prioritize public welfare over employer directives.
- In many jurisdictions, whistleblower protections exist specifically for employees who report illegal activities.
- An engineer who implements a defeat device is not a victim of management pressure - they are a participant in
  fraud.

**The duty to report:**
- If an engineer discovers that existing software contains a defeat device or other fraudulent functionality,
  they have an obligation to report it - first internally, and if internal channels fail, to regulators.
- The VW defeat device was known to dozens of engineers for years. Any one of them could have reported it.

### What Engineers Should Do

1. **Document everything.** If you are asked to implement functionality that appears to be a defeat device,
   deceptive, or illegal, document the request in writing.
2. **Refuse in writing.** State clearly, in writing, that you believe the requested functionality violates
   regulations, ethical standards, or the law.
3. **Report internally.** Use the company's compliance hotline, ethics board, or legal department. Document
   your report.
4. **Report externally if necessary.** If internal reporting does not result in correction, report to the
   relevant regulatory agency. Consult a lawyer about whistleblower protections before doing so.
5. **Leave if necessary.** If the company continues to pursue illegal or unethical software, leave the
   company. No job is worth criminal prosecution or professional disgrace.

### Engineering Lessons

1. **Software can be a weapon of fraud.** The same programming skills used to build beneficial software can be
   used to build deceptive software. Engineers must evaluate the ethical implications of what they build.
2. **"I was just following orders" is not a defense.** Engineers who implement known-fraudulent functionality are
   criminally liable. Several VW engineers went to prison.
3. **Detection is inevitable.** Defeat devices, data manipulation, and other software fraud will eventually be
   discovered. The question is not "if" but "when."
4. **Regulatory testing must be unpredictable.** If the test procedure is known and fixed, software can be
   designed to detect it. Real-world testing with portable equipment and randomized procedures is essential.
5. **Culture determines ethics.** VW's culture prioritized performance metrics and market dominance over
   compliance and ethics. When the culture rewards results regardless of methods, fraud becomes predictable.
   Building an ethical engineering culture is a leadership responsibility.

---

### Junior → FAANG: Engineering Ethics as an Interview Competency

FAANG behavioral interviews routinely include ethics questions: "Tell me about a time you disagreed with a decision on ethical or quality grounds" or "What would you do if you were asked to implement something you believed was harmful?" The Volkswagen incident provides the most unambiguous possible framing: engineers who implement known-fraudulent functionality are criminally liable, and "I was following orders" is not a legal defense. For the interview, the answer structure is: I would document the request in writing, state my objection in writing, escalate through internal compliance channels, and if none of those resolved the issue, report to the relevant regulatory authority and consult a lawyer about whistleblower protection. The key interview insight: this is not a hypothetical process you are describing theoretically. It is a concrete, practiced response to a concrete risk. The fact that you have thought through the steps in advance is itself the signal the interviewer is looking for.

### Senior @ FAANG: Ethical Engineering Culture as a Staff Engineer Organizational Contribution

At L6, the Volkswagen incident is a failure of organizational culture, not a failure of individual engineers. Dozens of engineers knew about the defeat device. The culture created conditions where implementing fraudulent functionality was the path of least resistance: delivery pressure, management authority, and the normalization of "we've done it before and nothing happened" combined to suppress the ethical objections of individual contributors. At staff level, your organizational contribution includes shaping the engineering culture so that ethical concerns propagate to decision-makers rather than being suppressed. This requires three specific mechanisms. First, psychological safety: engineers must be able to raise concerns without fear of retaliation, which requires leadership to demonstrate visibly that concern-raising is valued and not penalized. Second, escalation paths: when a concern is raised and not resolved at the team level, there must be a clear path to a higher authority (ethics board, legal, CTO) that does not require the engineer to go outside the company first. Third, code review as an ethics gate: in domains where software can have significant external consequences (health, finance, environmental compliance, safety systems), code review must include an explicit ethics check alongside the technical review. "Does this code do what the product requirement says it does, and does what it does comply with applicable regulations?" is a code review question, not just a legal question.

The bar-raiser interview question at the staff level is not "what would you do if asked to implement fraudulent code?" It is "how do you build a team culture where no engineer would feel compelled to implement fraudulent code in the first place?" The answer to that question is the organizational design work described above: psychological safety, clear escalation paths, and ethics as a first-class code review criterion.

---

