## 94.11 Technical Ramp-Up: Deep Dive Strategies

The technical dimension of onboarding is where many engineers feel the most pressure, because your ability to understand and contribute to the codebase is the most visible measure of your progress. This section provides structured frameworks for learning a new codebase efficiently, from high-level orientation down to the ability to debug production issues. The key insight is that codebase learning is not linear, you will revisit the same systems multiple times, each time understanding them at a deeper level. Embrace this iterative approach rather than trying to understand everything perfectly on the first pass.

### The Codebase Learning Framework

A systematic approach to learning a new codebase prevents the common trap of reading code aimlessly for weeks without building real understanding. Start with the entry points (main functions, request handlers), trace a few critical paths end-to-end, then widen your exploration from there.

```
┌───────────────────────────────────────────────────────────────────┐
│             SYSTEMATIC CODEBASE EXPLORATION                       │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  LEVEL 1: ORIENTATION (Week 1)                                    │
│  ├── Repository structure                                         │
│  ├── Build and run locally                                        │
│  ├── Deployment pipeline overview                                 │
│  └── Key services and their purposes                              │
│                                                                   │
│  LEVEL 2: UNDERSTANDING (Week 2-3)                                │
│  ├── Data flow for key features                                   │
│  ├── Database schema and relationships                            │
│  ├── API contracts between services                               │
│  └── Authentication and authorization                             │
│                                                                   │
│  LEVEL 3: NAVIGATION (Week 3-4)                                   │
│  ├── Can find where to make changes                               │
│  ├── Understand testing approach                                  │
│  ├── Know team's coding conventions                               │
│  └── Can trace a bug from report to code                          │
│                                                                   │
│  LEVEL 4: CONTRIBUTION (Month 2)                                  │
│  ├── Can make changes confidently                                 │
│  ├── Understand edge cases and failure modes                      │
│  ├── Can review others' code effectively                          │
│  └── Know the historical "gotchas"                                │
│                                                                   │
│  LEVEL 5: OWNERSHIP (Month 3+)                                    │
│  ├── Can propose improvements                                     │
│  ├── Understand technical debt and why                            │
│  ├── Can mentor others on this area                               │
│  └── Can handle on-call incidents                                 │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### Request Tracing Exercise

One of the most effective ways to learn a system is to trace a request end-to-end:

```go
package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"
)

var ErrInvalidCredentials = errors.New("invalid credentials")

type LoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type User struct {
	ID           string
	Email        string
	PasswordHash string
	CreatedAt    time.Time
}

type Token struct {
	AccessToken string
}

type PasswordHasher interface {
	Verify(password, hash string) bool
}

type TokenGenerator interface {
	Generate(user *User) (*Token, error)
}

type UserRepository struct{}

type AuthService struct {
	userRepo       *UserRepository
	passwordHasher PasswordHasher
	tokenGenerator TokenGenerator
}

type AuthHandler struct {
	authService *AuthService
}

func respondError(w http.ResponseWriter, status int, msg string) {
	http.Error(w, msg, status)
}

// Example: Trace a user login request through the system

/*
STEP 1: Start at the API Gateway
Question: Where does the request first hit our system?

Gateway/Router:
- Load balancer → Which server handles this?
- API gateway → Authentication, rate limiting
- Router → Which handler processes /api/v1/login?

STEP 2: Identify the Handler
*/

// internal/handlers/auth.go
func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
    // What validation happens here?
    var req LoginRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        respondError(w, http.StatusBadRequest, "invalid request")
        return
    }

    // What service layer gets called?
    token, err := h.authService.Authenticate(r.Context(), req.Email, req.Password)
    if err != nil {
        respondError(w, http.StatusUnauthorized, "invalid credentials")
        return
    }
    _ = token
}

/*
STEP 3: Follow the Service Layer
Questions to answer:
- What business logic is applied?
- What external services are called?
- What can go wrong?
*/

// internal/services/auth.go
func (s *AuthService) Authenticate(ctx context.Context, email, password string) (*Token, error) {
    // How is the user looked up?
    user, err := s.userRepo.FindByEmail(ctx, email)
    if err != nil {
        return nil, err
    }

    // How is password verified?
    if !s.passwordHasher.Verify(password, user.PasswordHash) {
        // What's logged? What metrics are recorded?
        return nil, ErrInvalidCredentials
    }

    // How is the token generated?
    token, err := s.tokenGenerator.Generate(user)
    if err != nil {
        return nil, err
    }
    return token, nil
}

/*
STEP 4: Database Layer
Questions:
- What queries are executed?
- What indexes exist?
- What's the performance characteristics?
*/

// internal/repository/user.go
func (r *UserRepository) FindByEmail(ctx context.Context, email string) (*User, error) {
    // What's the actual SQL?
    _ = `SELECT id, email, password_hash, created_at
              FROM users WHERE email = $1`

    // Is there an index on email?
    // What happens if email doesn't exist?
    return &User{Email: email}, nil
}

/*
STEP 5: Response Path
Questions:
- How is the response formatted?
- What headers are set?
- What's logged?
- What metrics are recorded?

DOCUMENT YOUR FINDINGS:
Create a sequence diagram or notes:

User → Load Balancer → API Gateway → Auth Handler
    → Auth Service → User Repository → PostgreSQL
    → Password Verification → Token Generator
    → Session Store (Redis) → Response

Key files:
- internal/handlers/auth.go (entry point)
- internal/services/auth.go (business logic)
- internal/repository/user.go (database)
- pkg/token/jwt.go (token generation)

Questions discovered:
- Why do we use JWTs instead of opaque tokens?
- What's the session expiration policy?
- How do we handle refresh tokens?
*/
```

### Learning Through Code Review

Effective code review accelerates team learning and prevents defects from reaching production, but requires a structured approach to deliver consistent value. The following examples demonstrate specific, actionable review comments focused on correctness and maintainability rather than superficial style preferences.

```markdown
# Learning from Code Reviews

## AS A REVIEWER (Start in Week 2):

### Why Review Early:
- Forces you to read code you didn't write
- Learn team patterns and conventions
- Build relationships with authors
- Show you're engaged and learning

### What to Look For Initially:
1. Code style and formatting
   - Does this match other code?
   - Are names clear and consistent?

2. Tests
   - Are there tests?
   - Do they cover edge cases?

3. Documentation
   - Are complex parts explained?
   - Are public APIs documented?

4. Questions (valuable even if you're new):
   - "I'm new, so this might be obvious, but why..."
   - "Could you explain this pattern? I haven't seen it before"
   - "Is this intentionally different from how X does it?"

### Review Template for New Engineers:

"""
Thanks for the PR! I'm still ramping up, but here's my review:

**What I understood:**
- This PR adds [feature/fix]
- It works by [brief explanation]

**Questions:**
- Line 42: Why do we use X instead of Y?
- Line 78: Is this error case expected?

**Observations:**
- Nice use of [pattern]
- I learned about [thing] from this PR

**Suggestions (take with grain of salt):**
- Consider adding a comment at line 56
"""

## AS AN AUTHOR (Learning from Reviews):

### How to Get Good Reviews:
1. Write clear PR descriptions
2. Point reviewers to areas you're unsure about
3. Ask specific questions in comments
4. Respond to all feedback, even to acknowledge

### What to Learn from Feedback:
- Team conventions you didn't know
- Better approaches you can use
- Patterns the team prefers
- Historical context ("we don't do X because...")
```

### Creating Your Learning Roadmap

```markdown
# First 90 Days Technical Learning Plan

## Week 1-2: Get Your Bearings

### Primary Goals:
□ Build and run all key services locally
□ Deploy a change to staging
□ Understand CI/CD pipeline
□ Know where logs and metrics live

### Learning Tasks:
□ Read all READMEs in repositories you'll work with
□ Complete "Getting Started" guides
□ Run all tests locally
□ Trigger a deployment (if safe to staging)

### Questions to Answer:
□ What are our main services?
□ How do they communicate?
□ Where is the database?
□ How do we deploy?
□ Where do logs go?
□ How do we monitor?

## Week 2-4: Understand Data Flow

### Primary Goals:
□ Trace 3+ critical user flows end-to-end
□ Understand database schema
□ Know authentication/authorization flow
□ Identify external dependencies

### Learning Tasks:
□ Draw architecture diagram from exploration
□ Document a request flow
□ Review recent incident reports
□ Read database migration history

### Questions to Answer:
□ How does user data flow through the system?
□ What's the caching strategy?
□ Where are the performance bottlenecks?
□ What's our scaling approach?

## Week 4-6: Deep Dive on Team's Domain

### Primary Goals:
□ Understand your team's main systems thoroughly
□ Know the historical context and tech debt
□ Understand upcoming roadmap

### Learning Tasks:
□ Read design docs for major features
□ Review last 6 months of significant PRs
□ Talk to longest-tenured team member about history
□ Shadow an on-call shift

### Questions to Answer:
□ Why was it built this way?
□ What would we do differently now?
□ What are the known issues?
□ What's planned for improvement?

## Week 6-8: Expand Beyond Team

### Primary Goals:
□ Understand adjacent systems
□ Know who owns what
□ Understand company-wide patterns

### Learning Tasks:
□ Meet with leads of dependent teams
□ Review company-wide architecture docs
□ Attend tech talks or brown bags
□ Read engineering blog posts

## Week 8-12: Solidify and Contribute

### Primary Goals:
□ Fill gaps in understanding
□ Contribute significantly
□ Start to have opinions

### Learning Tasks:
□ Re-read early notes - what did you misunderstand?
□ Teach something you learned to a newer hire
□ Write or improve documentation
□ Propose a small improvement
```

### Technical Questions to Ask Your Team

```markdown
# Questions Every New Engineer Should Ask

## ABOUT THE CODEBASE:

### Architecture:
1. "What's the high-level architecture? Any diagrams?"
2. "What are the main services and their responsibilities?"
3. "What's the communication pattern between services?"
4. "What's our database architecture?"
5. "What external services do we depend on?"

### Code:
6. "What coding conventions should I follow?"
7. "What patterns does the team prefer?"
8. "What patterns should I avoid?"
9. "Where should I look for examples of good code?"
10. "What areas of the codebase should I avoid touching?"

### Testing:
11. "What's our testing strategy (unit, integration, e2e)?"
12. "How do I run tests locally?"
13. "What test coverage is expected for PRs?"
14. "How do we test against external services?"
15. "What's our approach to test data?"

## ABOUT PROCESSES:

### Development:
16. "What's the PR process and expectations?"
17. "How long should I wait for reviews?"
18. "Who should review my PRs?"
19. "What's the branching strategy?"
20. "How do we handle database migrations?"

### Deployment:
21. "How do we deploy to production?"
22. "What's the rollback procedure?"
23. "How do we handle feature flags?"
24. "What's the release cadence?"
25. "How do I know if my change broke something?"

### On-Call:
26. "What's the on-call rotation?"
27. "What's expected when I'm on call?"
28. "Where's the runbook for common issues?"
29. "Who do I escalate to?"
30. "What monitoring should I watch?"

## ABOUT THE TEAM:

### Culture:
31. "What does success look like on this team?"
32. "What should I know that isn't documented?"
33. "What mistakes do new hires commonly make?"
34. "How are technical decisions made?"
35. "How do we handle disagreements?"

### History:
36. "Why was [system] built this way?"
37. "What's the technical debt we live with?"
38. "What would the team do differently?"
39. "What major changes are planned?"
40. "What failed experiments should I know about?"
```

### Junior → FAANG: Accelerating Technical Ramp Through Structured Questions

The 40 questions in this section represent an interview with the codebase conducted through the people who built it. Most early-career engineers ask a fraction of these questions because they worry about appearing unknowledgeable. This is exactly backwards: asking informed questions about system design, historical decisions, and known tradeoffs is the behavior of an engineer who is taking their onboarding seriously. Engineers who do not ask these questions are the ones who remain shallow in their understanding longest.

The specific questions about failed experiments and known limitations are the most valuable. Understanding what has been tried and why it did not work prevents you from proposing the same failed approaches with different framing, which is one of the most common and most damaging ways early-career engineers damage their credibility on a new team.

For Go-specific technical ramp: add three questions to your list. First, what parts of the codebase do not follow current Go idioms and why (this tells you about historical decisions and where tech debt lives). Second, what is the team's approach to managing goroutine lifecycles and preventing leaks (this tells you about their operational maturity and debugging philosophy). Third, how does the team handle backward-incompatible API changes (this tells you about their discipline around stability and versioning).

### Senior @ FAANG: Technical Due Diligence at Senior Level and the Failure Mode Map

At senior level, the technical ramp-up exercise is simultaneously a personal learning exercise and an organizational due diligence exercise. You are not just learning the system: you are forming an assessment of its health, its risk profile, and the highest-leverage interventions available. This assessment will inform your technical strategy for the first year.

The failure mode map is the most valuable artifact you can produce during your technical ramp. For each major component of the system, document what breaks first under load, what the degradation path looks like, and whether the current alerting and runbooks would catch the failure before it became customer-impacting. This exercise requires both technical depth and operational judgment, and producing it in your first 90 days demonstrates exactly the senior-level capability that distinguishes L6 from L5.

Share the failure mode map with your manager at the end of your technical ramp period, framed explicitly as "here is what I found, I wanted to make sure my understanding is accurate before drawing conclusions." This framing builds trust, surfaces corrections before you act on wrong information, and demonstrates the intellectual humility that sustains organizational credibility at senior level over multi-year tenures.

---
