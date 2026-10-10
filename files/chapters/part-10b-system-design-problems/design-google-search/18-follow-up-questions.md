## Follow-up Questions

These questions test your ability to extend the core design into specialized domains. Each answer should be 30-60 seconds in an interview, covering the approach and key trade-off.

**1. Personalization?** User search history and click-through data are encoded into a personalization vector (128 dimensions, updated daily). During Phase 2 ranking, the ML model includes the cosine similarity between the user's vector and each document's topic vector as a feature. The trade-off: personalization improves relevance for returning users but can create filter bubbles. Privacy regulations (GDPR) require that personalization data be deletable on request.

**2. Link spam (SEO manipulation)?** TrustRank propagates trust scores from a manually curated set of known-good seed sites through the link graph. Sites that receive trust only from untrusted sources score low. Graph clustering algorithms (like spectral clustering) detect link farms, clusters of sites that exist only to link to each other. Pages in detected farms are demoted or removed from the index entirely.

**3. Knowledge Graph (structured answers)?** Entity extraction identifies named entities in the query ("Barack Obama", "Python programming language") and maps them to a knowledge base (Wikidata, Freebase). If the query matches an entity, the search results page includes a structured panel with key facts, images, and related entities. This requires NER (Named Entity Recognition) running on the query path, plus a pre-built knowledge base indexed by entity name and aliases.

**4. Image search?** During crawling, extract images along with their alt text, surrounding text, and page title. Index images by text metadata for keyword search. For visual similarity search, compute CNN embeddings (e.g., ResNet features) and store them in a vector index (FAISS). Duplicate image detection uses perceptual hashing (pHash) to collapse visually identical images regardless of resolution or format.

**5. Multi-language support?** A language detector (CLD3 or fastText) classifies each crawled page. Pages are indexed into language-specific shards with language-appropriate tokenizers (word segmentation for CJK languages, stemming for European languages). The user's query language is inferred from their locale, browser settings, or explicit language filter. Cross-language search requires translation of the query into the target language before searching.

**6. News search (real-time results)?** News sources are crawled on 1-minute cycles (vs daily for regular web pages). Crawl results feed into a separate news index optimized for recency. When the query intent suggests news ("earthquake today"), results from the news index are blended into the main results with a heavy recency bias. Trending topic detection identifies breaking stories and pre-warms the news index.

**7. Search quality measurement?** NDCG (Normalized Discounted Cumulative Gain) computed from human relevance judgments (raters score results on a 0-4 scale) provides the gold standard. Click-through rate analysis and dwell time (how long users stay on clicked results) provide automated quality signals. Ranking model changes are evaluated via A/B testing on 1% of traffic, comparing NDCG, CTR, and user satisfaction metrics before full rollout.

---
