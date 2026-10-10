## 159.9 CSS Cascade and Style System

CSS is, at the C++ implementation level, one of the most algorithmically interesting parts of a browser. The naive view is "match selectors against elements, apply rules". The real problem is doing that for tens of thousands of elements against tens of thousands of rules, in under 8 milliseconds per frame, while invalidating only what changed.

### The Cascade

For each element, the value of each CSS property is determined by the cascade. The order of precedence:

1. Origin and importance.
 1. Transition declarations (`@keyframes` mid-transition).
 2. User agent `!important` declarations (browser stylesheet).
 3. User `!important` (browser settings).
 4. Author `!important` (page CSS).
 5. Animation declarations.
 6. Author normal declarations.
 7. User normal.
 8. User agent normal.
2. Layer order (CSS Cascade Layers, `@layer`).
3. Specificity.
4. Order of appearance.

Higher precedence wins. This 8-level priority system is implemented as a single 64-bit cascade priority key that gets compared lexicographically.

```cpp
// Simplified from blink::CascadeOrigin and CascadePriority.
struct CascadePriority {
  uint64_t key;  // Packed: origin << 56 | layer_order << 32
                 //         | specificity << 16 | source_order
};
```

Comparing two declarations is one 64-bit integer comparison.

### Specificity

Specificity is a 4-tuple `(inline, ID, class+attr+pseudo, type+pseudo-element)`, often written `0,1,2,3`. Each component is an unsigned 16-bit count.

```
#nav .item:hover  ->  (0, 1, 2, 0)
div p             ->  (0, 0, 0, 2)
button[type=...]  ->  (0, 0, 1, 1)
```

Implementations pack specificity into a 32-bit or 64-bit int and compare numerically.

### Selector Matching

A selector like `.nav > li:hover .icon` matches against an element by walking right to left (the rightmost compound is the candidate element). The algorithm:

```cpp
bool MatchSelector(const Element& element, const CSSSelector& selector) {
  // selector_index walks right to left over the compound chain.
  const Element* current = &element;
  for (const CSSSelector* part = &selector; part; part = part->TagHistory()) {
    if (!MatchSimpleSelector(*current, *part))
      return false;

    switch (part->Relation()) {
      case kSubSelector:           // No combinator: same compound, continue.
        break;
      case kDescendant:            // Walk up ancestors.
        current = current->ParentElement();
        while (current && !MatchRest(current, part->TagHistory()))
          current = current->ParentElement();
        return current != nullptr;
      case kChild:                 // Direct parent only.
        current = current->ParentElement();
        if (!current) return false;
        break;
      // ... sibling combinators ...
    }
  }
  return true;
}
```

Right-to-left wins because most selectors fail at the first compound. A selector like `body p` evaluated against a `<span>` rejects immediately when matching `p` against the `<span>` tag.

### Rule Bucketing

Naively, every rule has to be matched against every element. With N rules and M elements that is N*M selector matches.

Blink (and WebKit before it) buckets rules by their rightmost compound:

```cpp
// blink::RuleSet, simplified.
class RuleSet {
 public:
  const RuleSet::RuleIterator& IdRules(const AtomicString& id);
  const RuleSet::RuleIterator& ClassRules(const AtomicString& cls);
  const RuleSet::RuleIterator& TagRules(const AtomicString& tag);
  const RuleSet::RuleIterator& UniversalRules();
  // ...
};
```

When styling an element with id `foo`, classes `btn primary`, tag `button`, Blink only checks rules in `IdRules("foo") + ClassRules("btn") + ClassRules("primary") + TagRules("button") + UniversalRules()`. A rule like `.unrelated > div` is in `TagRules("div")` and never considered for the button.

### Bloom Filter Ancestor Pruning

Even with bucketing, descendant selectors are expensive: `.foo .bar` requires walking ancestors of every `.bar` to find a `.foo`.

Blink builds a Bloom filter of the element's ancestors' identifying features (id, classes, tags) before styling each element:

```cpp
// blink::SelectorFilter, simplified.
class SelectorFilter {
 public:
  void PushParent(const Element& parent);
  void PopParent();

  // Returns true if rule's required ancestor signatures might match.
  bool ParentStackIsConsistentWith(const CSSSelector& selector) const;

 private:
  CountingBloomFilter<8> ancestor_filter_;
};
```

For each rule, Blink precomputes a list of "required identifier hashes" (hashes of each id/class/tag that must appear among ancestors). Before running the rule's selector match, it tests these against the filter. A miss in the filter means the rule cannot match. This eliminates most rules without running selector match at all.

### Style Sharing

Many sibling elements have identical computed styles. A list of 1000 list items, identical classes, identical inline styles, identical attributes: they all compute the same style. Computing each one independently wastes time.

Blink's `MatchedPropertiesCache` keys on the matched-rules result and reuses computed styles. Then sibling sharing keys on the parent + element fingerprint and reuses the entire `ComputedStyle` directly.

```cpp
// Blink::StyleResolver tries this before doing real work:
ComputedStyle* MaybeShareStyleWithSibling(const Element& element);
```

Sharing fails (and the slow path runs) if any of: the element has a `:hover` ancestor, the element has an `id`, the element has direct child or adjacent-sibling rule dependencies, the element has inline styles different from siblings, etc.

### Style Invalidation

When a class, attribute, or pseudo-state changes on an element, Blink does not re-style the whole document. The invalidation set system precomputes "which descendants need recalc when class X changes on this element":

```cpp
// blink::InvalidationSet describes the impact of one class/id/attribute change.
class InvalidationSet {
 public:
  bool InvalidatesSelf() const;
  bool WholeSubtreeInvalid() const;
  const HashSet<AtomicString>& Classes() const;
  const HashSet<AtomicString>& Attributes() const;
  const HashSet<AtomicString>& TagNames() const;
};
```

When the user hovers over an element, Blink looks up the invalidation sets for `:hover` and recurses into descendants only if the descendant matches one of the named classes/tags/attributes. This bounds invalidation to O(affected elements), not O(document size).

### Computed Styles

After cascade and inheritance, every element has a `ComputedStyle`: a flat struct of every CSS property's value, in absolute units, ready for layout.

```cpp
class ComputedStyle : public ComputedStyleBase {
 public:
  EDisplay Display() const;
  const Length& Width() const;
  const Color& BackgroundColor() const;
  // ... hundreds of accessors ...

 private:
  // The class is roughly 400 bytes today, packed via field-bit selection
  // and several "rare data" pointers for uncommon properties.
};
```

`ComputedStyle` is shared across elements through copy-on-write. Adjacent elements with identical styles point to the same `ComputedStyle` instance. A class change that produces the same computed values does not allocate a new style.

### Cascade Layers (`@layer`)

CSS Cascade Layers were added to the spec in 2022 and shipped in Chrome 99. They give author CSS a layer order that takes precedence over specificity:

```css
@layer reset, components, overrides;

@layer reset { button { background: gray; } }
@layer overrides { button { background: blue; } }
```

The `overrides` layer wins over `reset` regardless of specificity. Blink implements this as an extra field in the cascade priority key.

### CSS Custom Properties (`--foo`)

Custom properties are inherited by default and resolved late: `--accent: blue; color: var(--accent)`. The cascade resolves the custom property first, then substitutes when computing dependent properties.

Custom properties have invalidation challenges: changing `--accent` on `:root` may affect any descendant that uses `var(--accent)` directly or transitively. Blink tracks per-property dependencies to bound invalidation.

### Containment

`contain: layout` and `contain: paint` give Blink permission to skip layout and paint of descendants when ancestors change. `content-visibility: auto` skips rendering for off-screen elements. These are escape hatches for pages with massive DOMs (chat applications, virtualized lists). They can produce 10x to 100x speedups.

### Senior Interview Material

- "Walk me through the algorithm Blink uses to match `.nav > li:hover .icon` against a candidate element."
- "Why does Blink match selectors right to left?"
- "What is the Bloom filter ancestor pruning, and what is its false-positive cost?"
- "How does style sharing work, and when does it bail out?"
- "Explain `contain: layout` at the layout-tree level. Why is it sometimes a 10x speedup?"

The next section walks through HTML parsing, which builds the DOM that the style system then operates on.

---
