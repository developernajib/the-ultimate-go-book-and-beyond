## Deep Dive: CRDT Alternative (Yjs-Compatible)

CRDTs (Conflict-free Replicated Data Types) offer a fundamentally different approach to collaborative editing compared to OT. Instead of transforming operations against each other on a central server, CRDTs assign each character a unique, globally ordered ID so that any two replicas can merge independently and always converge to the same result. The implementation below is modeled on the YATA algorithm used by Yjs, one of the most popular CRDT libraries, simplified to per-character items with an RGA-style integration rule. Each character tracks its left and right origin neighbors at insertion time, and conflicts between concurrent inserts at the same position are resolved deterministically using the character IDs.

```go
package crdt

type YataCharacter struct {
	ID CharID; Content rune; Deleted bool
	OriginLeft *CharID; OriginRight *CharID
}

type CharID struct { ClientID int; Clock int }

func (c CharID) Less(o CharID) bool {
	if c.Clock != o.Clock { return c.Clock < o.Clock }
	return c.ClientID < o.ClientID
}

type YDoc struct {
	ClientID int; Clock int; Characters []YataCharacter
}

func NewYDoc(clientID int) *YDoc {
	return &YDoc{ClientID: clientID}
}

func (d *YDoc) Insert(pos int, content rune) CharID {
	d.Clock++
	id := CharID{d.ClientID, d.Clock}
	vi := d.visibleIndex(pos)
	var oL, oR *CharID
	if vi > 0 { l := d.Characters[vi-1].ID; oL = &l }
	if vi < len(d.Characters) { r := d.Characters[vi].ID; oR = &r }
	ch := YataCharacter{ID: id, Content: content, OriginLeft: oL, OriginRight: oR}
	d.Characters = append(d.Characters, YataCharacter{})
	copy(d.Characters[vi+1:], d.Characters[vi:])
	d.Characters[vi] = ch
	return id
}

func (d *YDoc) Delete(pos int) {
	vi := d.visibleIndex(pos)
	if vi < len(d.Characters) { d.Characters[vi].Deleted = true }
}

func (d *YDoc) IntegrateRemote(ch YataCharacter) {
	// Merge the remote clock (Lamport rule) so later local inserts
	// always get a higher clock than anything already integrated
	if ch.ID.Clock > d.Clock { d.Clock = ch.ID.Clock }
	li, ri := -1, len(d.Characters)
	if ch.OriginLeft != nil {
		for i, c := range d.Characters { if c.ID == *ch.OriginLeft { li = i; break } }
	}
	if ch.OriginRight != nil {
		for i, c := range d.Characters { if c.ID == *ch.OriginRight { ri = i; break } }
	}
	// Skip concurrent items with a greater ID, stop at the first
	// smaller one. Breaking here is what guarantees convergence:
	// scanning past a smaller ID would re-order concurrent inserts
	// differently on different replicas
	idx := li + 1
	for i := li + 1; i < ri; i++ {
		if !ch.ID.Less(d.Characters[i].ID) { break }
		idx = i + 1
	}
	d.Characters = append(d.Characters, YataCharacter{})
	copy(d.Characters[idx+1:], d.Characters[idx:])
	d.Characters[idx] = ch
}

func (d *YDoc) Text() string {
	var r []rune
	for _, c := range d.Characters { if !c.Deleted { r = append(r, c.Content) } }
	return string(r)
}

func (d *YDoc) visibleIndex(pos int) int {
	v := 0
	for i, c := range d.Characters { if !c.Deleted { if v == pos { return i }; v++ } }
	return len(d.Characters)
}
```

### OT vs CRDT Trade-offs

| Aspect | OT (Google Docs) | CRDT (Yjs/Automerge) |
|--------|-----------------|---------------------|
| Central server | Required | Not required |
| Offline | Complex queue+replay | Native merge |
| Memory | Low | Higher (tombstones) |
| Rich text | Battle-tested | Improving |
| Consistency | Server-authoritative | Eventually consistent |

---
