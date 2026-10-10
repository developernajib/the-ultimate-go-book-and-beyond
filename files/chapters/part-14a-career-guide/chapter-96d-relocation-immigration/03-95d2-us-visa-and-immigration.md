## 96D.2 US Visa and Immigration

### Visa Overview for Tech Workers

This section provides a conceptual foundation for Visa Overview for Tech Workers, establishing the terminology and mental model needed to understand the implementation details that follow.
```
┌──────────────────────────────────────────────────────────────────┐
│              COMMON US WORK VISAS FOR TECH                       │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  H-1B: Specialty Occupation                                      │
│  ├── Most common for tech workers                                │
│  ├── Requires bachelor's degree or equivalent                    │
│  ├── Subject to annual lottery (cap)                             │
│  ├── Initial 3 years, extend to 6 years                          │
│  ├── Employer-sponsored and tied to employer                     │
│  └── Can transfer between employers                              │
│                                                                  │
│  L-1: Intracompany Transfer                                      │
│  ├── For employees of multinational companies                    │
│  ├── L-1A: Managers/Executives (7 years max)                     │
│  ├── L-1B: Specialized Knowledge (5 years max)                   │
│  ├── Must have worked for company 1+ year abroad                 │
│  └── No lottery, but specific requirements                       │
│                                                                  │
│  O-1: Extraordinary Ability                                      │
│  ├── For individuals with exceptional achievement                │
│  ├── No cap or lottery                                           │
│  ├── Requires extensive documentation                            │
│  ├── Patents, publications, awards help                          │
│  └── Increasingly used by senior tech talent                     │
│                                                                  │
│  TN: USMCA Professional                                          │
│  ├── For Canadian and Mexican citizens only                      │
│  ├── Specific occupations listed (includes CS)                   │
│  ├── No cap, relatively easy process                             │
│  └── 3-year increments, renewable indefinitely                   │
│                                                                  │
│  E-3: Australian Specialty Occupation                            │
│  ├── For Australian citizens only                                │
│  ├── Similar to H-1B but separate quota                          │
│  ├── Often undersubscribed                                       │
│  └── 2-year increments, renewable                                │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### H-1B Deep Dive

US visa and immigration timelines add significant complexity to job searches for international engineers, requiring careful synchronization of offer timing, cap-subject petition windows, and status transfer procedures. The following overview covers the H-1B, O-1, and EB-1/EB-2 pathways relevant to Go engineers, with realistic timeline expectations.

```
H-1B LOTTERY PROCESS:

TIMELINE:
┌──────────────────────────────────────────────────────────────────┐
│  MARCH 1-18: Registration period opens                           │
│  └── Employer registers you for lottery ($10 fee)                │
│                                                                  │
│  LATE MARCH: Lottery results                                     │
│  └── Selected = can file petition                                │
│  └── Not selected = wait until next year                         │
│                                                                  │
│  APRIL 1 onwards: Filing window                                  │
│  └── Employer files full petition if selected                    │
│                                                                  │
│  PROCESSING: 2-6 months (or 15 days with premium)                │
│  └── Regular processing: $2-6 months                             │
│  └── Premium processing: 15 calendar days ($2,805)               │
│                                                                  │
│  OCTOBER 1: Earliest start date                                  │
│  └── H-1B fiscal year begins                                     │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

LOTTERY STATISTICS (Approximate):
- Annual cap: 85,000 (65,000 regular + 20,000 US master's)
- Registrations: 400,000-800,000+
- Selection rate: ~15-25% (varies by year)

IF NOT SELECTED:
- Try again next year
- Consider O-1 if you qualify
- Consider L-1 through international office
- Consider Canadian office (easier immigration)
- Some universities/research orgs are cap-exempt
```

### Cap-Exempt Employers

Certain employers, primarily universities and affiliated research institutions, are exempt from the annual H-1B visa cap. This means they can sponsor H-1B visas year-round without entering the lottery. Understanding this pathway opens additional options for engineers who do not win the standard lottery.

```
H-1B CAP-EXEMPT EMPLOYERS:

These employers can sponsor H-1B anytime (no lottery):

┌──────────────────────────────────────────────────────────────────┐
│  HIGHER EDUCATION:                                               │
│  ├── Universities and colleges                                   │
│  ├── Related nonprofit research organizations                    │
│  └── Affiliated teaching hospitals                               │
│                                                                  │
│  NONPROFIT RESEARCH:                                             │
│  ├── Research organizations                                      │
│  └── Government research organizations                           │
│                                                                  │
│  EXAMPLES:                                                       │
│  ├── Stanford, MIT, UC Berkeley (university roles)               │
│  ├── Johns Hopkins Applied Physics Lab                           │
│  ├── National Labs (Sandia, LBNL, etc.)                          │
│  └── University-affiliated medical centers                       │
│                                                                  │
│  IMPORTANT NOTES:                                                │
│  ├── Must work FOR the exempt entity                             │
│  ├── Contractors AT universities don't qualify                   │
│  └── Some affiliated entities qualify, verify carefully          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

STRATEGY: If you don't win the lottery, consider:
1. University tech roles (many have software teams)
2. Research positions
3. University-affiliated startups
4. Once you have H-1B, can transfer to private company
```

### O-1 Visa: The Alternative Path

US visa and immigration timelines add significant complexity to job searches for international engineers, requiring careful synchronization of offer timing, cap-subject petition windows, and status transfer procedures. The following overview covers the H-1B, O-1, and EB-1/EB-2 pathways relevant to Go engineers, with realistic timeline expectations.

```
O-1 VISA REQUIREMENTS:

Must demonstrate "extraordinary ability" through evidence:

┌──────────────────────────────────────────────────────────────────┐
│  MEET 3+ OF THESE CRITERIA:                                      │
│                                                                  │
│  □ Awards/prizes for excellence in field                         │
│    (Best paper awards, hackathon wins, etc.)                     │
│                                                                  │
│  □ Membership in associations requiring achievement              │
│    (ACM Fellow, IEEE Senior Member, etc.)                        │
│                                                                  │
│  □ Published material about you in professional media            │
│    (News articles, industry publications featuring you)          │
│                                                                  │
│  □ Judge of others' work                                         │
│    (Conference reviewer, grant reviewer, etc.)                   │
│                                                                  │
│  □ Original contributions of major significance                  │
│    (Patents, widely-used open source, etc.)                      │
│                                                                  │
│  □ Authored scholarly articles                                   │
│    (Academic papers, technical blog with citations)              │
│                                                                  │
│  □ High salary relative to others in field                       │
│    (Top 10% in your occupation)                                  │
│                                                                  │
│  □ Critical/essential role at distinguished organizations        │
│    (Lead engineer at well-known company)                         │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

O-1 ADVANTAGES:
- No lottery, no cap
- Faster processing available
- Can be filed at any time
- Spouses can work (O-3 with separate work authorization)

BUILDING YOUR O-1 PROFILE:
Start collecting evidence now even if you don't need O-1 yet:
- Get your name on patents
- Speak at conferences
- Review for conferences/journals
- Contribute to significant open source projects
- Write technical articles
- Collect press mentions
```

### Green Card Process

US visa and immigration timelines add significant complexity to job searches for international engineers, requiring careful synchronization of offer timing, cap-subject petition windows, and status transfer procedures. The following overview covers the H-1B, O-1, and EB-1/EB-2 pathways relevant to Go engineers, with realistic timeline expectations.

```
EMPLOYMENT-BASED GREEN CARD CATEGORIES:

┌──────────────────────────────────────────────────────────────────┐
│  EB-1: Priority Workers (Fastest)                                │
├──────────────────────────────────────────────────────────────────┤
│  EB-1A: Extraordinary Ability                                    │
│  ├── Self-petition (no employer needed)                          │
│  ├── Similar criteria to O-1 but higher bar                      │
│  └── No labor certification needed                               │
│                                                                  │
│  EB-1B: Outstanding Professors/Researchers                       │
│  ├── Academic positions                                          │
│  └── 3+ years experience, international recognition              │
│                                                                  │
│  EB-1C: Multinational Managers/Executives                        │
│  ├── For L-1A visa holders                                       │
│  └── Manager/executive at multinational                          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  EB-2: Advanced Degree / Exceptional Ability                     │
├──────────────────────────────────────────────────────────────────┤
│  EB-2 with PERM:                                                 │
│  ├── Requires labor certification (PERM)                         │
│  ├── Master's degree or bachelor's + 5 years                     │
│  └── Most common path for software engineers                     │
│                                                                  │
│  EB-2 NIW (National Interest Waiver):                            │
│  ├── Self-petition, no employer needed                           │
│  ├── Must prove work benefits US nationally                      │
│  └── Increasingly used by tech workers                           │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  EB-3: Skilled Workers                                           │
├──────────────────────────────────────────────────────────────────┤
│  ├── Bachelor's degree                                           │
│  ├── Requires PERM labor certification                           │
│  ├── Longer wait times than EB-2                                 │
│  └── Often filed concurrently with EB-2                          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### The PERM Process

PERM (Program Electronic Review Management) labor certification is the first step in the employment-based green card process. The employer must demonstrate that no qualified US worker is available for the position. This process involves advertising the role, documenting the recruitment effort, and filing with the Department of Labor.

```
PERM LABOR CERTIFICATION STEPS:

┌──────────────────────────────────────────────────────────────────┐
│  STEP 1: Prevailing Wage Determination (2-6 months)              │
│  └── DOL determines minimum wage for position/location           │
│                                                                  │
│  STEP 2: Recruitment (2-3 months)                                │
│  └── Employer must prove no qualified US workers available       │
│  └── Job postings, advertisements, interviews                    │
│  └── Document why US applicants weren't qualified                │
│                                                                  │
│  STEP 3: PERM Application Filing                                 │
│  └── Submit ETA-9089 to Department of Labor                      │
│                                                                  │
│  STEP 4: PERM Processing (6-18 months)                           │
│  └── DOL reviews application                                     │
│  └── May be selected for audit (adds 6-12 months)                │
│                                                                  │
│  STEP 5: I-140 Petition (After PERM approval)                    │
│  └── Employer petitions USCIS                                    │
│  └── 6-8 months (or 15 days premium)                             │
│                                                                  │
│  STEP 6: Wait for Priority Date                                  │
│  └── Your "place in line" based on country of birth              │
│  └── India/China: Many years wait                                │
│  └── Rest of World: Usually current                              │
│                                                                  │
│  STEP 7: I-485 Adjustment of Status                              │
│  └── Final step to get green card                                │
│  └── Or consular processing if outside US                        │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

TOTAL TIME (Rest of World): 2-4 years
TOTAL TIME (India, EB-2): 10+ years backlog
TOTAL TIME (China, EB-2): 5-8+ years backlog
```

### Priority Date and Backlogs

Understanding your priority date and the Visa Bulletin is essential for navigating employment-based immigration. Your priority date establishes your official place in line for permanent residency, and backlogs vary dramatically depending on your country of birth and preference category.

```
UNDERSTANDING PRIORITY DATE:

Your priority date = date PERM was filed (or I-140 for EB-1)

This is your "place in line" for a green card.

VISA BULLETIN: Published monthly by State Department
Shows which priority dates are "current" (can file I-485)

EXAMPLE READING (Simplified):
┌──────────────────────────────────────────────────────────────────┐
│  EB-2 Final Action Dates:                                        │
│                                                                  │
│  All Countries Except Listed: Current                            │
│  China: 01 JAN 2020                                              │
│  India: 01 SEP 2012                                              │
│  Mexico: Current                                                 │
│  Philippines: Current                                            │
│                                                                  │
│  WHAT THIS MEANS:                                                │
│  - If you're from UK with priority date of 2024: Can file now    │
│  - If you're from India with priority date of 2024: ~12+ year    │
│    wait (dates only advance ~6-12 months per year)               │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

STRATEGIES FOR LONG BACKLOGS:
1. EB-1 category (no backlog for most countries)
2. NIW (National Interest Waiver) - shorter EB-2 line
3. File EB-2 and EB-3 concurrently (EB-3 may move faster)
4. Consider Canadian PR as backup plan
5. Spouse's country of birth may have shorter line
```

### Changing Jobs on H-1B

US visa and immigration timelines add significant complexity to job searches for international engineers, requiring careful synchronization of offer timing, cap-subject petition windows, and status transfer procedures. The following overview covers the H-1B, O-1, and EB-1/EB-2 pathways relevant to Go engineers, with realistic timeline expectations.

```
H-1B PORTABILITY:

You CAN change jobs while on H-1B:

┌──────────────────────────────────────────────────────────────────┐
│  REQUIREMENTS:                                                   │
│  ├── Currently in valid H-1B status                              │
│  ├── New employer files H-1B transfer petition                   │
│  └── Can start work when transfer petition is FILED              │
│      (don't need to wait for approval)                           │
│                                                                  │
│  TIMELINE:                                                       │
│  ├── New employer files I-129 petition                           │
│  ├── You can start work immediately after filing                 │
│  ├── Processing: 2-6 months (or 15 days premium)                 │
│  └── Premium processing recommended                              │
│                                                                  │
│  RISKS:                                                          │
│  ├── If transfer denied, must return to old employer or leave    │
│  ├── Premium processing reduces this risk                        │
│  └── Ensure no gaps in employment status                         │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

IF YOU HAVE APPROVED I-140:
- You can keep your priority date!
- Even if changing employers
- I-140 must be approved and not revoked
- 180+ days after filing = "portable"
```

### Junior → FAANG: Immigration Timeline Reality for Early-Career Engineers

The H-1B lottery and the green card backlog are the two most significant immigration challenges for early-career engineers at FAANG companies, and both require earlier planning than most engineers expect.

H-1B cap registration opens in March for an October 1 start date. If you are currently on OPT and do not win the lottery, you must bridge to an October start or explore alternative visa paths (O-1, L-1, E-3 for Australians, TN for Canadians and Mexicans). Understanding your options and their timelines before you start a job search eliminates the scenario where you receive an offer you cannot accept within your OPT window.

The green card backlog for engineers born in India or China is the most significant long-term immigration planning factor at FAANG companies. Priority dates for EB-2 and EB-3 categories for Indian-born nationals are often a decade or more behind the current date. This means that a FAANG engineer who starts the green card process at their first job may not be eligible to freely change jobs or start a company without immigration complications for ten to fifteen years. Understanding this before accepting your first FAANG offer is essential for making informed career decisions.

### Senior @ FAANG: Immigration Governance at Senior Level and the PERM/NIW Strategy

At senior level, immigration strategy is a governance topic that requires specialist legal advice integrated with career planning. The two primary green card paths available to senior engineers are PERM-based EB-2/EB-3 (employer-sponsored, dependent on priority date, which can be a decade-long wait for some nationals) and EB-1A/EB-2 NIW (extraordinary ability or national interest waiver, employer-independent).

The NIW and EB-1A paths are realistically available to engineers with strong external profiles: published research, significant open-source contributions, conference speaking history, or documented evidence of extraordinary ability in their field. Senior engineers who have built this kind of external profile have immigration options that are not available to comparably skilled engineers who have worked exclusively in private codebases. This is one of the concrete career benefits of investing in public-facing technical work.

The job change implication for pending green card petitions is the governance concern that most senior engineers encounter at some point. If your I-140 has been approved and is more than 180 days old, you can port your priority date to a new employer's petition under AC-21. However, the portability rules require that the new position be in the same or similar occupational classification, and there are procedural steps that must be executed correctly. Any senior engineer considering a job change with a pending green card should consult an immigration attorney before making any moves.

---
