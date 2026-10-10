## Personalization and Context

A search query is not just the words. It is the user's location, language, device, time, history, and recent activity. Personalization uses these to tailor results. Done well, it improves relevance per-user, done poorly, it creates filter bubbles or recency biases that undermine trust. This chapter covers the engineering, not the philosophy.

### Signal Categories

**Per-request context.** Location (IP geolocation, GPS), device (mobile vs desktop), time of day, day of week, network (WiFi vs cellular), referrer.

**Per-user state.** User ID (if authenticated), language preferences, search history (recent queries and results), explicit preferences (filters set, accounts followed), demographic (if available and consented).

**Session state.** Recent queries in this session, recent clicks, time since last click, page depth in current pagination.

**Implicit signals.** Past CTR by query type, dwell time patterns, return-to-search rate (if user clicked a result and came back, a negative signal).

### Feature Computation at Query Time

Personalization features are computed at query time from a feature store. Latency budget: usually under 10 ms.

A user vector (embedding learned from past interactions) is fetched by user ID. Per-document personalization features (e.g., "user has clicked this domain before") are computed by joining user history with the candidate set.

Two architectures:

1. **Pre-compute user vector offline.** Daily batch job updates per-user embeddings from interaction history. Online: fetch user vector, dot with candidate vectors. Cheap, user vector is a few hundred floats.

2. **Compute user vector at query time.** Read recent N interactions from a session store, embed each, average or attend over them. More responsive to recent intent. Higher latency.

Production systems use both: a stable long-term vector plus a recent-session vector, blended.

### Click-Through Rate Features

CTR is the single most predictive feature for ranking. Per-document CTR (averaged over all impressions) is a quality signal. Per-(query, document) CTR is a personalization signal: documents this user has clicked for similar queries are likely to click again.

Cold start is the issue. New documents have no CTR history. Two mitigations:

- **Smoothing.** Bayesian prior that pulls CTR toward the corpus mean for low-impression documents. `ctr = (clicks + alpha) / (impressions + alpha + beta)`.
- **Imputation by similar documents.** Use the CTR of documents with similar features as a prior for new documents.

CTR is computed from a click logging pipeline with click model debiasing (chapter 06). The position-debiased CTR is what enters the LTR model.

### Contextual Bandits

A contextual bandit chooses among candidate rankings to maximize a reward (click, conversion). Each ranking is an "arm". The "context" is the query plus user features. The bandit explores (occasionally tries non-greedy options) and exploits (usually picks the best-known option).

**Epsilon-greedy.** With probability epsilon, choose a random arm, otherwise the best.

**Upper Confidence Bound (UCB).** Pick the arm with the highest upper confidence bound. Optimistic in face of uncertainty.

**Thompson Sampling.** Maintain a posterior over each arm's reward. Sample from the posterior, pick the highest sample.

Practical use in search: choose between ranking variants for a query (LTR variant A vs B), or choose which result to boost (an exploration on a new document). Thompson sampling is the standard production choice.

For more general personalization, **deep contextual bandits** (Riquelme et al. 2018) and Counterfactual Risk Minimization replace UCB-style heuristics with neural networks predicting reward from context. Used at Spotify, YouTube, Netflix.

### Calibration of Click Models

The position-bias-corrected CTR estimate is only as good as the position-bias model. If the position-bias estimator is wrong, the LTR model trained on the corrected CTR is biased too.

Calibration check: hold out a sample of organic clicks, compare predicted to observed. The predicted CTR should match the observed CTR for each predicted bucket. If the model predicts 5 percent CTR and the observed is 3 percent, the model is overconfident.

Re-fitting the position-bias estimator periodically (monthly or quarterly) is standard. Bing and Google publish papers on this.

### Filter Bubbles and Diversity

If personalization always shows the user what they already like, the user never sees new things. The result is a filter bubble. Mitigations:

- **Explicit diversity injection.** Mix in randomly-sampled or popularity-driven results.
- **Exploration.** A small fraction of impressions show non-personalized results.
- **Multi-aspect personalization.** Personalize on multiple axes, do not collapse to a single user vector.

These are product-team decisions as much as algorithm choices.

### Privacy

Personalization uses user data, user data needs protection. Four levels of practice:

1. **No PII in logs.** Use pseudonymous user IDs. Real PII goes to compliance-approved stores only.
2. **Aggregation.** Per-user features aggregated over windows (last 7 days), not raw event logs.
3. **Differential privacy.** Add noise to per-user counts so no single user's contribution is exposed.
4. **Federated learning.** Train per-user models on-device, aggregate only model updates. Used at Google for Gboard.

For search ranking, level 1-2 is the norm. Level 3-4 is rare and motivated by specific compliance requirements.

### Cold Start

A brand-new user has no history. The ranking falls back to:

1. Per-locale defaults.
2. Demographic priors (if any signals available).
3. Generic ranking (no personalization).

After a few queries, personalization signals start to dominate. The transition is smooth: per-user features have low-impression smoothing toward the global mean, so they exert little influence early.

### C++ Personalization Hookup

The personalization stage receives the candidate set from second-stage ranking and rescores with personalization features.

```cpp
class PersonalizationStage {
public:
    std::vector<Hit> rerank(const PipelineContext& ctx, std::vector<Hit> candidates) {
        auto user_vec = user_store_.get_vector(ctx.user.id);
        auto recent = session_store_.recent_clicks(ctx.user.id, std::chrono::minutes(30));

        for (auto& h : candidates) {
            auto doc_vec = doc_store_.get_vector(h.doc_id);
            float personal_sim = dot(user_vec, doc_vec);
            float recency_boost = compute_recency_match(h.doc_id, recent);
            h.score = h.score + 0.3f * personal_sim + 0.1f * recency_boost;
        }
        std::sort(candidates.begin(), candidates.end(),
                  [](auto& a, auto& b) { return a.score > b.score; });
        return candidates;
    }

private:
    UserVectorStore user_store_;
    SessionStore session_store_;
    DocVectorStore doc_store_;
};
```

The weights `0.3` and `0.1` are tuned offline against held-out judgment data and validated online.

### Junior to FAANG

A junior multiplies CTR into the score and ships. A senior at Google or Pinterest builds a feature store with versioned schemas, debias-tested CTR features, and per-segment evaluation. A staff engineer thinks about the second-order effects: filter bubble dynamics, exploration budget, privacy posture, and the cost of maintaining the personalization stage versus its NDCG contribution. The interview question: "your personalization model improves NDCG by 3 percent but a 1 percent quality regression test is failing on a specific demographic. Ship?" Senior answer: do not ship, the demographic regression is unacceptable. Investigate root cause: feature distribution mismatch, training data skew, or label distribution skew. Fix and re-evaluate.

---
