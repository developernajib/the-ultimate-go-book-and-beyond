## 91.10 Tech Blogging and Content Strategy

### Why Engineers Should Write

Technical writing is one of the highest-leverage career activities available to engineers, yet most engineers never do it. Writing forces you to organize your thinking, deepens your understanding of the topics you cover, and creates a public body of work that recruiters and hiring managers can discover on their own. Some of the most successful engineering careers in the industry were accelerated by consistent technical writing, as the examples below illustrate.

```
┌───────────────────────────────────────────────────────────────────┐
│              THE VALUE OF TECHNICAL WRITING                       │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  FOR YOUR CAREER:                                                 │
│  ├── Establishes expertise publicly                               │
│  ├── Recruiters find and contact you                              │
│  ├── Conference invitations                                       │
│  ├── Career optionality (consulting, teaching)                    │
│  └── Interview conversation starters                              │
│                                                                   │
│  FOR YOUR LEARNING:                                               │
│  ├── You learn deeply to write clearly                            │
│  ├── Forces you to structure knowledge                            │
│  ├── Creates reference for future you                             │
│  ├── Community feedback improves understanding                    │
│  └── Writing is thinking                                          │
│                                                                   │
│  FOR THE COMMUNITY:                                               │
│  ├── Helps others facing same problems                            │
│  ├── Contributes to collective knowledge                          │
│  ├── Builds connections with readers                              │
│  └── Creates goodwill and recognition                             │
│                                                                   │
│  SUCCESS STORIES:                                                 │
│  ├── Julia Evans: Drawings → Senior @ Stripe                      │
│  ├── Dan Abramov: Blog → React Core Team @ Meta                   │
│  ├── Kelsey Hightower: Talks → Principal @ Google                 │
│  └── You: Your blog → Your dream job?                             │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### Content Types That Work

Not all blog posts are created equal in terms of career impact. Some types consistently perform better because they are more searchable, more shareable, or more impressive to hiring managers. The categories below are ranked by their proven effectiveness for building an engineering audience and establishing credibility. Pick the type that feels most natural to you and start there rather than trying to do all of them at once.

```markdown
# Technical Blog Post Categories

## 1. DEEP DIVES
Topic: Thorough exploration of a technology or concept
Examples:
- "Understanding Go's Garbage Collector"
- "How Kafka Achieves High Throughput"
- "The Complete Guide to gRPC in Go"

Why it works:
- SEO goldmine (people search for these)
- Demonstrates deep understanding
- Evergreen content

## 2. PROBLEM-SOLVING STORIES
Topic: How you solved a real problem
Examples:
- "How We Reduced Latency by 70% in Our Payment System"
- "Debugging a Memory Leak in Production Go"
- "Why Our Microservice Migration Failed (And How We Fixed It)"

Why it works:
- Shows real experience
- Relatable to other engineers
- Demonstrates debugging skills

## 3. TUTORIALS
Topic: Step-by-step guide to accomplish something
Examples:
- "Building a Rate Limiter in Go from Scratch"
- "Setting Up OpenTelemetry for Your Go Service"
- "Deploying Go Apps to Kubernetes: Complete Guide"

Why it works:
- Highly searchable
- Useful to community
- Shows teaching ability

## 4. OPINIONS AND PERSPECTIVES
Topic: Your take on industry topics
Examples:
- "Why I Think Go's Error Handling Is Actually Good"
- "The Microservices Trap: When Monoliths Win"
- "What Senior Engineers Get Wrong About Mentoring"

Why it works:
- Creates discussion
- Shows independent thinking
- Can go viral

## 5. COMPARISONS
Topic: Analyzing alternatives
Examples:
- "Go vs Rust for Backend Services: A Real-World Comparison"
- "When to Use PostgreSQL vs CockroachDB"
- "gRPC vs REST: Choosing the Right API Style"

Why it works:
- Helps others make decisions
- Shows breadth of knowledge
- High search volume

## 6. LESSONS LEARNED
Topic: Reflection on experience
Examples:
- "What I Learned Leading My First Distributed System Project"
- "5 Years of Go: What I Wish I Knew Starting Out"
- "From Google to Startup: What Changed My Perspective"

Why it works:
- Authentic and human
- Appeals to people at similar stages
- Shows growth mindset
```

### Writing Your First Technical Post

The hardest part of technical writing is getting started, so having a reliable template eliminates the blank page problem. The structure below works for almost any type of technical blog post, from tutorials to problem-solving stories. Follow it for your first few posts until you develop your own style, and remember that a published imperfect post is infinitely more valuable than a perfect post that never ships.

```markdown
# Technical Blog Post Template

## TITLE
Make it specific and searchable:
- Bad: "Some Thoughts on Go"
- Good: "How to Build a Production-Ready Rate Limiter in Go"

## HOOK (First 2-3 sentences)
Why should they read this?
- State the problem
- Promise the solution
- Establish credibility

Example:
"Last month, our API got hit with a traffic spike that took down
our payment service for 45 minutes. Here's how we built a rate
limiter that now handles 10x our normal traffic gracefully."

## CONTEXT
Set up the problem:
- What situation were you in?
- What constraints existed?
- Why did this matter?

## THE MEAT
The actual content:
- Code examples (complete and runnable)
- Diagrams where helpful
- Step-by-step if tutorial
- Clear explanations

## GOTCHAS AND PITFALLS
What you learned the hard way:
- Common mistakes
- Edge cases
- What didn't work

## CONCLUSION
Wrap it up:
- Summary of key points
- Call to action (try it, share feedback)
- What's next

## METADATA
Don't forget:
- Date published
- Estimated reading time
- Tags/categories
- Author bio

---

## WRITING TIPS:

### Length:
- 1,000-2,500 words is ideal
- Long enough to be useful, short enough to read

### Code:
- Syntax highlighted
- Copy-pasteable
- Actually works (test it!)

### Images:
- Diagrams for architecture
- Screenshots for tools
- Charts for data

### Voice:
- Write like you talk
- Use "you" and "I"
- Be confident but not arrogant
```

### Content Publishing Strategy

Where you publish your content affects who sees it and how much long-term value it provides. The best approach is to publish on your own blog first for SEO and ownership, then cross-post to platforms with built-in audiences for reach. The guide below covers the major publishing platforms, their strengths and weaknesses, and a sustainable publishing cadence that builds momentum without burning you out.

```markdown
# Where to Publish

## YOUR OWN BLOG (Primary)
Pros:
- You own it forever
- SEO builds over time
- Full control

How: Hugo, Jekyll, Next.js, Ghost

## MEDIUM / DEV.TO (Syndication)
Pros:
- Built-in audience
- Discovery features
- Easy to start

Strategy:
- Publish on your blog first
- Cross-post with canonical URL
- Link back to your site

## COMPANY BLOG (If Available)
Pros:
- Higher authority site
- Wider reach
- Good for resume

What to write:
- Non-proprietary learnings
- Technical deep dives
- Architecture decisions

## HASHNODE / SUBSTACK
Pros:
- Newsletter integration
- Community features
- Simple setup

Best for:
- Building email list
- Regular publishing cadence

---

## PUBLISHING CADENCE:

### Sustainable Schedule:
- 1 post per month minimum
- 2 posts per month ideal
- Quality > quantity always

### Batching Strategy:
1. Block 4 hours for writing
2. Draft post completely
3. Let it sit 1-2 days
4. Edit fresh
5. Publish

### Ideas Pipeline:
- Keep notes file of ideas
- When you solve a problem, write it down
- When you explain something twice, write a post
- When you have an opinion, consider sharing
```

### Junior → FAANG: Starting a Writing Practice Without Waiting for Permission

The biggest obstacle to starting technical writing at early career is the belief that you do not yet know enough to have something worth saying. This belief is wrong, and it is worth examining why. The readers who benefit most from your writing are not senior engineers who already know everything you know. They are engineers who are one step behind you, facing the exact problem you solved last month. Writing for that audience is valuable, and you are qualified to do it from your first week of professional work.

A practical starting structure for early-career posts: describe a problem you encountered, explain what you tried that did not work and why, describe what you eventually did, and share what you would do differently next time. This four-part structure produces a useful post from almost any non-trivial debugging or design experience, requires no special expertise beyond having actually solved the problem, and is exactly the kind of post that appears in Google search results and sends traffic to your site for years.

For Go engineers specifically: write about practical Go-specific idioms, standard library features found to be underused or misunderstood, or the testing patterns that made your code easier to maintain. This content is specifically valuable to the Go engineering community and will be read by engineers at the companies you want to work for.

### Senior @ FAANG: Content Strategy as Platform Building

At senior and staff level, technical writing is not a practice. It is a platform strategy with a target audience, a content calendar, and measurable outcomes. The measurable outcomes for senior technical writing are: inbound recruiter contact from target companies increases, invitations to speak at conferences the engineer values, and recognition from technical community members whose judgment the engineer respects.

The content strategy question for senior engineers is not "what should I write about" but "what is the body of work I want to be known for, and what does each piece contribute to that body." A coherent body of work on a specific technical topic (distributed systems correctness, Go runtime internals, large-scale database migration) establishes authority in a way that a collection of unrelated posts never does. Readers who value your perspective on the first topic will seek out your perspective on related topics, and your total readership compounds rather than resets with each post.

Long-form posts carry more weight than short ones at senior level, because depth demonstrates judgment in a way that brevity cannot. A 3,000-word analysis of the tradeoffs between different consensus algorithms, with production war stories and quantitative comparisons, is a stronger signal than fifty 500-word posts about miscellaneous tips. Prioritize depth over frequency once you have established a writing practice.

Governance consideration: before publishing anything that touches your current employer's systems, competitive strategy, or unannounced technology choices, run it through your company's publication review process. Many FAANG companies have formal processes for external publishing. Skipping this step is a career risk that is not worth taking for any amount of content marketing benefit.

---
