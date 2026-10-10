## Search Quality Defense

A search engine's worst enemy is not bad ranking. It is adversarial content: spam pages stuffed with keywords, link farms inflating PageRank, AI-generated content gaming neural rerankers, scraped duplicates of legitimate content, and fresh-but-low-quality content masquerading as authoritative. Quality defense is the part of search that runs continuously to keep the index clean and the ranking honest.

### Spam Categories

**Keyword stuffing.** A page that lists "buy cheap shoes online cheap shoes shop shoes online" 200 times. Detected by lexical statistics: term frequency distribution that does not match natural language.

**Hidden text.** Text rendered invisible (white on white, off-screen, display:none) to inflate term match without affecting users. Detected by parsing the rendered DOM, not the source HTML.

**Link spam.** Networks of low-quality sites linking to a target to inflate PageRank. Detected by graph-level analysis: tight clusters with high link density and no organic external links.

**Cloaking.** Serving different content to search crawler vs user. Detected by re-fetching pages with browser fingerprints and comparing.

**Doorway pages.** Pages designed only to rank, that redirect users to a different destination. Detected by behavioral analysis (high CTR, very short dwell, immediate back).

**Generative content farms.** Sites publishing thousands of LLM-generated articles. Hard to detect at scale, the trend since 2023 has driven a lot of new defense work.

### Spam Classification

A binary classifier predicts P(spam | document). Features:

- Lexical: term distribution, n-gram repetition, vocabulary diversity.
- Structural: HTML tag ratios, link-to-text ratio, image-to-text ratio.
- External: backlink graph features, hosting platform reputation.
- Behavioral: post-click metrics aggregated over impressions.
- Embedding: cosine to known-spam centroids.

The classifier is run at index time on every document, with rescoring on a schedule (weekly or monthly) for documents already in the index. Documents above a spam threshold are dropped or downranked.

### Generative Content Detection

LLM-generated text has statistical signatures: low perplexity under the same model, low burstiness (uniform sentence length), specific vocabulary patterns. Detection accuracy is around 80-90 percent on plain LLM output, much lower on edited LLM output.

Watermarking (Kirchenbauer et al. 2023) embeds a statistical signature in LLM output via biased token sampling. Detection of watermarked text is much more reliable but only works if the model used watermarking.

Practical defense: a combination of perplexity scoring, watermark detection (when applicable), and behavioral signals (user dwell time, return rate). Pure detection is not enough, the spam classifier and the ranking model jointly de-prioritize suspect content.

### Freshness

For some queries, recent content is more relevant. News search, sports scores, weather, recent product reviews. The freshness signal:

- Document publish date.
- Recent edit timestamp.
- Recent click and link signals (a document fetched today is likely current).
- Co-occurrence with trending entities.

Freshness is a feature in the LTR model, often with a learned per-query-class weight. A query for "Olympic results" weights freshness heavily, a query for "history of Rome" does not.

### Duplicate Suppression

Even after dedup at index time (chapter 16), near-duplicates can sneak in. At query time, results are suppressed if they are too similar to higher-ranked results.

```cpp
std::vector<Hit> suppress_duplicates(std::vector<Hit> ranked, double threshold) {
    std::vector<Hit> kept;
    for (auto& h : ranked) {
        bool is_dup = false;
        for (auto& k : kept) {
            if (similarity(h.doc_vector, k.doc_vector) > threshold) {
                is_dup = true; break;
            }
        }
        if (!is_dup) kept.push_back(h);
        if (kept.size() >= 10) break;
    }
    return kept;
}
```

Threshold is tuned offline. Too low: legitimate near-duplicates (different sources covering the same news) all suppressed. Too high: visible duplicates leak through.

### PageRank and Static Quality

PageRank (Page, Brin, Motwani, Winograd 1999) is a global quality signal computed from the link graph. Despite the addition of many other signals, PageRank-style metrics remain a strong baseline for static quality.

Modern variants:

- TrustRank (Gyongyi, Garcia-Molina 2004): PageRank seeded from human-vetted trustworthy pages.
- BrowseRank (Liu et al. 2008): replace link graph with user navigation graph.
- Topical PageRank: separate PageRank per topic.

Computation is offline. A graph of N pages with M edges takes O(M * iterations) per iteration, convergence is typically within 50-100 iterations. For the public web (~100 billion pages), this is a significant batch job. Google computes it once a week or less frequently.

### Behavioral Signals

The user's reaction to a result is the ultimate quality signal:

- **Click.** Weak positive.
- **Long dwell time.** Stronger positive.
- **No click followed by query reformulation.** Weak negative.
- **Click then immediate back.** Strong negative ("pogosticking").
- **Skip past.** User saw and ignored, weak negative.

These signals feed back into LTR features (chapter 06). They are also used as a quality test for new documents: if a new document gets surprisingly low CTR or high pogostick rate, it is downranked or filtered.

### Adversarial Robustness

Spammers respond to defenses. The arms race:

1. Engine adds a new feature -> spam evolves to game it.
2. Engine retrains with new spam patterns -> spam evolves further.
3. Repeat.

Production defenses are continuously updated. The team running spam classification at Google or Bing reviews flagged content weekly, retrains the classifier monthly, and rolls out updated signals quarterly. Stale defenses are exploited.

### Logging for Debugging

When a quality regression hits, debugging requires reconstructing what the system did. "Heisenberg-style" logging: log enough to debug without altering the system's behavior.

- Per-query, per-result, per-stage scores.
- Feature values at each stage.
- Decision points (which model variant, which fusion method).
- Sampled at 0.1-1 percent for cost reasons.

The logs feed a debug tool that lets engineers replay queries and see why a result was ranked where it was. Without this, debugging quality regressions is guesswork.

### A C++ Quality Pipeline Sketch

```cpp
class QualityFilter {
public:
    bool admit(const Document& doc, const QualitySignals& sig) const {
        if (spam_classifier_.predict(doc.features) > spam_threshold_) return false;
        if (sig.duplicate_of_existing) return false;
        if (sig.click_through_rate < ctr_floor_) return false;
        if (sig.is_generative_unverified) return false;
        return true;
    }

    double rerank_score_adjustment(const Document& doc,
                                    const QualitySignals& sig) const {
        double s = 0;
        s += 0.3 * sig.static_quality;
        s -= 0.5 * sig.spam_score;
        s += 0.1 * sig.freshness;
        s -= 0.3 * sig.click_back_rate;
        return s;
    }

private:
    SpamClassifier spam_classifier_;
    double spam_threshold_ = 0.85;
    double ctr_floor_ = 0.001;
};
```

Production code adds: per-locale thresholds, per-vertical adjustments, time-since-flagged decay, manual override for trusted publishers.

### Junior to FAANG

A junior trains a spam classifier and ships. A senior at Google or Bing runs the full quality program: continuous review, multiple defense layers (classifier + behavioral + manual), per-vertical thresholds, per-locale tuning. A staff engineer thinks about the adversary: who is gaming the system, what are their economics, what defenses they have already broken, and what the next attack vector is. The interview question: "your spam classifier has 95 percent precision. Spammers are getting through anyway. What now?" Senior answer covers: behavioral signals, multi-layer defense, manual review of high-CTR new documents, and the recognition that 5 percent miss rate at web scale is a lot of bad results, requiring layers of protection beyond a single classifier.

---
