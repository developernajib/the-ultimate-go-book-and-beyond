// internal/query/parser/parser.go
package parser

import (
	"fmt"
	"strconv"
	"strings"
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
	for i := range runes {
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
		// Skip operators at current position
		if tokens[i].typ == tokenAND || tokens[i].typ == tokenOR || tokens[i].typ == tokenNOT || tokens[i].typ == tokenMinus || tokens[i].typ == tokenPlus {
			i++
			continue
		}

		clause, consumed, err := p.parseClause(tokens[i:])
		if err != nil {
			return nil, err
		}

		// Determine operator from preceding token
		operator := p.defaultOperator
		isNegated := false
		if i > 0 {
			prevToken := tokens[i-1]
			switch prevToken.typ {
			case tokenAND:
				operator = "AND"
			case tokenOR:
				operator = "OR"
			case tokenNOT, tokenMinus:
				isNegated = true
			case tokenPlus:
				operator = "AND"
			}
		}

		// Add clause to appropriate list
		if isNegated {
			boolQuery.MustNot = append(boolQuery.MustNot, clause)
		} else if operator == "AND" {
			boolQuery.Must = append(boolQuery.Must, clause)
		} else {
			boolQuery.Should = append(boolQuery.Should, clause)
		}

		i += consumed
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

	tok := tokens[i]

	// Phrase query
	if tok.typ == tokenPhrase {
		terms := strings.Fields(tok.value)
		return &PhraseQuery{
			Field: field,
			Terms: terms,
			Slop:  0,
			Boost: 1.0,
		}, i + 1, nil
	}

	// Range query
	if tok.typ == tokenLBracket {
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
	term := tok.value
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
