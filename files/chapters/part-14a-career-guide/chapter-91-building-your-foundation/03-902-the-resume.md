## 91.2 The Resume

### Resume Fundamentals

Your resume is the single most important document in your job search. It needs to accomplish two things simultaneously: pass through automated ATS filtering software and impress a human reader who will spend roughly twenty seconds deciding whether to keep reading. The structure below has been tested across thousands of engineering applications and consistently performs well at both tasks. Follow the format rules carefully, because even strong content gets rejected when the layout confuses the parser or the reader.

```
┌──────────────────────────────────────────────────────────────────┐
│                    RESUME STRUCTURE                              │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  HEADER                                                          │
│  Name | Email | Phone | LinkedIn | GitHub | Location             │
│                                                                  │
│  SUMMARY (Optional - experienced engineers)                      │
│  2-3 sentences: Who you are, what you do, what you want          │
│                                                                  │
│  EXPERIENCE (60-70% of resume)                                   │
│  Company | Title | Dates                                         │
│  • Achievement with metrics                                      │
│  • Achievement with metrics                                      │
│  • Achievement with metrics                                      │
│                                                                  │
│  SKILLS (Separate section)                                       │
│  Languages: Go, Python, JavaScript                               │
│  Tools: Kubernetes, PostgreSQL, Redis                            │
│  Practices: System Design, CI/CD, Observability                  │
│                                                                  │
│  EDUCATION                                                       │
│  Degree | University | Year (less important with experience)     │
│                                                                  │
│  PROJECTS (Optional - if relevant)                               │
│  Project name - brief description and impact                     │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

FORMAT RULES:
• 1 page for <10 years, 2 pages for 10+ years
• PDF format (preserves formatting)
• Clean, simple design (no graphics, columns)
• Consistent formatting throughout
• Reverse chronological order
```

### Writing Impactful Bullets

The difference between a resume that gets interviews and one that gets ignored often comes down to how you write your bullet points. Most engineers describe what they did, but hiring managers want to know what changed as a result of what you did. The XYZ formula below gives you a repeatable structure for turning everyday work into compelling achievements that stand out in a stack of resumes.

```
THE XYZ FORMULA:
"Accomplished X as measured by Y by doing Z"

BAD BULLETS:
• Worked on the payments team
• Responsible for microservices
• Used Go and Kubernetes

GOOD BULLETS:
• Reduced payment processing latency by 70% (from 500ms to 150ms)
  by redesigning the async pipeline using Go channels and Redis
• Led migration of 15 microservices to Kubernetes, achieving
  99.99% uptime and reducing deployment time from 2 hours to 10 minutes
• Built real-time fraud detection system processing 10M events/day,
  preventing $2M in annual fraud losses

QUANTIFY EVERYTHING:
• Users/customers affected
• Performance improvements (%, ms, etc.)
• Scale (requests/sec, data volume)
• Money (saved, generated, prevented loss)
• Time (saved, reduced)
• Team size (led, mentored)
```

### ATS Optimization

Before any human reads your resume, it almost certainly passes through an Applicant Tracking System that parses the document and scores it against the job description. These systems are surprisingly literal: if the job posting says "distributed systems" and your resume says "scalable architecture," the ATS may not recognize them as the same thing. The tips below will help you format and keyword-optimize your resume so it survives this automated filter and reaches a real person.

```
ATS (Applicant Tracking System) Tips:

1. USE STANDARD SECTION HEADERS
   ✓ Experience, Work Experience
   ✓ Education
   ✓ Skills
   ✗ Career Journey, What I've Done

2. INCLUDE KEYWORDS FROM JOB DESCRIPTION
   If JD says "Go" → Include "Go" (not just "Golang")
   If JD says "distributed systems" → Use that exact phrase

3. SIMPLE FORMATTING
   ✓ Standard fonts (Arial, Calibri, Times)
   ✓ Clear section breaks
   ✗ Tables, columns, graphics
   ✗ Headers/footers with important info

4. SPELL OUT ACRONYMS
   ✓ "Amazon Web Services (AWS)"
   ✓ "Continuous Integration/Continuous Deployment (CI/CD)"

5. TEST YOUR RESUME
   • Copy/paste into plain text - is it readable?
   • Use free ATS checkers online
   • Apply to your own company and check
```

### Sample Go Engineer Resume

Seeing a complete example makes the principles concrete. The following sample resume demonstrates every technique covered in this section: a clear header with all contact links, a concise summary, impact-driven bullet points with metrics, a well-organized skills section, and a clean reverse-chronological layout. Study how each bullet leads with a strong action verb, includes a quantified result, and explains the technical approach used.

```
───────────────────────────────────────────────────────────────────
                         ALEX CHEN
  alex.chen@email.com | (555) 123-4567 | San Francisco, CA
  linkedin.com/in/alexchen | github.com/alexchen
───────────────────────────────────────────────────────────────────

SENIOR SOFTWARE ENGINEER with 6 years experience building
high-scale distributed systems in Go. Expertise in microservices,
real-time systems, and cloud infrastructure.

───────────────────────────────────────────────────────────────────
EXPERIENCE
───────────────────────────────────────────────────────────────────

STRIPE | Senior Software Engineer            | 2022 - Present
San Francisco, CA

• Led redesign of payment routing system handling $50B annually,
  reducing transaction latency by 40% and saving $3M in
  processing fees through intelligent routing optimization

• Built real-time fraud detection pipeline in Go processing
  500K events/second with <10ms p99 latency, reducing fraud
  losses by 25%

• Mentored 4 engineers to promotion, established code review
  standards adopted by 3 teams

UBER | Software Engineer II                  | 2019 - 2022
San Francisco, CA

• Developed core matching algorithm component serving 20M
  rides/day, improving match quality by 15% through ML
  feature integration

• Migrated legacy Python services to Go, achieving 5x
  throughput improvement and 60% infrastructure cost reduction

• Designed and implemented distributed tracing system adopted
  by 50+ services, reducing incident MTTR from 45 to 12 minutes

STARTUP | Software Engineer                  | 2018 - 2019
San Francisco, CA

• Built MVP payment platform processing $5M monthly as
  founding engineer (#4), leading to Series A funding

───────────────────────────────────────────────────────────────────
SKILLS
───────────────────────────────────────────────────────────────────

Languages: Go (primary), Python, SQL, JavaScript
Infrastructure: Kubernetes, AWS, GCP, Terraform, Docker
Databases: PostgreSQL, Redis, Kafka, DynamoDB
Practices: System Design, Microservices, CI/CD, Observability

───────────────────────────────────────────────────────────────────
EDUCATION
───────────────────────────────────────────────────────────────────

B.S. Computer Science | UC Berkeley | 2018
```

### Junior → FAANG: Resume Mistakes That Cost Early-Career Engineers Interviews

The single most common early-career resume mistake is responsibility language instead of impact language. "Worked on backend services," "assisted with database optimization," and "participated in code reviews" tell a hiring manager nothing about what you actually contributed. Every bullet point must answer two questions: what did you do, and what measurably changed as a result. If you cannot answer the second question, the bullet is not ready.

A practical approach: write your current bullets in responsibility language first, then ask yourself "so what?" for each one. The answer to "so what?" is your impact statement. "Implemented caching layer" becomes "implemented Redis caching layer that reduced database load by 60%, allowing the team to defer a planned shard migration by six months." The numbers do not need to be exact, but they need to be in the right order of magnitude and defensible in an interview conversation.

Common format mistakes that trigger ATS rejection: tables, text boxes, columns, headers with logos, and skills sections with proficiency bars. Use a single-column layout with standard section headers. Submit as PDF unless the application explicitly requires a Word document.

### Senior @ FAANG: Resume Architecture for L5-L7 Candidates

At senior and staff level, the resume is not primarily a document for ATS. It is a pre-read for the hiring committee packet. The evaluation frame is scope, influence, and trajectory, not individual technical contributions.

The most effective senior resume organizes each role around three dimensions: technical scope (what systems you were responsible for, at what scale), organizational influence (who you aligned, what decisions you drove or influenced, what teams you unblocked), and trajectory evidence (how your scope grew from the start of the role to the end). A hiring committee reviewing an L6 packet wants to understand not just what this person did, but whether their scope grew over time, and whether it grew because of their own initiative or because their manager expanded their responsibilities.

ADR-style reasoning belongs in the resume at senior level. A bullet point like "Drove architectural decision to decompose monolithic payment service into three bounded-context microservices, reducing per-service deployment time from 40 minutes to 6 minutes and enabling independent team ownership" demonstrates exactly the kind of judgment that separates L5 from L6. It shows problem identification, decision ownership, scope of impact (multiple teams), and a measurable outcome.

At staff level (L7), the resume must answer a different question: not what did you build, but what direction did you set. Bullets that describe multi-quarter roadmaps you authored, engineering org-level technical standards you established, or external-facing technical representations (conference talks, open-source leadership, industry working groups) are the signals that distinguish a staff candidate from a senior candidate with a longer resume.

Resume length at senior level: two pages maximum, with the most recent two roles occupying most of the space. Roles older than seven years should be compressed to company name, title, and dates only unless they contain uniquely relevant signals.

---
