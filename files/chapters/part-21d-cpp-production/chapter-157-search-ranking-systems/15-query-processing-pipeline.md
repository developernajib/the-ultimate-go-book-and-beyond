## Query Processing Pipeline

The query a user types is not the query that hits the index. Between the keystroke and the inverted index there is a pipeline that parses, normalizes, expands, corrects, embeds, and rewrites. Each step is small but measurable in latency and large in quality impact. This chapter walks through the canonical pipeline that engines like Vespa, Elastic, and the Bing query stack run.

### Pipeline Overview

```
raw query string
   |
   v
[parse]              -> tokens with annotations
   |
   v
[normalize]          -> lowercase, accents, punctuation
   |
   v
[language detect]    -> per-token language guess
   |
   v
[spell correct]      -> typo fix (optional)
   |
   v
[stop word handle]   -> drop or downweight stopwords
   |
   v
[stem / lemmatize]   -> reduce to base form (optional)
   |
   v
[query expansion]    -> synonym add, embedding-based add
   |
   v
[rewrite]            -> rewrite to operator tree, boost, filter
   |
   v
[embed]              -> dense vector if hybrid
   |
   v
retrieval
```

Total pipeline latency target: under 5 ms in production, often under 2 ms.

### Parsing

The query syntax is usually richer than free text. Quoted phrases, field qualifiers (`title:foo`), boosts (`foo^2`), filters (`category:books`), boolean operators (`foo AND bar NOT baz`).

A parser produces an operator tree. Lucene's QueryParser is the reference, it produces a Query AST with `BooleanQuery`, `TermQuery`, `PhraseQuery`, `WildcardQuery` nodes. Vespa uses YQL (Yahoo Query Language), more SQL-like.

```cpp
// Sketch of an operator tree.
struct QueryNode {
    enum Kind { Term, Phrase, And, Or, Not, Boost };
    Kind kind;
    std::vector<std::unique_ptr<QueryNode>> children;
    std::string term;
    float boost = 1.0;
};
```

Parsing also identifies entities (locations, dates, named entities) for downstream specialized handling. "weather in Boston tomorrow" might be parsed into `(weather) (location:Boston) (date:tomorrow+1d)`.

### Tokenization

UAX-29 (Unicode Standard Annex #29) defines word boundaries for Unicode text. ICU implements it. Lucene's StandardTokenizer is a Java implementation of UAX-29 with some search-specific extensions.

CJK languages need different handling. Chinese has no whitespace, tokenization requires either a dictionary-based segmenter (Jieba), a statistical segmenter (CRF, BiLSTM), or n-gram-based (bigrams over characters). Japanese needs morphological analysis (MeCab, Kuromoji). Korean has whitespace but compound words.

For search, n-gram tokenization is a hammer that works across languages: index every overlapping 2-3 character n-gram. Quality is mediocre but coverage is good. Used as a fallback for low-resource languages.

### Normalization

- Lowercase. Most languages use case-insensitive matching.
- Accent folding. "café" -> "cafe". Loses some signal in Spanish or French but improves recall.
- Unicode normalization (NFKC). Combining marks, ligatures, fullwidth/halfwidth.
- Punctuation handling. Drop or split.

Both query and document side must apply the same normalization, otherwise matches fail.

### Stopword Handling

"the", "is", "of" appear in nearly every document. Their posting lists are huge. Two options:

1. **Drop them at index and query time.** Saves space, common in classic IR. Hurts phrase queries ("to be or not to be" all stopwords).
2. **Keep them but downweight.** BM25's IDF naturally downweights very-common terms. WAND prunes them aggressively. Modern engines (Elastic, Vespa) keep stopwords by default.

The Lucene default is to keep them. Drop them only for specific use cases (e.g., title-only matching).

### Stemming and Lemmatization

Reduce inflected forms to a common base. "running", "runs", "ran" -> "run".

- **Porter stemmer.** Rule-based, fast, English-only. Good enough for most search.
- **Snowball.** Multilingual extension of Porter. Lucene ships with Snowball stemmers for 30+ languages.
- **Lemmatization.** Dictionary-based, slower, more accurate. Spacy and Stanford CoreNLP do it.

Stemming improves recall (matches more documents) and hurts precision (sometimes "universe" and "university" stem the same). For most search, stemming is a net win, but specialized verticals (legal, medical) often disable it because false matches are costly.

### Spell Correction

Misspelled queries are common (10-20 percent of long-tail queries on the web). Three approaches:

1. **Dictionary-based.** Edit-distance (Levenshtein) against a vocabulary. Cost: O(V * |q|) for V vocabulary words. Use a BK-tree or symspell to make it sub-linear.
2. **Query log mining.** "did you mean X" is learned from how users self-correct. If 5 percent of users typing "spaghetii" then type "spaghetti", treat the latter as the correction.
3. **Neural spelling correction.** A seq2seq model (often character-level) predicts corrections. Used at Google and Bing.

The trick is whether to **silently** correct (replace the query with the correction, possibly losing the user's intent) or **suggest** the correction (run both queries, return the corrected results with a "did you mean" suggestion). Google does both depending on confidence.

### Query Expansion

The query is short, the document is long. Expansion adds related terms to the query to bridge the vocabulary gap.

**Synonym expansion.** Use a thesaurus (WordNet, custom curated) or learned synonyms (word2vec, embeddings). "car" expands to "automobile, auto, vehicle". Each added term contributes to BM25 scoring with a discount.

**Pseudo-relevance feedback (PRF).** Run the query, take the top-K documents, extract the most discriminative terms from those documents, add them to the query, run again. Classic IR (Rocchio algorithm), marginally helpful in modern systems.

**Embedding-based expansion.** Given the query embedding, find documents nearby, the lexical content of those documents implicitly expands the query. This is what dense retrieval already does, so explicit expansion is less important when dense is in the pipeline.

**Generative expansion (Doc2Query, HyDE).** A language model writes "what document would answer this query" and uses that as the expanded query. HyDE (Hypothetical Document Embeddings, Gao et al. 2022) embeds the generated document and uses that for dense retrieval. Improves zero-shot retrieval by 5-10 percent.

### Query Rewriting

The output of the pipeline is usually not a simple query but an operator tree:

```
Query("machine learning books")
  ->
Or(
    Boost(2.0, And(Term("machine"), Term("learning"))),
    And(Term("machine"), Term("learning"), Term("books")),
    And(Term("ml"), Term("books")),                          // synonym
    NearestNeighbor(query_embedding, k=100)
)
```

The rewriter is the most product-team-influenced component. Per-vertical rules: in product search "shoes" expands differently than in book search "shoes" (a book about shoes vs the product). Per-locale rules. A/B-tested rules.

### Query Embedding

For dense retrieval. Tokenize with the embedding model's tokenizer, run the encoder, L2-normalize the output. Latency: 1-5 ms on GPU for a small encoder, 5-20 ms on CPU. Caching helps: many queries are repeated within a short window, so a query-embedding cache with 5-minute TTL hits 30-50 percent.

### Caching the Pipeline

The full pipeline output (operator tree + embedding) can be cached on `(raw_query, locale, user_segment)`. Hit rates depend on workload: head queries hit 50-80 percent, tail queries near 0 percent. The cache is small (a few KB per entry) and the win is large.

### A C++ Pipeline Sketch

```cpp
class QueryPipeline {
public:
    ProcessedQuery process(const std::string& raw, const Locale& loc, const User& u) {
        if (auto cached = cache_.get(raw, loc, u.segment); cached) return *cached;

        auto tokens = tokenizer_.tokenize(raw, loc);
        normalizer_.apply(tokens, loc);
        auto lang = lang_detector_.detect(tokens);
        if (lang.confidence > 0.8) loc.lang = lang.language;

        auto corrected = spell_corrector_.maybe_correct(tokens);
        if (corrected.confidence > 0.9) tokens = corrected.tokens;

        stop_filter_.apply(tokens, loc.lang);
        stemmer_.apply(tokens, loc.lang);

        auto expanded = expander_.expand(tokens, loc.lang);
        auto tree = rewriter_.build_tree(expanded, loc, u);
        auto embedding = embedder_.embed(raw);

        ProcessedQuery q{std::move(tree), std::move(embedding), loc, u.id};
        cache_.put(raw, loc, u.segment, q);
        return q;
    }
private:
    Tokenizer tokenizer_;
    Normalizer normalizer_;
    LanguageDetector lang_detector_;
    SpellCorrector spell_corrector_;
    StopFilter stop_filter_;
    Stemmer stemmer_;
    QueryExpander expander_;
    QueryRewriter rewriter_;
    QueryEmbedder embedder_;
    LruCache<QueryKey, ProcessedQuery> cache_;
};
```

The total budget is small, most components are simple lookups (stemming, stop filter), and the heavy ones (embedding, expansion) are cached.

### Junior to FAANG

A junior tokenizes and ships. A senior at Bing or Google instruments per-component contribution to NDCG, runs A/B tests on stop-word policies and expansion strategies, and knows that the spelling correction model is more important than the ranking model on tail queries. A staff engineer designs the pipeline as a composition of named stages with clear contracts so that A/B testing can swap individual stages, and treats the rewriter as the central product surface where business teams can ship logic without touching the index. The interview question: "your spell-correction model has 95 percent precision, 85 percent recall. Should you correct silently or always show 'did you mean'?" The senior answer covers the false-positive cost (user got results for a different query) vs false-negative cost (user got bad results because typo was uncorrected), and proposes a confidence-thresholded policy.

---
