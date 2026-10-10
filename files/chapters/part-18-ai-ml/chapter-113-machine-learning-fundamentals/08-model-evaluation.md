## 113.7 Model Evaluation

Accuracy alone is misleading. You need multiple metrics.

```
Confusion Matrix (Binary Classification):

                    Predicted
                 Positive  Negative
Actual Positive     TP        FN      (True Positive, False Negative)
       Negative     FP        TN      (False Positive, True Negative)

Precision = TP / (TP + FP)    "Of predictions that were positive, how many were correct?"
Recall    = TP / (TP + FN)    "Of actual positives, how many did we find?"
F1        = 2 * (Precision * Recall) / (Precision + Recall)
Accuracy  = (TP + TN) / (TP + TN + FP + FN)
```

```go
package ml

import (
    "fmt"
    "math"
)

// ConfusionMatrix for binary classification
type ConfusionMatrix struct {
    TP, TN, FP, FN float64
}

// ComputeConfusionMatrix calculates confusion matrix
// yTrue: actual labels (0 or 1)
// yPred: predicted labels (0 or 1)
func ComputeConfusionMatrix(yTrue, yPred []float64) (*ConfusionMatrix, error) {
    if len(yTrue) != len(yPred) {
        return nil, fmt.Errorf("yTrue and yPred must have same length")
    }

    cm := &ConfusionMatrix{}

    for i := range yTrue {
        if yTrue[i] == 1 && yPred[i] == 1 {
            cm.TP++
        } else if yTrue[i] == 0 && yPred[i] == 0 {
            cm.TN++
        } else if yTrue[i] == 0 && yPred[i] == 1 {
            cm.FP++
        } else if yTrue[i] == 1 && yPred[i] == 0 {
            cm.FN++
        }
    }

    return cm, nil
}

// Accuracy = (TP + TN) / Total
func (cm *ConfusionMatrix) Accuracy() float64 {
    total := cm.TP + cm.TN + cm.FP + cm.FN
    if total == 0 {
        return 0
    }
    return (cm.TP + cm.TN) / total
}

// Precision = TP / (TP + FP)
func (cm *ConfusionMatrix) Precision() float64 {
    if cm.TP+cm.FP == 0 {
        return 0
    }
    return cm.TP / (cm.TP + cm.FP)
}

// Recall = TP / (TP + FN) (also called Sensitivity or True Positive Rate)
func (cm *ConfusionMatrix) Recall() float64 {
    if cm.TP+cm.FN == 0 {
        return 0
    }
    return cm.TP / (cm.TP + cm.FN)
}

// F1Score = 2 * (Precision * Recall) / (Precision + Recall)
func (cm *ConfusionMatrix) F1Score() float64 {
    prec := cm.Precision()
    rec := cm.Recall()

    if prec+rec == 0 {
        return 0
    }
    return 2 * (prec * rec) / (prec + rec)
}

// String formats confusion matrix
func (cm *ConfusionMatrix) String() string {
    return fmt.Sprintf(`Confusion Matrix:
                Predicted
             Positive  Negative
Actual Pos   %6.0f    %6.0f
       Neg   %6.0f    %6.0f

Metrics:
  Accuracy:  %.4f
  Precision: %.4f
  Recall:    %.4f
  F1 Score:  %.4f
`,
        cm.TP, cm.FN,
        cm.FP, cm.TN,
        cm.Accuracy(),
        cm.Precision(),
        cm.Recall(),
        cm.F1Score())
}

// MSE computes Mean Squared Error (for regression)
func MSE(yTrue, yPred []float64) (float64, error) {
    if len(yTrue) != len(yPred) {
        return 0, fmt.Errorf("yTrue and yPred must have same length")
    }

    var sum float64
    for i := range yTrue {
        err := yTrue[i] - yPred[i]
        sum += err * err
    }

    return sum / float64(len(yTrue)), nil
}

// RMSE computes Root Mean Squared Error
func RMSE(yTrue, yPred []float64) (float64, error) {
    mse, err := MSE(yTrue, yPred)
    if err != nil {
        return 0, err
    }
    return math.Sqrt(mse), nil
}

// R2Score computes coefficient of determination
func R2Score(yTrue, yPred []float64) (float64, error) {
    if len(yTrue) != len(yPred) {
        return 0, fmt.Errorf("yTrue and yPred must have same length")
    }

    // Calculate mean of yTrue
    var sum float64
    for _, y := range yTrue {
        sum += y
    }
    mean := sum / float64(len(yTrue))

    // SS_res and SS_tot
    var ssRes, ssTot float64
    for i := range yTrue {
        ssRes += (yTrue[i] - yPred[i]) * (yTrue[i] - yPred[i])
        ssTot += (yTrue[i] - mean) * (yTrue[i] - mean)
    }

    if ssTot == 0 {
        return 0, fmt.Errorf("cannot compute R²: variance is zero")
    }

    return 1 - (ssRes / ssTot), nil
}
```

### Example: Evaluating a Fraud Detection Model

Fraud detection is the classic imbalanced classification problem, and the one where accuracy stops meaning anything. On a dataset with a 0.1% fraud rate, a model that predicts "not fraud" for every transaction scores 99.9% accuracy and catches nothing. This example computes the confusion matrix and derives precision, recall, and F1 from it. Threshold-independent separation is measured by ROC-AUC, which is implemented in the section that follows.

Note that the toy dataset below is balanced, five positives and five negatives, purely to keep the counts easy to follow by hand. Real fraud data looks nothing like it.

```go
package ml

import (
    "fmt"
)

func ExampleConfusionMatrix() {
    // Actual labels: 0 = legitimate, 1 = fraud
    yTrue := []float64{0, 0, 1, 1, 0, 1, 0, 1, 1, 0}

    // Model predictions
    yPred := []float64{0, 0, 1, 1, 0, 1, 1, 0, 1, 0}

    cm, _ := ComputeConfusionMatrix(yTrue, yPred)
    fmt.Println(cm)

    // Output:
    // Confusion Matrix:
    //                 Predicted
    //              Positive  Negative
    // Actual Pos        4         1
    //        Neg        1         4
    //
    // Metrics:
    //   Accuracy:  0.8000
    //   Precision: 0.8000
    //   Recall:    0.8000
    //   F1 Score:  0.8000

    // Why not just use accuracy?
    // Imagine 99% of transactions are legitimate:
    // A model that predicts everything as "legitimate" gets 99% accuracy
    // but catches 0% of fraud! Precision/Recall are crucial.
}
```

### ROC-AUC: Evaluating Without Picking a Threshold

Every metric above depends on a decision threshold. The confusion matrix is computed from hard 0/1 predictions, which means it already assumes someone chose a cutoff (0.5, by default and usually without thinking about it). ROC-AUC asks a different question: across every possible threshold, how well does the model's score separate positives from negatives?

The definition worth carrying around is the probabilistic one. ROC-AUC is the probability that a randomly chosen positive example receives a higher score than a randomly chosen negative example. That makes 0.5 exactly random, 1.0 perfect separation, and below 0.5 a model whose scores are anti-correlated with truth, which usually means an inverted label somewhere.

That definition also yields the cleanest implementation. Rather than sweeping thresholds and integrating the curve, use the equivalent rank-based (Mann-Whitney U) form, which handles tied scores correctly by assigning them their average rank. Threshold sweeping with naive tie handling is where hand-rolled AUC implementations usually go subtly wrong.

```go
package ml

import (
    "cmp"
    "fmt"
    "slices"
)

// ROCAUC computes the area under the ROC curve.
//
// yScore holds continuous scores (probabilities or raw margins), not hard
// labels: passing 0/1 predictions here collapses the curve to a single
// operating point and gives a number that is not the AUC anyone means.
//
// This uses the rank-based Mann-Whitney U identity:
//
//	AUC = (sum of ranks of positives - nPos*(nPos+1)/2) / (nPos * nNeg)
//
// Ties receive averaged ranks, which is what makes the result correct for
// models that emit many identical scores (tree ensembles, bucketed scores).
func ROCAUC(yTrue, yScore []float64) (float64, error) {
    if len(yTrue) != len(yScore) {
        return 0, fmt.Errorf("yTrue and yScore must have same length")
    }
    if len(yTrue) == 0 {
        return 0, fmt.Errorf("empty input")
    }

    idx := make([]int, len(yScore))
    for i := range idx {
        idx[i] = i
    }
    slices.SortStableFunc(idx, func(a, b int) int {
        return cmp.Compare(yScore[a], yScore[b])
    })

    // Assign ranks, averaging across ties.
    ranks := make([]float64, len(yScore))
    for i := 0; i < len(idx); {
        j := i
        for j+1 < len(idx) && yScore[idx[j+1]] == yScore[idx[i]] {
            j++
        }
        // Ranks are 1-based: positions i..j share the average rank.
        avg := (float64(i+1) + float64(j+1)) / 2
        for k := i; k <= j; k++ {
            ranks[idx[k]] = avg
        }
        i = j + 1
    }

    var nPos, nNeg, sumRanksPos float64
    for i, label := range yTrue {
        if label == 1 {
            nPos++
            sumRanksPos += ranks[i]
        } else {
            nNeg++
        }
    }

    // AUC is undefined with only one class present: there is no pair to
    // order. Return an error rather than a plausible-looking 0 or 0.5.
    if nPos == 0 || nNeg == 0 {
        return 0, fmt.Errorf("ROC-AUC undefined: need both classes, got %.0f positive and %.0f negative", nPos, nNeg)
    }

    return (sumRanksPos - nPos*(nPos+1)/2) / (nPos * nNeg), nil
}
```

A caution that matters specifically for fraud and other heavily imbalanced problems: ROC-AUC is computed from the true positive rate and the false positive rate, and the false positive rate has the large negative class in its denominator. That denominator absorbs a lot of false positives without moving the number much, so ROC-AUC can look strong while the flags your reviewers actually see are mostly wrong. When positives are rare and the cost of a false positive is paid per alert, the precision-recall curve and its average precision are the more honest summary.

### Junior → FAANG: Model Evaluation Metrics You Must Own

The accuracy trap is the first thing interviewers test. If you say "our model is 99% accurate" and you are working on fraud detection where 1% of transactions are fraudulent, a naive baseline that predicts "not fraud" for every transaction achieves 99% accuracy without catching any fraud. Know that precision (of the fraud flags raised, how many are real fraud) and recall (of all actual fraud, how many did we catch) are the metrics that matter, and know how F1-score combines them into a single number that balances the tradeoff.

ROC-AUC is the metric that appears most in ML engineering interviews because it measures model quality independently of the decision threshold. Understand that an AUC of 0.5 means the model is no better than random, 0.9 is excellent for most practical tasks, and that the curve itself tells you how precision-recall tradeoffs shift as you move the threshold. In production, you choose the threshold based on the business cost asymmetry between false positives and false negatives, not based on maximizing F1.

Implement evaluation metrics in Go from scratch at least once: a confusion matrix struct that accepts predicted and actual labels, computes precision, recall, F1, and accuracy for each class, and exposes a method to render it as a formatted table. Running this as a step in your CI pipeline against a held-out test set is a production practice that prevents model regressions from silently reaching users.

### Senior @ FAANG: Evaluation Frameworks and Business Alignment

At senior level, model evaluation is a continuous process in production, not a one-time checkpoint before deployment. Design your serving infrastructure to log every prediction and, when ground truth becomes available (the user actually committed fraud, the clicked item was purchased), to automatically compute the model's performance over the trailing 7 and 30 day windows. Route these metrics to your observability platform with alerts on degradation. This is the evaluation framework that protects the model in production after the initial deployment.

Business-aligned metrics require collaboration between engineering and product. For a recommendation model, raw precision and recall are internal metrics. The business metric might be click-through rate, time spent on page, or 30-day retention. Designing the evaluation framework to track both model metrics (precision/recall) and business metrics (CTR, retention) lets you detect cases where model performance is stable but business metrics are degrading (the model is optimizing a proxy that no longer correlates with business value) and cases where model metrics degrade but business metrics hold (the model changed its behavior but the business impact is neutral).

Offline evaluation versus online evaluation (A/B testing) is a fundamental tension. Offline evaluation on a held-out test set is fast and cheap but can be misleading because it does not capture user behavior changes in response to the model's predictions. Online A/B tests are ground truth but are slow, expensive, and expose users to potentially worse experiences. Senior engineers design shadow deployment workflows where the new model's predictions are logged alongside the current model's predictions without affecting user experience, enabling offline comparison before committing to a live A/B test.

Evaluation for generative models (LLMs, diffusion models) requires entirely different metrics. BLEU, ROUGE, and METEOR are automated text quality metrics with well-known limitations: they measure surface-level n-gram overlap, not semantic quality or factual accuracy. Human evaluation is more reliable but expensive and slow. At FAANG, the standard is a combination: automated metrics for fast iteration during development, human evaluation panels for significant model version decisions, and automated regression tests against a curated golden dataset for continuous monitoring. Designing and maintaining the golden dataset is itself a significant engineering investment.

At L6 and above, evaluation governance includes deciding who has authority to approve a new model version for production, what the minimum evaluation evidence requirements are, and how disagreements between offline and online evaluation signals are resolved. These decisions should be documented in an evaluation policy that the platform team owns and the model team follows. The policy prevents the common failure mode where a model is promoted to production based on cherry-picked evaluation results rather than a rigorous, reproducible evaluation protocol.

---
