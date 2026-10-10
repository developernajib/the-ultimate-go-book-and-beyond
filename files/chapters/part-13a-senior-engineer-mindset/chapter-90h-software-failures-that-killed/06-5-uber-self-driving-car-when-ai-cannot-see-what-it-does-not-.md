## 90H.5 Uber Self-Driving Car: When AI Cannot See What It Does Not Expect (2018)

### The Background

On March 18, 2018, at approximately 9:58 PM, an Uber self-driving test vehicle - a modified Volvo XC90 SUV
operating in autonomous mode - struck and killed Elaine Herzberg as she walked her bicycle across a road in
Tempe, Arizona. Herzberg was crossing Mill Avenue outside of a marked crosswalk. She became the first known
pedestrian killed by an autonomous vehicle.

The vehicle was equipped with lidar, radar, and camera systems. A human safety driver, Rafaela Vasquez, was
seated in the driver's seat but was not monitoring the road at the time of the crash. Dashcam footage later
showed Vasquez looking down at her phone (streaming a television show) in the seconds before the impact.

### The Technical Root Cause

The National Transportation Safety Board (NTSB) investigation revealed multiple layers of failure in Uber's
self-driving system (known internally as ATG - Advanced Technologies Group):

**Classification Failure:** The vehicle's perception system detected Herzberg approximately 5.6 seconds before
impact. However, the system could not consistently classify what it was seeing. Over the final 5.6 seconds:

1. At 5.6 seconds before impact, the system classified the object as a **vehicle**.
2. At 5.2 seconds, it reclassified the object as **unknown**.
3. At 4.2 seconds, it reclassified as a **vehicle** again.
4. At 3.8 seconds, it reclassified as **unknown** again.
5. At 2.6 seconds, it reclassified as a **bicycle**.
6. At 1.5 seconds, it reclassified as **unknown** yet again.

The system oscillated between classifications because Herzberg was walking her bicycle next to her - a
configuration the perception system had not been adequately trained to recognize. She was not a pedestrian
(walking without a bicycle), not a cyclist (riding a bicycle), and not a vehicle. She was a person walking
alongside a bicycle - a common but apparently untrained scenario.

**No Prediction Without Classification:** Critically, every time the system reclassified the object, it
**discarded the previous prediction of the object's trajectory** and started a new prediction from scratch.
The system could not maintain a consistent track of the object across classification changes. Each reclassification
reset the trajectory prediction, meaning the system never accumulated enough tracking history to predict that the
object was on a collision course.

**Jaywalking Not Modeled:** The system's pedestrian detection model was not designed to handle pedestrians outside
of crosswalks. The software had been built with an implicit assumption that pedestrians would be located near
crosswalks or on sidewalks. A pedestrian crossing a multi-lane road outside of a crosswalk was, in effect, an
unmodeled scenario.

**Emergency Braking Disabled:** Uber had disabled the Volvo's built-in automatic emergency braking (AEB) system
to prevent conflicts with the autonomous driving system. Uber's own system also had its emergency braking
functionality disabled at the time. The reason: the system had been generating too many false positive emergency
braking events, causing uncomfortable hard stops. Rather than fix the false positive rate, Uber disabled
emergency braking and relied on the human safety driver to intervene. This meant the vehicle had **no automated
emergency braking capability whatsoever** - neither the Volvo's native system nor Uber's.

**Inadequate Safety Driver Monitoring:** Uber's safety protocol required the human safety driver to continuously
monitor the road and be ready to take immediate control. However, there was no system to monitor whether the
safety driver was actually paying attention. Vasquez was watching a television show on her phone.

### Uber's Reaction

- Uber immediately suspended all self-driving testing nationwide.
- Uber cooperated with the NTSB investigation.
- In March 2020, the safety driver Rafaela Vasquez was charged with negligent homicide. She pleaded guilty to a reduced charge of endangerment in
  July 2023 and was sentenced to three years of supervised probation.
- Uber settled with Herzberg's family out of court. The terms were not disclosed.
- Uber sold its ATG self-driving unit to Aurora Innovation in December 2020 for approximately $4 billion (a
  significant loss on the estimated $7.5 billion Uber had invested in the unit).
- The incident led to increased regulatory scrutiny of autonomous vehicle testing and new safety requirements
  in several states.

### Resolution

The NTSB's final report, published in November 2019, identified the following contributing factors:

1. Uber ATG's inadequate safety risk assessment procedures
2. The vehicle operator's failure to monitor the driving environment
3. Uber ATG's lack of mechanisms to monitor operator attentiveness
4. Uber ATG's decision to disable the Volvo's automatic emergency braking system
5. Uber ATG's perception system's inability to classify the pedestrian

The NTSB recommended that autonomous vehicle developers implement:
- Effective safety risk management processes
- Mechanisms to monitor human safety drivers
- Methods to ensure safety-critical systems (like emergency braking) cannot be unilaterally disabled

### How It Could Have Been Prevented

1. **Object tracking should be classification-independent.** The perception system should maintain a consistent
   track of detected objects regardless of their current classification. An object moving toward the vehicle at
   pedestrian speed is a collision threat regardless of whether it is classified as a pedestrian, cyclist, or
   unknown.
2. **Never disable safety systems.** If emergency braking has too many false positives, fix the false positive
   rate. Do not disable the system entirely.
3. **Assume the unexpected.** Pedestrians will not always be at crosswalks. Children will run into roads. Debris
   will appear in traffic lanes. A safety-critical perception system must handle scenarios that are not in the
   training data.
4. **Monitor the monitors.** If human safety drivers are a safety layer, their attention must be verified
   continuously. Driver monitoring systems using eye-tracking cameras are standard in modern autonomous vehicle
   programs.
5. **Defense in depth for autonomous vehicles.** The vehicle should have had multiple independent emergency
   stopping mechanisms: the autonomous system's AEB, the Volvo's native AEB, and the human safety driver.
   All three were disabled or inattentive.

### Engineering Lessons

1. **Classification changes must not reset tracking.** When a perception system reclassifies an object, the
   tracking history and trajectory prediction must be preserved. The physical object did not change - only the
   system's label for it did.
2. **False positive reduction, not safety system removal.** When a safety system generates too many false
   alarms, the engineering response is to improve the system's precision, not to disable it. Disabling
   emergency braking to avoid inconvenience is a direct path to fatalities.
3. **Model the unexpected.** Training data for safety-critical AI systems must include edge cases, unusual
   configurations, and scenarios that violate the system's assumptions. "Pedestrian with bicycle outside
   crosswalk" should have been a standard test case.
4. **Human backup requires human monitoring.** If humans are a safety layer, their alertness must be
   continuously verified. An unmonitored human is not a safety layer - they are a liability.
5. **Safety layers must be independent.** If the failure of one system (autonomous driving) can disable another
   system (emergency braking), they are not independent layers - they are a single point of failure.

---

### Junior → FAANG: AI Safety and Graceful Degradation as Interview Topics

The Uber incident introduces a failure class specific to AI and ML systems: classification uncertainty that disrupts tracking continuity. The system oscillated between classifications every second because it encountered an input (person walking bicycle) that fell between training categories. Each reclassification reset the trajectory prediction, so the system never accumulated enough tracking history to predict a collision. For FAANG interviews, this is the answer to "how do you handle uncertainty in a classification system?" The correct pattern separates tracking (physics-based, continuous, classification-independent) from classification (ML-based, probabilistic). The physical track of the object continues uninterrupted regardless of what the classifier says it is. Classification informs the response policy (how aggressively to brake), but does not reset the track. The second lesson for interviews: disabling a safety system because it has too many false positives is not an engineering decision, it is an ethical failure. The engineering decision is to improve the precision of the system until the false positive rate is acceptable, even if that takes longer than the business timeline allows.

### Senior @ FAANG: Safety System Governance and Unmodeled Scenario Coverage as Platform Standards

At L6, the Uber incident reveals two organizational failures that require platform-level responses. The first is safety system modification governance. Uber's engineering team disabled the Volvo's built-in AEB because it conflicted with their autonomous driving system. Disabling a safety system in a vehicle that operates on public roads should require a documented safety case reviewed by an independent safety board, not a local engineering decision. At staff level, for any system where failure causes harm (not just service disruption), you establish a safety system modification protocol: any change that removes or reduces a safety control requires a formal safety impact analysis, sign-off from an independent reviewer, and documentation of the compensating controls that replace the removed safety. This protocol makes it structurally difficult to disable safety features for convenience, which is the exact decision that killed Elaine Herzberg.

The second failure is unmodeled scenario coverage. Uber's training data did not include a person walking a bicycle outside a crosswalk. For any ML system in a safety-critical context, your production readiness process must include a coverage analysis: what scenarios exist in the real world that are not represented in the training data, and what is the system's behavior for each? For autonomous vehicles, "person with bicycle outside crosswalk" is an obvious gap. For medical imaging AI, "artifact from a specific scanner model" may be a gap. For fraud detection, "transaction pattern from a newly launched product" is a gap. The coverage analysis is not exhaustive by definition, but it must be systematic: structured by domain experts who understand the environment where the system will operate, not just by data scientists who understand the training distribution. At staff level, you define the process for coverage analysis as part of the ML system's production readiness review, with explicit criteria for what constitutes acceptable coverage before deployment.

