## 102P.5 Collaborative Text Editing (OT)

Operational Transform enables Google Docs-style collaborative editing. OT models a document as a sequence of operations, retain, insert, delete, and defines a `transform` function that adjusts a concurrent operation's position offsets so it can be applied on top of an already-applied operation without corrupting the document. The server acts as the authority: it receives each client's operation, transforms it against all operations committed since the client's last known revision, applies it to the canonical document state, and broadcasts the transformed operation to all other connected clients.

```go
package ot

import (
	"fmt"
	"sync"
	"unicode/utf8"
)

// OpType is the type of an operation
type OpType int

const (
	Retain OpType = iota // retain N characters (unchanged)
	Insert              // insert a string
	Delete              // delete N characters
)

// Op is a single operation in the document
type Op struct {
	Type  OpType
	Count int    // for Retain and Delete
	Text  string // for Insert
}

// Delta is a sequence of operations describing a document transformation
type Delta struct {
	Ops []Op
}

func (d *Delta) Retain(n int) *Delta {
	if n <= 0 {
		return d
	}
	if len(d.Ops) > 0 && d.Ops[len(d.Ops)-1].Type == Retain {
		d.Ops[len(d.Ops)-1].Count += n
		return d
	}
	d.Ops = append(d.Ops, Op{Type: Retain, Count: n})
	return d
}

func (d *Delta) Insert(text string) *Delta {
	if text == "" {
		return d
	}
	if len(d.Ops) > 0 && d.Ops[len(d.Ops)-1].Type == Insert {
		d.Ops[len(d.Ops)-1].Text += text
		return d
	}
	d.Ops = append(d.Ops, Op{Type: Insert, Text: text})
	return d
}

func (d *Delta) Delete(n int) *Delta {
	if n <= 0 {
		return d
	}
	if len(d.Ops) > 0 && d.Ops[len(d.Ops)-1].Type == Delete {
		d.Ops[len(d.Ops)-1].Count += n
		return d
	}
	d.Ops = append(d.Ops, Op{Type: Delete, Count: n})
	return d
}

// Apply applies a delta to a string and returns the result
func Apply(text string, delta Delta) (string, error) {
	runes := []rune(text)
	pos := 0
	var result []rune

	for _, op := range delta.Ops {
		switch op.Type {
		case Retain:
			if pos+op.Count > len(runes) {
				return "", fmt.Errorf("retain exceeds document length")
			}
			result = append(result, runes[pos:pos+op.Count]...)
			pos += op.Count

		case Insert:
			result = append(result, []rune(op.Text)...)

		case Delete:
			if pos+op.Count > len(runes) {
				return "", fmt.Errorf("delete exceeds document length")
			}
			pos += op.Count // skip deleted characters
		}
	}

	// Implicit retain for remaining characters
	result = append(result, runes[pos:]...)
	return string(result), nil
}

// Transform transforms operation a against operation b (for OT)
// Returns (a', b') where a' can be applied after b, and b' can be applied after a
func Transform(a, b Delta) (Delta, Delta) {
	var aPrime, bPrime Delta
	aOps := sliceOps(a.Ops)
	bOps := sliceOps(b.Ops)

	for len(aOps) > 0 && len(bOps) > 0 {
		aHead := aOps[0]
		bHead := bOps[0]

		switch {
		case aHead.Type == Insert:
			aPrime.Insert(aHead.Text)
			bPrime.Retain(utf8.RuneCountInString(aHead.Text))
			aOps = aOps[1:]

		case bHead.Type == Insert:
			aPrime.Retain(utf8.RuneCountInString(bHead.Text))
			bPrime.Insert(bHead.Text)
			bOps = bOps[1:]

		case aHead.Type == Retain && bHead.Type == Retain:
			minLen := min(aHead.Count, bHead.Count)
			aPrime.Retain(minLen)
			bPrime.Retain(minLen)
			aOps = consumeOp(aOps, minLen)
			bOps = consumeOp(bOps, minLen)

		case aHead.Type == Delete && bHead.Type == Delete:
			minLen := min(aHead.Count, bHead.Count)
			aOps = consumeOp(aOps, minLen)
			bOps = consumeOp(bOps, minLen)

		case aHead.Type == Retain && bHead.Type == Delete:
			minLen := min(aHead.Count, bHead.Count)
			bPrime.Delete(minLen)
			aOps = consumeOp(aOps, minLen)
			bOps = consumeOp(bOps, minLen)

		case aHead.Type == Delete && bHead.Type == Retain:
			minLen := min(aHead.Count, bHead.Count)
			aPrime.Delete(minLen)
			aOps = consumeOp(aOps, minLen)
			bOps = consumeOp(bOps, minLen)
		}
	}

	// Handle remaining ops
	for _, op := range aOps {
		switch op.Type {
		case Insert:
			aPrime.Insert(op.Text)
			bPrime.Retain(utf8.RuneCountInString(op.Text))
		case Delete:
			aPrime.Delete(op.Count)
		case Retain:
			aPrime.Retain(op.Count)
			bPrime.Retain(op.Count)
		}
	}
	for _, op := range bOps {
		switch op.Type {
		case Insert:
			bPrime.Insert(op.Text)
			aPrime.Retain(utf8.RuneCountInString(op.Text))
		case Delete:
			bPrime.Delete(op.Count)
		case Retain:
			bPrime.Retain(op.Count)
			aPrime.Retain(op.Count)
		}
	}

	return aPrime, bPrime
}

func sliceOps(ops []Op) []Op {
	result := make([]Op, len(ops))
	copy(result, ops)
	return result
}

func consumeOp(ops []Op, n int) []Op {
	if len(ops) == 0 {
		return ops
	}
	first := ops[0]
	if first.Type == Retain || first.Type == Delete {
		if first.Count == n {
			return ops[1:]
		}
		ops[0].Count -= n
	}
	return ops
}

// Note: Uses builtin min() available since Go 1.21

// CollaborativeDocument manages shared document state with OT
type CollaborativeDocument struct {
	mu       sync.Mutex
	content  string
	version  int
	history  []VersionedOp
}

type VersionedOp struct {
	Version int
	Delta   Delta
	Author  string
}

func NewCollaborativeDocument(initial string) *CollaborativeDocument {
	return &CollaborativeDocument{content: initial}
}

// Apply applies an operation from a client at a given base version
func (d *CollaborativeDocument) ApplyOp(op Delta, baseVersion int, author string) (Delta, int, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	// Transform op against all ops since baseVersion
	transformed := op
	for _, hist := range d.history[baseVersion:] {
		transformed, _ = Transform(transformed, hist.Delta)
	}

	// Apply to document
	newContent, err := Apply(d.content, transformed)
	if err != nil {
		return Delta{}, 0, fmt.Errorf("apply op: %w", err)
	}

	d.content = newContent
	d.version++
	d.history = append(d.history, VersionedOp{
		Version: d.version,
		Delta:   transformed,
		Author:  author,
	})

	return transformed, d.version, nil
}

func (d *CollaborativeDocument) Content() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.content
}

func (d *CollaborativeDocument) Version() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.version
}
```

### Junior → FAANG: Why OT Requires a Central Server

Operational Transform's dependence on a central server is a fundamental property, not an implementation choice. The reason: OT's transform function computes the adjusted position of a concurrent operation relative to a specific operation that has already been applied. If two servers independently receive different sequences of operations and transform independently, they may produce different document states (this is the "dOPT puzzle" from the OT literature). Correctness requires a single server that defines the canonical operation order.

This is the key difference from CRDTs: CRDTs are correct without a central coordinator because their merge function is commutative. OT is correct only with a central coordinator that serializes operations.

Interview entry point: explain OT as "client sends operation with the document revision it was based on, server transforms the operation to account for all operations committed since that revision, applies it to the canonical document, and broadcasts the transformed operation." The revision number is the synchronization point.

### Senior @ FAANG: OT at Google Scale and the Limits of the Approach

Google Docs uses OT with a server-authority model. The server holds the canonical document state and all clients' pending operation queues. This works well for documents edited by tens of users concurrently. At hundreds of concurrent editors (a live event document, a popular shared note), the server becomes a bottleneck: every operation requires a round trip to the server and broadcasting to all editors.

The scaling solutions for OT at high concurrency: server sharding by document section (different sections of the document handled by different server instances, with coordination only when an operation crosses a section boundary), or migrating to CRDT-based approaches for the high-concurrency case. The field's research center of gravity has moved from Operational Transformation toward CRDT-based approaches for modern collaborative editing, because OT's central server requirement is the binding constraint for multi-region and offline-first use cases.

The design question at L6: for a new collaborative editing product, choose OT or CRDT? The answer depends on: does the product need offline-first (CRDT), multi-region with active-active editing (CRDT), or server-side undo with global history (OT is simpler for this)? Document this decision in an ADR with the specific product requirements that drove the choice.

---
