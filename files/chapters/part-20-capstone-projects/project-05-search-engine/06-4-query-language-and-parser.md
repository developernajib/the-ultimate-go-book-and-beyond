## 4. Query Language and Parser

Users need a way to express complex search intentions beyond simple keyword matching. This section builds a query language that supports boolean operators (AND, OR, NOT), exact phrase matching, fuzzy searches that tolerate typos, wildcard patterns, and numeric range filters. The implementation follows a classic compiler pattern: first we define an Abstract Syntax Tree (AST) to represent every possible query type, then we build a parser that converts raw query strings into that AST, and finally we create an executor that walks the tree and retrieves matching documents from the inverted index.

### 4.1 Query AST
The query AST defines node types for term queries, phrases, Boolean operators, wildcards, fuzzy matches, and range filters. The parser builds this tree from raw query strings, and the executor walks it to produce matching document sets.

```go
// internal/query/parser/ast.go
package parser

// Query represents a search query AST
type Query interface {
    String() string
}

// TermQuery - search for a single term
type TermQuery struct {
    Field string
    Term  string
    Boost float64 // Optional boost factor
}

func (q *TermQuery) String() string {
    return q.Field + ":" + q.Term
}

// PhraseQuery - search for exact phrase
type PhraseQuery struct {
    Field  string
    Terms  []string
    Slop   int // Maximum distance between terms
    Boost  float64
}

func (q *PhraseQuery) String() string {
    return q.Field + ":\"" + joinStrings(q.Terms, " ") + "\""
}

// BoolQuery - boolean combination of queries
type BoolQuery struct {
    Must    []Query // AND
    Should  []Query // OR
    MustNot []Query // NOT
    Boost   float64
}

func (q *BoolQuery) String() string {
    return "BoolQuery{...}"
}

// RangeQuery - range search
type RangeQuery struct {
    Field          string
    LowerBound     string
    UpperBound     string
    IncludeLower   bool
    IncludeUpper   bool
    Boost          float64
}

func (q *RangeQuery) String() string {
    lb := "["
    if !q.IncludeLower {
        lb = "{"
    }
    ub := "]"
    if !q.IncludeUpper {
        ub = "}"
    }
    return q.Field + ":" + lb + q.LowerBound + " TO " + q.UpperBound + ub
}

// FuzzyQuery - fuzzy search with edit distance
type FuzzyQuery struct {
    Field       string
    Term        string
    MaxEdits    int // Levenshtein distance (1 or 2)
    PrefixLength int // Common prefix length
    Boost       float64
}

func (q *FuzzyQuery) String() string {
    return q.Field + ":" + q.Term + "~" + string(rune('0'+q.MaxEdits))
}

// WildcardQuery - wildcard search (* and ?)
type WildcardQuery struct {
    Field   string
    Pattern string
    Boost   float64
}

func (q *WildcardQuery) String() string {
    return q.Field + ":" + q.Pattern
}

// PrefixQuery - prefix search
type PrefixQuery struct {
    Field  string
    Prefix string
    Boost  float64
}

func (q *PrefixQuery) String() string {
    return q.Field + ":" + q.Prefix + "*"
}

// MatchAllQuery - matches all documents
type MatchAllQuery struct {
    Boost float64
}

func (q *MatchAllQuery) String() string {
    return "*:*"
}

func joinStrings(strs []string, sep string) string {
    if len(strs) == 0 {
        return ""
    }
    result := strs[0]
    for i := 1; i < len(strs); i++ {
        result += sep + strs[i]
    }
    return result
}
```

### 4.2 Query Parser

A query parser transforms user input strings like `golang AND channels` into a structured abstract syntax tree that the retrieval engine evaluates. Correct operator precedence, grouping, and quoting rules are essential for matching user expectations across simple and complex queries.

```go
// internal/query/parser/parser.go
package parser

import (
    "fmt"
    "strconv"
    "strings"
    "unicode"
)

// Parser parses query strings
type Parser struct {
    defaultField    string
    defaultOperator string // "AND" or "OR"
}

func NewParser(defaultField, defaultOperator string) *Parser {
    return &Parser{
        defaultField:    defaultField,
        defaultOperator: defaultOperator,
    }
}

// Parse parses a query string
func (p *Parser) Parse(queryStr string) (Query, error) {
    tokens := p.tokenize(queryStr)
    if len(tokens) == 0 {
        return &MatchAllQuery{}, nil
    }

    return p.parseExpression(tokens)
}

type token struct {
    typ   tokenType
    value string
}

type tokenType int

const (
    tokenTerm tokenType = iota
    tokenPhrase
    tokenField
    tokenColon
    tokenLParen
    tokenRParen
    tokenAND
    tokenOR
    tokenNOT
    tokenPlus
    tokenMinus
    tokenTilde
    tokenCaret
    tokenLBracket
    tokenRBracket
    tokenTo
)

func (p *Parser) tokenize(query string) []token {
    var tokens []token
    var current strings.Builder
    inPhrase := false

    runes := []rune(query)
    for i := 0; i < len(runes); i++ {
        r := runes[i]

        if inPhrase {
            if r == '"' {
                tokens = append(tokens, token{typ: tokenPhrase, value: current.String()})
                current.Reset()
                inPhrase = false
            } else {
                current.WriteRune(r)
            }
            continue
        }

        switch r {
        case '"':
            if current.Len() > 0 {
                p.addTermToken(&tokens, current.String())
                current.Reset()
            }
            inPhrase = true

        case ':':
            if current.Len() > 0 {
                tokens = append(tokens, token{typ: tokenField, value: current.String()})
                current.Reset()
            }
            tokens = append(tokens, token{typ: tokenColon})

        case '(':
            if current.Len() > 0 {
                p.addTermToken(&tokens, current.String())
                current.Reset()
            }
            tokens = append(tokens, token{typ: tokenLParen})

        case ')':
            if current.Len() > 0 {
                p.addTermToken(&tokens, current.String())
                current.Reset()
            }
            tokens = append(tokens, token{typ: tokenRParen})

        case '[':
            if current.Len() > 0 {
                p.addTermToken(&tokens, current.String())
                current.Reset()
            }
            tokens = append(tokens, token{typ: tokenLBracket})

        case ']':
            if current.Len() > 0 {
                p.addTermToken(&tokens, current.String())
                current.Reset()
            }
            tokens = append(tokens, token{typ: tokenRBracket})

        case '+':
            tokens = append(tokens, token{typ: tokenPlus})

        case '-':
            tokens = append(tokens, token{typ: tokenMinus})

        case '~':
            tokens = append(tokens, token{typ: tokenTilde})

        case '^':
            tokens = append(tokens, token{typ: tokenCaret})

        case ' ', '\t', '\n', '\r':
            if current.Len() > 0 {
                p.addTermToken(&tokens, current.String())
                current.Reset()
            }

        default:
            current.WriteRune(r)
        }
    }

    if current.Len() > 0 {
        p.addTermToken(&tokens, current.String())
    }

    return tokens
}

func (p *Parser) addTermToken(tokens *[]token, value string) {
    upper := strings.ToUpper(value)
    switch upper {
    case "AND":
        *tokens = append(*tokens, token{typ: tokenAND})
    case "OR":
        *tokens = append(*tokens, token{typ: tokenOR})
    case "NOT":
        *tokens = append(*tokens, token{typ: tokenNOT})
    case "TO":
        *tokens = append(*tokens, token{typ: tokenTo})
    default:
        *tokens = append(*tokens, token{typ: tokenTerm, value: value})
    }
}

func (p *Parser) parseExpression(tokens []token) (Query, error) {
    if len(tokens) == 0 {
        return nil, fmt.Errorf("empty expression")
    }

    // Handle simple single term
    if len(tokens) == 1 && tokens[0].typ == tokenTerm {
        return &TermQuery{
            Field: p.defaultField,
            Term:  tokens[0].value,
            Boost: 1.0,
        }, nil
    }

    // Build boolean query with clauses
    boolQuery := &BoolQuery{
        Must:    make([]Query, 0),
        Should:  make([]Query, 0),
        MustNot: make([]Query, 0),
        Boost:   1.0,
    }

    i := 0
    for i < len(tokens) {
        clause, consumed, err := p.parseClause(tokens[i:])
        if err != nil {
            return nil, err
        }

        // Determine operator
        operator := p.defaultOperator
        if i > 0 {
            prevToken := tokens[i-1]
            if prevToken.typ == tokenAND {
                operator = "AND"
            } else if prevToken.typ == tokenOR {
                operator = "OR"
            }
        }

        // Check for NOT/- prefix
        isNegated := false
        if i < len(tokens) && (tokens[i].typ == tokenNOT || tokens[i].typ == tokenMinus) {
            isNegated = true
            i++
        }

        // Add clause to appropriate list
        if isNegated {
            boolQuery.MustNot = append(boolQuery.MustNot, clause)
        } else if operator == "AND" || tokens[i].typ == tokenPlus {
            boolQuery.Must = append(boolQuery.Must, clause)
        } else {
            boolQuery.Should = append(boolQuery.Should, clause)
        }

        i += consumed

        // Skip operators
        if i < len(tokens) && (tokens[i].typ == tokenAND || tokens[i].typ == tokenOR) {
            i++
        }
    }

    // Simplify if possible
    if len(boolQuery.MustNot) == 0 && len(boolQuery.Should) == 0 && len(boolQuery.Must) == 1 {
        return boolQuery.Must[0], nil
    }
    if len(boolQuery.MustNot) == 0 && len(boolQuery.Must) == 0 && len(boolQuery.Should) == 1 {
        return boolQuery.Should[0], nil
    }

    return boolQuery, nil
}

func (p *Parser) parseClause(tokens []token) (Query, int, error) {
    if len(tokens) == 0 {
        return nil, 0, fmt.Errorf("unexpected end of query")
    }

    // Handle parentheses
    if tokens[0].typ == tokenLParen {
        // Find matching close paren
        depth := 1
        end := 1
        for end < len(tokens) && depth > 0 {
            if tokens[end].typ == tokenLParen {
                depth++
            } else if tokens[end].typ == tokenRParen {
                depth--
            }
            end++
        }

        subQuery, err := p.parseExpression(tokens[1 : end-1])
        if err != nil {
            return nil, 0, err
        }
        return subQuery, end, nil
    }

    field := p.defaultField
    i := 0

    // Check for field:value syntax
    if len(tokens) >= 3 && tokens[0].typ == tokenField && tokens[1].typ == tokenColon {
        field = tokens[0].value
        i = 2
    }

    if i >= len(tokens) {
        return nil, 0, fmt.Errorf("missing term after field")
    }

    token := tokens[i]

    // Phrase query
    if token.typ == tokenPhrase {
        terms := strings.Fields(token.value)
        return &PhraseQuery{
            Field: field,
            Terms: terms,
            Slop:  0,
            Boost: 1.0,
        }, i + 1, nil
    }

    // Range query
    if token.typ == tokenLBracket {
        // Parse [start TO end]
        if i+4 >= len(tokens) {
            return nil, 0, fmt.Errorf("invalid range query")
        }

        return &RangeQuery{
            Field:        field,
            LowerBound:   tokens[i+1].value,
            UpperBound:   tokens[i+3].value,
            IncludeLower: true,
            IncludeUpper: true,
            Boost:        1.0,
        }, i + 5, nil
    }

    // Term query with potential modifiers
    term := token.value
    consumed := i + 1

    // Check for fuzzy (~)
    if consumed < len(tokens) && tokens[consumed].typ == tokenTilde {
        maxEdits := 2
        consumed++

        // Check for edit distance number
        if consumed < len(tokens) && tokens[consumed].typ == tokenTerm {
            if dist, err := strconv.Atoi(tokens[consumed].value); err == nil {
                maxEdits = dist
                consumed++
            }
        }

        return &FuzzyQuery{
            Field:    field,
            Term:     term,
            MaxEdits: maxEdits,
            Boost:    1.0,
        }, consumed, nil
    }

    // Check for boost (^)
    boost := 1.0
    if consumed < len(tokens) && tokens[consumed].typ == tokenCaret {
        consumed++
        if consumed < len(tokens) && tokens[consumed].typ == tokenTerm {
            if b, err := strconv.ParseFloat(tokens[consumed].value, 64); err == nil {
                boost = b
                consumed++
            }
        }
    }

    // Check for wildcard
    if strings.ContainsAny(term, "*?") {
        return &WildcardQuery{
            Field:   field,
            Pattern: term,
            Boost:   boost,
        }, consumed, nil
    }

    return &TermQuery{
        Field: field,
        Term:  term,
        Boost: boost,
    }, consumed, nil
}
```

### 4.3 Query Executor

The executor recursively walks the AST, retrieves posting lists for term nodes, and combines them using sorted-merge intersection (AND), union (OR), and difference (NOT) operations.

```go
// internal/query/executor/executor.go
package executor

import (
    "sort"

    "github.com/yourorg/gosearch/internal/index/inverted"
    "github.com/yourorg/gosearch/internal/index/posting"
    "github.com/yourorg/gosearch/internal/query/parser"
    "github.com/yourorg/gosearch/internal/ranking"
)

// SearchResult represents a single search result
type SearchResult struct {
    DocID uint32
    Score float64
    Doc   *inverted.Document
}

// SearchResults holds all search results
type SearchResults struct {
    Results    []SearchResult
    TotalHits  int
    MaxScore   float64
    QueryTime  int64 // Microseconds
}

// Executor executes queries against an index
type Executor struct {
    index  *inverted.InvertedIndex
    scorer ranking.Scorer
}

func NewExecutor(index *inverted.InvertedIndex, scorer ranking.Scorer) *Executor {
    return &Executor{
        index:  index,
        scorer: scorer,
    }
}

// Execute runs a query and returns results
func (e *Executor) Execute(query parser.Query, limit int) (*SearchResults, error) {
    // Get matching posting list
    postingList, err := e.executeQuery(query)
    if err != nil {
        return nil, err
    }

    if postingList == nil || len(postingList.Postings) == 0 {
        return &SearchResults{
            Results:   []SearchResult{},
            TotalHits: 0,
        }, nil
    }

    // Score documents
    results := make([]SearchResult, 0, len(postingList.Postings))
    for _, p := range postingList.Postings {
        doc, ok := e.index.GetDocument(p.DocID)
        if !ok {
            continue
        }

        score := e.scorer.Score(query, p, e.index)
        results = append(results, SearchResult{
            DocID: p.DocID,
            Score: score,
            Doc:   doc,
        })
    }

    // Sort by score
    sort.Slice(results, func(i, j int) bool {
        return results[i].Score > results[j].Score
    })

    // Apply limit
    totalHits := len(results)
    if limit > 0 && limit < len(results) {
        results = results[:limit]
    }

    maxScore := 0.0
    if len(results) > 0 {
        maxScore = results[0].Score
    }

    return &SearchResults{
        Results:   results,
        TotalHits: totalHits,
        MaxScore:  maxScore,
    }, nil
}

func (e *Executor) executeQuery(query parser.Query) (*posting.PostingList, error) {
    switch q := query.(type) {
    case *parser.TermQuery:
        return e.executeTermQuery(q)

    case *parser.PhraseQuery:
        return e.executePhraseQuery(q)

    case *parser.BoolQuery:
        return e.executeBoolQuery(q)

    case *parser.FuzzyQuery:
        return e.executeFuzzyQuery(q)

    case *parser.WildcardQuery:
        return e.executeWildcardQuery(q)

    case *parser.PrefixQuery:
        return e.executePrefixQuery(q)

    case *parser.MatchAllQuery:
        return e.executeMatchAllQuery(q)

    default:
        return nil, fmt.Errorf("unsupported query type: %T", query)
    }
}

func (e *Executor) executeTermQuery(q *parser.TermQuery) (*posting.PostingList, error) {
    pl, ok := e.index.Search(q.Field, q.Term)
    if !ok {
        return posting.NewPostingList(q.Term), nil
    }
    return pl, nil
}

func (e *Executor) executePhraseQuery(q *parser.PhraseQuery) (*posting.PostingList, error) {
    if len(q.Terms) == 0 {
        return posting.NewPostingList(""), nil
    }

    // Get posting lists for all terms
    postingLists := make([]*posting.PostingList, 0, len(q.Terms))
    for _, term := range q.Terms {
        pl, ok := e.index.Search(q.Field, term)
        if !ok {
            // Term not found - phrase cannot match
            return posting.NewPostingList(""), nil
        }
        postingLists = append(postingLists, pl)
    }

    // Find documents containing all terms
    result := postingLists[0]
    for i := 1; i < len(postingLists); i++ {
        result = posting.Intersect(result, postingLists[i])
    }

    // Filter by position (phrase matching)
    phraseResult := posting.NewPostingList(q.Field + ":\"" + strings.Join(q.Terms, " ") + "\"")

    for _, p := range result.Postings {
        if e.matchesPhrase(p.DocID, q, postingLists) {
            phraseResult.Add(p.DocID, p.Positions)
        }
    }

    return phraseResult, nil
}

func (e *Executor) matchesPhrase(docID uint32, q *parser.PhraseQuery, postingLists []*posting.PostingList) bool {
    // Get positions for each term in this document
    termPositions := make([][]uint32, len(postingLists))
    for i, pl := range postingLists {
        p, ok := pl.Get(docID)
        if !ok {
            return false
        }
        termPositions[i] = p.Positions
    }

    // Check if terms appear in sequence with allowed slop
    for _, firstPos := range termPositions[0] {
        matches := true
        for i := 1; i < len(termPositions); i++ {
            expectedPos := firstPos + uint32(i)
            found := false

            for _, pos := range termPositions[i] {
                distance := int(pos) - int(expectedPos)
                if distance < 0 {
                    distance = -distance
                }
                if distance <= q.Slop {
                    found = true
                    break
                }
            }

            if !found {
                matches = false
                break
            }
        }

        if matches {
            return true
        }
    }

    return false
}

func (e *Executor) executeBoolQuery(q *parser.BoolQuery) (*posting.PostingList, error) {
    var result *posting.PostingList

    // Process MUST clauses (AND)
    for i, clause := range q.Must {
        pl, err := e.executeQuery(clause)
        if err != nil {
            return nil, err
        }

        if i == 0 {
            result = pl
        } else {
            result = posting.Intersect(result, pl)
        }
    }

    // Process SHOULD clauses (OR)
    if len(q.Must) == 0 && len(q.Should) > 0 {
        for i, clause := range q.Should {
            pl, err := e.executeQuery(clause)
            if err != nil {
                return nil, err
            }

            if i == 0 {
                result = pl
            } else {
                result = posting.Union(result, pl)
            }
        }
    }

    // Process MUST_NOT clauses (subtract)
    for _, clause := range q.MustNot {
        pl, err := e.executeQuery(clause)
        if err != nil {
            return nil, err
        }

        if result != nil {
            result = e.subtract(result, pl)
        }
    }

    if result == nil {
        result = posting.NewPostingList("")
    }

    return result, nil
}

func (e *Executor) subtract(a, b *posting.PostingList) *posting.PostingList {
    result := posting.NewPostingList(a.Term)

    bDocs := make(map[uint32]struct{})
    for _, p := range b.Postings {
        bDocs[p.DocID] = struct{}{}
    }

    for _, p := range a.Postings {
        if _, exists := bDocs[p.DocID]; !exists {
            result.Postings = append(result.Postings, p)
            result.DocCount++
        }
    }

    return result
}

func (e *Executor) executeFuzzyQuery(q *parser.FuzzyQuery) (*posting.PostingList, error) {
    // Get all terms and find similar ones using Levenshtein distance
    result := posting.NewPostingList(q.Term + "~")

    e.index.ForEachTerm(func(term string, pl *posting.PostingList) bool {
        // Extract term without field prefix
        parts := strings.SplitN(term, ":", 2)
        if len(parts) != 2 || parts[0] != q.Field {
            return true
        }

        termText := parts[1]

        if e.fuzzyMatch(q.Term, termText, q.MaxEdits, q.PrefixLength) {
            result = posting.Union(result, pl)
        }

        return true
    })

    return result, nil
}

func (e *Executor) fuzzyMatch(term1, term2 string, maxEdits, prefixLen int) bool {
    // Check prefix
    minLen := len(term1)
    if len(term2) < minLen {
        minLen = len(term2)
    }

    if minLen < prefixLen {
        return false
    }

    if term1[:prefixLen] != term2[:prefixLen] {
        return false
    }

    // Calculate Levenshtein distance
    distance := levenshteinDistance(term1[prefixLen:], term2[prefixLen:])
    return distance <= maxEdits
}

func levenshteinDistance(s1, s2 string) int {
    r1 := []rune(s1)
    r2 := []rune(s2)

    if len(r1) == 0 {
        return len(r2)
    }
    if len(r2) == 0 {
        return len(r1)
    }

    // Create distance matrix
    dp := make([][]int, len(r1)+1)
    for i := range dp {
        dp[i] = make([]int, len(r2)+1)
        dp[i][0] = i
    }
    for j := range dp[0] {
        dp[0][j] = j
    }

    for i := 1; i <= len(r1); i++ {
        for j := 1; j <= len(r2); j++ {
            cost := 1
            if r1[i-1] == r2[j-1] {
                cost = 0
            }

            dp[i][j] = min(
                dp[i-1][j]+1,      // Deletion
                dp[i][j-1]+1,      // Insertion
                dp[i-1][j-1]+cost, // Substitution
            )
        }
    }

    return dp[len(r1)][len(r2)]
}

func (e *Executor) executeWildcardQuery(q *parser.WildcardQuery) (*posting.PostingList, error) {
    result := posting.NewPostingList(q.Pattern)

    e.index.ForEachTerm(func(term string, pl *posting.PostingList) bool {
        parts := strings.SplitN(term, ":", 2)
        if len(parts) != 2 || parts[0] != q.Field {
            return true
        }

        if wildcardMatch(q.Pattern, parts[1]) {
            result = posting.Union(result, pl)
        }

        return true
    })

    return result, nil
}

func wildcardMatch(pattern, text string) bool {
    // Simple wildcard matching (* and ?)
    if pattern == "*" {
        return true
    }

    // Convert to regex-like matching
    pr := []rune(pattern)
    tr := []rune(text)

    return wildcardMatchRunes(pr, tr, 0, 0)
}

func wildcardMatchRunes(pattern, text []rune, pi, ti int) bool {
    if pi == len(pattern) && ti == len(text) {
        return true
    }

    if pi == len(pattern) {
        return false
    }

    if pattern[pi] == '*' {
        // Try matching zero or more characters
        for i := ti; i <= len(text); i++ {
            if wildcardMatchRunes(pattern, text, pi+1, i) {
                return true
            }
        }
        return false
    }

    if ti == len(text) {
        return false
    }

    if pattern[pi] == '?' || pattern[pi] == text[ti] {
        return wildcardMatchRunes(pattern, text, pi+1, ti+1)
    }

    return false
}

func (e *Executor) executePrefixQuery(q *parser.PrefixQuery) (*posting.PostingList, error) {
    result := posting.NewPostingList(q.Prefix + "*")

    e.index.ForEachTerm(func(term string, pl *posting.PostingList) bool {
        parts := strings.SplitN(term, ":", 2)
        if len(parts) != 2 || parts[0] != q.Field {
            return true
        }

        if strings.HasPrefix(parts[1], q.Prefix) {
            result = posting.Union(result, pl)
        }

        return true
    })

    return result, nil
}

func (e *Executor) executeMatchAllQuery(q *parser.MatchAllQuery) (*posting.PostingList, error) {
    result := posting.NewPostingList("*:*")

    stats := e.index.Stats()
    for docID := uint32(1); docID <= stats.DocCount; docID++ {
        if doc, ok := e.index.GetDocument(docID); ok {
            result.Add(doc.ID, []uint32{0})
        }
    }

    return result, nil
}

// Note: Uses builtin min() available since Go 1.21
```

### Junior → FAANG: Query Parsing as a Compiler Construction Exercise

The query parser in this chapter (tokenize the query string, parse into an AST, execute the AST against the index) is a simplified compiler pipeline. The same three-stage approach (lexing, parsing, evaluation) appears in every language interpreter and SQL engine. Working through this implementation gives you transferable skills for understanding how databases parse SQL or how scripting languages parse code.

For interviews, describe the query language by its supported operations: term queries ("apple"), phrase queries ("apple pie"), boolean operators (AND, OR, NOT), and range filters (price:[10 TO 100]). Each operation type has a corresponding AST node type. The executor pattern-matches on the AST node type to choose the correct retrieval strategy.

Fuzzy matching (tolerating edit distance 1 or 2) is worth understanding at the conceptual level even if you did not implement it. Levenshtein distance (minimum edit operations to transform one string to another) is a common algorithm interview question. Know how to compute it with dynamic programming.

### Senior @ FAANG: Query Language as a User Contract

At senior level, the query language is a user contract. Once users depend on a specific query syntax, changing it is a breaking change. Adding new operators (fine) is backward compatible. Removing operators (breaking) requires a deprecation process. Changing the semantics of an operator (confusing) requires clear documentation and migration guidance.

Query planning (choosing the most efficient execution strategy given the query structure) is the gap between a naive implementation and a production search engine. A naive executor evaluates the query AST top-down in the written order. A query planner reorders evaluation to minimize intermediate result set sizes: if one term has a posting list of 1000 documents and another has 10,000,000, start with the smaller list. Elasticsearch's query planner and the `_explain` API (which shows the query plan) are useful references for understanding production-grade query optimization.

Query understanding (interpreting user intent beyond literal keyword matching) is the ML extension of query parsing. Named entity recognition, spell correction, query expansion with synonyms, and intent classification (is "apple" a fruit query or a technology company query?) are all components of a production search system's query understanding layer. These components are typically implemented as ML models rather than rule-based parsers, and they preprocess the user query before it reaches the query parser.

---
