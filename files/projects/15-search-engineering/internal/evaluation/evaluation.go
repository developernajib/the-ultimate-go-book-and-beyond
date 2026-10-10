package evaluation

import (
	"encoding/json"
	"os"
	"sort"

	"github.com/example/search-engineering/internal/metrics"
)

// JudgmentSet holds human relevance labels for a set of (query, doc) pairs.
type JudgmentSet struct {
	Queries []QueryJudgment `json:"queries"`
}

// QueryJudgment holds the judgment labels for one query.
type QueryJudgment struct {
	Query     string             `json:"query"`
	Judgments map[string]float64 `json:"judgments"` // docID -> relevance label
}

// EvaluationResult holds computed metrics for one query.
type EvaluationResult struct {
	Query    string
	NDCGAt10 float64
	MRR      float64
}

// EvaluateRanker runs the provided search function against all queries in the
// judgment set and returns per-query metrics plus aggregate means.
func EvaluateRanker(
	judgments JudgmentSet,
	searchFn func(query string) []string, // returns ranked doc IDs
) (results []EvaluationResult, meanNDCG, meanMRR float64) {
	for _, qj := range judgments.Queries {
		rankedDocs := searchFn(qj.Query)

		// Build relevance vector from judgment labels.
		rels := make([]float64, len(rankedDocs))
		binaryRels := make([]int, len(rankedDocs))
		for i, docID := range rankedDocs {
			rels[i] = qj.Judgments[docID] // 0 if not judged (treat as irrelevant)
			if rels[i] >= 2 {
				binaryRels[i] = 1
			}
		}

		// Build ideal ordering.
		ideal := make([]float64, 0, len(qj.Judgments))
		for _, v := range qj.Judgments {
			ideal = append(ideal, v)
		}
		sort.Sort(sort.Reverse(sort.Float64Slice(ideal)))

		ndcg := metrics.NDCGAtK(rels, ideal, 10)
		mrr := metrics.MRR([][]int{binaryRels})

		results = append(results, EvaluationResult{
			Query:    qj.Query,
			NDCGAt10: ndcg,
			MRR:      mrr,
		})
		meanNDCG += ndcg
		meanMRR += mrr
	}
	if len(results) > 0 {
		meanNDCG /= float64(len(results))
		meanMRR /= float64(len(results))
	}
	return results, meanNDCG, meanMRR
}

// LoadJudgmentSet loads a judgment set from a JSON file.
func LoadJudgmentSet(path string) (JudgmentSet, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return JudgmentSet{}, err
	}
	var js JudgmentSet
	return js, json.Unmarshal(data, &js)
}
