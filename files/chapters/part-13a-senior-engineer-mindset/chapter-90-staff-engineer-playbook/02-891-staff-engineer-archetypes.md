## 90.1 Staff Engineer Archetypes

### The Four Archetypes

Will Larson's foundational book "Staff Engineer" identifies four distinct archetypes that describe how staff engineers operate within organizations. Each archetype represents a different way of creating leverage, and understanding them helps you decide where to focus your energy. Most staff engineers are not purely one archetype but instead blend elements from two or more depending on their team's needs and their own strengths.

```
┌──────────────────────────────────────────────────────────────────┐
│                  STAFF ENGINEER ARCHETYPES                       │
│           (From "Staff Engineer" by Will Larson)                 │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. TECH LEAD                                                    │
│     ├── Closest to team, manages technical approach              │
│     ├── Partners with Engineering Manager                        │
│     ├── ~70% team-focused, 30% cross-team                        │
│     ├── High code involvement                                    │
│     └── Example: Leads architecture for 8-person team            │
│                                                                  │
│  2. ARCHITECT                                                    │
│     ├── Responsible for technical direction of domain            │
│     ├── May span multiple teams                                  │
│     ├── ~30% coding, 70% design and coordination                 │
│     ├── Creates standards and patterns                           │
│     └── Example: Platform architecture across 3 teams            │
│                                                                  │
│  3. SOLVER                                                       │
│     ├── Tackles hardest problems across the org                  │
│     ├── High autonomy, moves to where needed                     │
│     ├── Deep technical expertise                                 │
│     ├── Often works alone or small team                          │
│     └── Example: Fixes critical performance crisis               │
│                                                                  │
│  4. RIGHT HAND                                                   │
│     ├── Extends senior leader's bandwidth                        │
│     ├── Cross-organizational work                                │
│     ├── Strategic projects and initiatives                       │
│     ├── Less technical, more organizational                      │
│     └── Example: Leads org-wide technical strategy               │
│                                                                  │
│  Most Staff engineers blend elements of multiple archetypes      │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Finding Your Fit

Choosing the right archetype is not about picking the one that sounds most impressive but rather the one that aligns with how you naturally work and what energizes you. The checklist below can help you self-assess by reflecting honestly on your preferences and working style. Keep in mind that your archetype may shift over time as your skills evolve and organizational needs change, so treat this as a starting point rather than a permanent label.

```
WHICH ARCHETYPE FITS YOU?

TECH LEAD if:
□ You love being close to a team
□ You want to continue shipping regularly
□ You enjoy mentoring day-to-day
□ You prefer depth over breadth
□ You're energized by team success

ARCHITECT if:
□ You think in systems and patterns
□ You enjoy designing standards
□ You want to influence multiple teams
□ You can balance design with pragmatism
□ You communicate well across groups

SOLVER if:
□ You love diving into hard problems
□ You prefer autonomous work
□ You're comfortable with high ambiguity
□ You want variety in your work
□ You can context-switch effectively

RIGHT HAND if:
□ You're interested in org dynamics
□ You can translate between tech and business
□ You enjoy strategic thinking
□ You're comfortable in meetings
□ You want to multiply leadership impact

NOTE: Your role may evolve. Start as Tech Lead,
      grow into Architect or Solver over time.
```

### Junior → FAANG: Recognizing Archetypes Early to Aim Your Career

Most early-career engineers default to Tech Lead archetype instincts because that is the work that gets praised at senior level: reviewing code, driving a team's sprint, unblocking direct colleagues. Understanding archetypes early lets you make deliberate choices about which skills to develop, rather than drifting into whatever your current team rewards.

If you are drawn to system-wide design problems that no single team owns, invest in architecture skills now: document the systems around your team, identify coupling and hidden dependencies, and practice presenting those findings. If you enjoy parachuting into broken situations and making them better under pressure, seek out on-call rotations, incident command opportunities, and oncall shadowing at other companies. Both paths lead to staff, but through different skills and networks.

Interview tip: early in a FAANG loop, your interviewer is trying to identify which archetype you are. Lead with your strongest archetype when describing your impact. "I rebuilt the observability infrastructure for a platform serving 40 teams" signals Architect. "I drove the Go 1.21 migration across 80 services in six months while keeping all teams unblocked" signals Tech Lead. Know which story you are telling before you walk in.

### Senior @ FAANG: Archetype Fit as an Org Design Signal

At FAANG scale, the distribution of staff archetypes across an organization is an observable engineering health signal. An org with all Tech Leads and no Architects will produce locally optimized systems that create costly cross-team integration problems. An org with all Architects and no Tech Leads will produce excellent documents and few shipped products. A balanced distribution requires deliberate org design: hiring committees, rotation programs, and charter design all influence which archetype can be successful in a given role.

Senior engineers in hiring and calibration committees should evaluate archetype fit explicitly. A brilliant Solver hired into a Tech Lead role will feel constrained and leave. A Tech Lead hired into an Architect role will produce tactical documents when the org needs strategic ones. When a staff engineer's output has been disappointing, the first diagnostic question is often not "are they capable" but "is this the right archetype for this charter."

At the principal level, archetype rigidity becomes a liability. Principal engineers at Google and Amazon are expected to operate across archetypes depending on what the moment requires. They may spend a quarter in Architect mode producing a multi-year platform strategy, then shift to Right Hand mode supporting a VP through an org restructuring, then shift to Solver mode when a production crisis threatens a major product launch. The ability to shift modes deliberately, and to communicate to your manager and peers which mode you are in and why, is a distinguishing characteristic of L7+ engineers.

Governance implication: when chartering a staff engineer role, the job description and reporting structure should be designed around the archetype the organization needs, not the archetype the candidate offers. Many failed staff hires trace back to a mismatch between the archetype the org needed and the archetype the hired engineer excelled at, with neither party having been explicit about the difference.

---
