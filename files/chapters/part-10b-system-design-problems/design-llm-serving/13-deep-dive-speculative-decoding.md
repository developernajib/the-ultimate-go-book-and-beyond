## Deep Dive: Speculative Decoding

Speculative decoding is an optimization technique that uses a small, fast "draft" model to predict several tokens ahead, and then has the large "oracle" model verify all of them in a single forward pass. Because the verification step processes all candidate tokens in parallel (rather than one at a time), accepted tokens are essentially free in terms of latency. When the draft model guesses wrong, the oracle's token is used instead, so output quality is never compromised. This technique typically delivers a 2-3x throughput improvement with no quality loss.

```go
package speculative

import "context"

type Token struct {
	ID           int
	Text         string
	FinishReason string
}

type ModelWorker interface {
	GenerateN(ctx context.Context, input []int, n int) ([]Token, error)
	GenerateOne(ctx context.Context, input []int) (Token, error)
	ForwardPass(ctx context.Context, input []int) ([][]float64, error)
}

// Small draft model (7B) generates K tokens quickly
// Large oracle model (70B) verifies all K in single forward pass
// Accepted tokens = free speedup, rejected = fall back to oracle
// Net: 2-3x throughput improvement

type SpeculativeDecoder struct {
	draftModel, oracleModel ModelWorker
	specLength              int // typically 3-5
}

func (s *SpeculativeDecoder) Generate(ctx context.Context, input []int, maxTokens int) ([]Token, error) {
	var output []Token
	current := input

	for len(output) < maxTokens {
		drafts, err := s.draftModel.GenerateN(ctx, current, s.specLength)
		if err != nil {
			// Draft model unavailable: degrade to plain oracle decoding
			tok, err := s.oracleModel.GenerateOne(ctx, current)
			if err != nil {
				return output, err
			}
			output = append(output, tok)
			current = append(current, tok.ID)
			continue
		}

		ids := make([]int, len(drafts))
		for i, d := range drafts {
			ids[i] = d.ID
		}

		// One oracle forward pass scores every draft position in parallel
		logits, err := s.oracleModel.ForwardPass(ctx, append(current, ids...))
		if err != nil {
			return output, err
		}

		// Logits at position p predict the token at p+1, so draft i
		// (sitting at position len(current)+i) is verified against
		// logits[len(current)+i-1]
		accepted := 0
		for i, draft := range drafts {
			oracle := sampleFromLogits(logits[len(current)+i-1])
			if oracle.ID == draft.ID {
				output = append(output, draft)
				accepted++
				continue
			}
			// First mismatch: take the oracle's token and stop accepting
			output = append(output, oracle)
			accepted++
			break
		}

		for _, t := range output[len(output)-accepted:] {
			current = append(current, t.ID)
		}
		if output[len(output)-1].FinishReason != "" {
			break
		}
	}
	return output, nil
}

func sampleFromLogits(logits []float64) Token {
	return Token{} // simplified: argmax or temperature sampling in production
}
```

---
