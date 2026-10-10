## 91.12 ATS Deep Dive: Getting Past the Robots

### How ATS Systems Actually Work

Most engineers have heard of ATS systems but few understand what actually happens when they submit a resume. The system does not simply search for keywords. It follows a multi-step pipeline that parses your document structure, matches against the job description, applies hard filters, and then ranks surviving candidates by score. Understanding each step in this pipeline lets you optimize your resume strategically rather than guessing at what might work.

```
┌───────────────────────────────────────────────────────────────────┐
│                    ATS PROCESSING PIPELINE                        │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  STEP 1: PARSING                                                  │
│  ├── Extract text from document                                   │
│  ├── Identify sections (experience, education, skills)            │
│  ├── Parse dates, titles, companies                               │
│  └── Handle formatting (PDFs can be problematic)                  │
│                                                                   │
│  STEP 2: KEYWORD MATCHING                                         │
│  ├── Compare resume keywords to job description                   │
│  ├── Weight required vs. preferred skills                         │
│  ├── Check for exact matches and synonyms                         │
│  └── Calculate "match score"                                      │
│                                                                   │
│  STEP 3: FILTERING                                                │
│  ├── Apply minimum qualifications filters                         │
│  ├── Years of experience requirements                             │
│  ├── Education requirements                                       │
│  └── Location/visa requirements                                   │
│                                                                   │
│  STEP 4: RANKING                                                  │
│  ├── Score candidates by match percentage                         │
│  ├── Prioritize based on company preferences                      │
│  ├── Surface top candidates to recruiter                          │
│  └── Remaining stay in database for future                        │
│                                                                   │
│  COMMON ATS SYSTEMS:                                              │
│  • Greenhouse (startups, tech)                                    │
│  • Workday (enterprise)                                           │
│  • Lever (tech companies)                                         │
│  • iCIMS (large companies)                                        │
│  • Taleo (Oracle companies)                                       │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### ATS Optimization Checklist

This checklist covers every aspect of ATS optimization, from file format and fonts to keyword placement and date formatting. Work through it methodically for each version of your resume before submitting an application. Even small formatting mistakes, like putting your name in the header or using a two-column layout, can cause the ATS to misparse your resume and reject you before a human ever sees it.

```markdown
# Complete ATS Optimization Guide

## FILE FORMAT:
✓ Use PDF (most ATS-friendly now)
✓ Use .docx as backup option
✗ Avoid: Designs made in Canva/InDesign
✗ Avoid: Scanned images

## FORMATTING:
✓ Standard fonts (Arial, Calibri, Times New Roman)
✓ Font size 10-12pt
✓ Clear section headers
✓ Simple bullet points (•, -, *)
✗ Avoid: Tables for layout
✗ Avoid: Columns (can scramble text)
✗ Avoid: Graphics, icons, images
✗ Avoid: Headers/footers with important info

## SECTION HEADERS:
Use standard names that ATS recognizes:

✓ ACCEPTABLE:
- Experience / Work Experience / Professional Experience
- Education
- Skills / Technical Skills
- Projects

✗ AVOID:
- Where I've Made an Impact
- My Career Journey
- What I'm Good At
- The Story So Far

## KEYWORD STRATEGY:

### Step 1: Analyze the job description
Copy the JD and highlight:
- Required skills (must have in resume)
- Preferred skills (include if true)
- Specific technologies mentioned
- Exact phrases used

### Step 2: Match terminology
If JD says: "Go programming language"
Include: "Go" (and optionally "Golang")

If JD says: "Amazon Web Services"
Include: "Amazon Web Services (AWS)"

If JD says: "CI/CD"
Include: "Continuous Integration/Continuous Deployment (CI/CD)"

### Step 3: Natural integration
Don't just list keywords. Integrate them:

BAD (keyword stuffing):
"Skills: Go, Kubernetes, AWS, CI/CD, distributed systems,
microservices, PostgreSQL, Redis, Docker, Terraform..."

GOOD (contextual):
"Built distributed payment processing system in Go,
deploying to Kubernetes on AWS with CI/CD pipeline
using GitHub Actions and Terraform"

## DATES:
Use consistent, parseable formats:
✓ "Jan 2020 - Present"
✓ "January 2020 - Present"
✓ "2020 - Present"
✗ "1/20 - current"
✗ "Started in early 2020"

## TESTING YOUR RESUME:

### Method 1: Plain text test
1. Copy resume content
2. Paste into plain text editor
3. Is it readable and correctly ordered?
4. Are all sections intact?

### Method 2: Online ATS checkers
- Jobscan (jobscan.co)
- Resume Worded
- VMock
Upload resume + JD, see match score

### Method 3: Apply to your company
If possible, apply to an open role at your current
company through the public portal. See what the
recruiter sees.
```

### Keywords for Go Engineers

The specific keywords that appear on your resume directly determine whether you surface in recruiter searches and pass ATS filters. The lists below are organized by Go engineering specialty and career level, reflecting the terms that recruiters and ATS systems actually search for. Include the relevant keywords naturally in your experience bullets rather than dumping them into a skills section, because contextual usage carries more weight with both automated systems and human readers.

```markdown
# Go Engineer Resume Keywords by Specialty

## GENERAL GO DEVELOPMENT:
Must include:
- Go / Golang (use both)
- Concurrency
- Goroutines
- Channels
- Standard library

Often searched:
- HTTP servers
- REST APIs
- JSON
- Error handling
- Testing

## DISTRIBUTED SYSTEMS:
High-value keywords:
- Distributed systems
- Microservices
- Service mesh
- gRPC
- Protocol Buffers
- Kafka / Message queues
- Event-driven architecture
- Consistency / Consensus
- Raft / Paxos

## INFRASTRUCTURE/DEVOPS:
High-value keywords:
- Kubernetes / K8s
- Docker / Containers
- AWS / GCP / Azure
- Terraform
- CI/CD
- GitHub Actions
- Infrastructure as Code
- Observability
- Prometheus / Grafana

## DATABASES:
Include if applicable:
- PostgreSQL
- MySQL
- Redis
- MongoDB
- DynamoDB
- SQL
- NoSQL
- Database design
- Migrations

## BACKEND WEB:
- REST / RESTful
- HTTP
- API design
- Authentication
- Authorization
- OAuth / JWT
- Rate limiting
- Caching

## MATCH TO JOB LEVEL:

### Junior roles look for:
Data structures, algorithms, Git, testing, debugging

### Mid-level roles look for:
System design, production experience, CI/CD, monitoring

### Senior roles look for:
Architecture, scalability, leadership, mentoring, cross-team

### Staff+ roles look for:
Technical strategy, organizational impact, industry influence
```

### Junior → FAANG: ATS Optimization as a Prerequisite, Not an Optimization

Early-career candidates often discover ATS optimization after their first dozen cold applications receive no response. The correct timing is before sending the first application. Spend one hour understanding the ATS pipeline described in this section, then apply those principles to every application you send. This is not gaming the system. It is learning how the system works and communicating in the format it is designed to receive.

The most actionable ATS principles for junior candidates: use the exact job title from the posting in your resume's experience section if it matches your actual role. Extract the specific technologies named in the job description and ensure they appear in your resume's skills section using identical spelling and capitalization. Avoid tables, columns, and text boxes. Submit as PDF from a clean LaTeX or Google Docs template.

One practical shortcut: paste the job description into a word frequency counter, identify the top 15-20 non-generic technical terms, and verify that at least 10 of them appear somewhere in your resume. This takes five minutes and improves ATS scores measurably.

### Senior @ FAANG: ATS as a Governance Non-Issue at Senior Level

At L5 and above, ATS optimization matters far less than it does at early career, because the primary application pathway for senior candidates is not the career page submission queue. It is recruiter outreach, referral, or direct contact with hiring managers. If you are applying to senior roles primarily through career pages and relying on ATS scoring, you are using the wrong channel.

The staff-level insight about ATS: the same keyword optimization principles that govern ATS scoring also govern recruiter LinkedIn searches. Understanding what terms appear in the job descriptions for roles you want informs how you should title your skills, describe your experience, and write your LinkedIn summary, even if you never submit a cold application. The language of the job description tells you what the team currently believes they need, and matching that language in your materials is how you start the conversation in terms they recognize.

Governance implication: if you are a hiring manager or involved in defining job descriptions, the ATS section of this chapter should inform how you write those descriptions. Poorly written job descriptions with vague or contradictory requirements produce ATS-filtered candidate pools that do not match what the team actually needs. This is a systemic problem that staff engineers are in a position to improve.

---
