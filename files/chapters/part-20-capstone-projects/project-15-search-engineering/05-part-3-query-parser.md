## Part 3: Query Parser

When a user types a search query like `golang AND concurrency OR "goroutine pool"`, the search engine needs to understand the structure of that query before it can execute it. A query parser takes the raw text string and converts it into a tree of operations, term lookups, boolean combinations (AND, OR, NOT), phrase matches, field-scoped searches, and wildcard patterns. This is similar to how a programming language compiler parses source code into an abstract syntax tree. The parser below uses a recursive descent approach, which processes the query left to right and builds a tree where each node represents one operation. The tree is then walked to extract terms and execute them against the inverted index.

```go
package query

import (
	"fmt"
	"strings"
	"unicode"
)

// QueryType represents the type of a query node
type QueryType int

const (
	TermQuery   QueryType = iota
	PhraseQuery           // "exact phrase"
	AndQuery              // term AND term
	OrQuery               // term OR term
	NotQuery              // NOT term
	FieldQuery            // field:value
	RangeQuery            // field:[low TO high]
	WildcardQuery         // term*
)

// Query is a parsed query tree node
type Query struct {
	Type     QueryType
	Term     string    // for TermQuery, WildcardQuery
	Phrase   []string  // for PhraseQuery
	Field    string    // for FieldQuery
	Left     *Query    // for AndQuery, OrQuery
	Right    *Query    // for AndQuery, OrQuery
	Child    *Query    // for NotQuery
	RangeLow string    // for RangeQuery
	RangeHigh string   // for RangeQuery
	Boost    float64   // query boost (e.g., term^2.0)
}

// Parser parses query strings into Query trees
type Parser struct {
	defaultField string
	defaultOp    QueryType // AndQuery or OrQuery
}

func NewParser() *Parser {
	return &Parser{
		defaultField: "body",
		defaultOp:    OrQuery,
	}
}

// Parse parses a query string
func (p *Parser) Parse(input string) (*Query, error) {
	tokens := p.tokenize(input)
	if len(tokens) == 0 {
		return nil, fmt.Errorf("empty query")
	}
	q, _, err := p.parseExpr(tokens, 0)
	return q, err
}

type tokenType int

const (
	tokenTerm    tokenType = iota
	tokenAND
	tokenOR
	tokenNOT
	tokenLParen
	tokenRParen
	tokenPhrase
	tokenField   // "field:value"
)

type token struct {
	typ   tokenType
	value string
}

func (p *Parser) tokenize(input string) []token {
	var tokens []token
	i := 0
	for i < len(input) {
		// Skip whitespace
		for i < len(input) && unicode.IsSpace(rune(input[i])) {
			i++
		}
		if i >= len(input) {
			break
		}

		switch {
		case input[i] == '"': // phrase
			j := i + 1
			for j < len(input) && input[j] != '"' {
				j++
			}
			phrase := input[i+1 : j]
			tokens = append(tokens, token{typ: tokenPhrase, value: phrase})
			if j < len(input) {
				j++
			}
			i = j

		case input[i] == '(':
			tokens = append(tokens, token{typ: tokenLParen})
			i++

		case input[i] == ')':
			tokens = append(tokens, token{typ: tokenRParen})
			i++

		default: // word
			j := i
			for j < len(input) && !unicode.IsSpace(rune(input[j])) &&
				input[j] != '(' && input[j] != ')' && input[j] != '"' {
				j++
			}
			word := input[i:j]
			i = j

			switch strings.ToUpper(word) {
			case "AND":
				tokens = append(tokens, token{typ: tokenAND})
			case "OR":
				tokens = append(tokens, token{typ: tokenOR})
			case "NOT", "-":
				tokens = append(tokens, token{typ: tokenNOT})
			default:
				// Check for field:value pattern
				if idx := strings.Index(word, ":"); idx > 0 {
					tokens = append(tokens, token{typ: tokenField, value: word})
				} else {
					tokens = append(tokens, token{typ: tokenTerm, value: word})
				}
			}
		}
	}
	return tokens
}

func (p *Parser) parseExpr(tokens []token, pos int) (*Query, int, error) {
	left, pos, err := p.parsePrimary(tokens, pos)
	if err != nil {
		return nil, pos, err
	}

	for pos < len(tokens) {
		switch tokens[pos].typ {
		case tokenAND:
			pos++
			right, newPos, err := p.parsePrimary(tokens, pos)
			if err != nil {
				return nil, newPos, err
			}
			left = &Query{Type: AndQuery, Left: left, Right: right}
			pos = newPos

		case tokenOR:
			pos++
			right, newPos, err := p.parsePrimary(tokens, pos)
			if err != nil {
				return nil, newPos, err
			}
			left = &Query{Type: OrQuery, Left: left, Right: right}
			pos = newPos

		case tokenRParen:
			return left, pos, nil

		default:
			// Implicit operator (default)
			right, newPos, err := p.parsePrimary(tokens, pos)
			if err != nil {
				return left, pos, nil // stop here
			}
			left = &Query{Type: p.defaultOp, Left: left, Right: right}
			pos = newPos
		}
	}

	return left, pos, nil
}

func (p *Parser) parsePrimary(tokens []token, pos int) (*Query, int, error) {
	if pos >= len(tokens) {
		return nil, pos, fmt.Errorf("unexpected end of query")
	}

	tok := tokens[pos]
	switch tok.typ {
	case tokenTerm:
		boost := 1.0
		term := tok.value
		if idx := strings.Index(term, "^"); idx > 0 {
			fmt.Sscanf(term[idx+1:], "%f", &boost)
			term = term[:idx]
		}
		q := &Query{Type: TermQuery, Term: term, Field: p.defaultField, Boost: boost}
		if strings.HasSuffix(term, "*") {
			q.Type = WildcardQuery
			q.Term = strings.TrimSuffix(term, "*")
		}
		return q, pos + 1, nil

	case tokenPhrase:
		words := strings.Fields(tok.value)
		return &Query{Type: PhraseQuery, Phrase: words, Field: p.defaultField}, pos + 1, nil

	case tokenField:
		parts := strings.SplitN(tok.value, ":", 2)
		return &Query{Type: FieldQuery, Field: parts[0], Term: parts[1]}, pos + 1, nil

	case tokenNOT:
		child, newPos, err := p.parsePrimary(tokens, pos+1)
		if err != nil {
			return nil, newPos, err
		}
		return &Query{Type: NotQuery, Child: child}, newPos, nil

	case tokenLParen:
		inner, newPos, err := p.parseExpr(tokens, pos+1)
		if err != nil {
			return nil, newPos, err
		}
		if newPos < len(tokens) && tokens[newPos].typ == tokenRParen {
			newPos++
		}
		return inner, newPos, nil
	}

	return nil, pos, fmt.Errorf("unexpected token: %v", tok)
}

// Execute evaluates a parsed query against an index
func (p *Parser) Execute(q *Query, scorer *BM25Scorer) []SearchResult {
	terms := extractTerms(q)
	if len(terms) == 0 {
		return nil
	}
	return scorer.Search(terms, 100)
}

func extractTerms(q *Query) []Term {
	if q == nil {
		return nil
	}
	switch q.Type {
	case TermQuery, WildcardQuery:
		return []Term{Term(q.Term)}
	case PhraseQuery:
		terms := make([]Term, len(q.Phrase))
		for i, w := range q.Phrase {
			terms[i] = Term(w)
		}
		return terms
	case FieldQuery:
		return []Term{Term(q.Term)}
	case AndQuery, OrQuery:
		return append(extractTerms(q.Left), extractTerms(q.Right)...)
	case NotQuery:
		return nil // NOT queries are exclusion filters
	}
	return nil
}
```

---
