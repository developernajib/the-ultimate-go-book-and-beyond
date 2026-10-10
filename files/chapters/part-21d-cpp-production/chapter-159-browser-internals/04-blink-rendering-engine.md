## 159.4 Blink Rendering Engine

Blink is the rendering engine that lives in `third_party/blink/renderer/`. It owns the DOM, CSS, layout, paint, and the connection between JavaScript and the rest of the platform. Blink was forked from WebKit's WebCore in April 2013 and has diverged substantially since.

### The Pipeline

A frame's lifecycle on the main thread, simplified:

```
Parse HTML/CSS  ->  Build DOM tree
                   |
                   v
                Style recalc (compute used values per element)
                   |
                   v
                Layout tree build  (LayoutObject per visible node)
                   |
                   v
                Layout (compute box positions and sizes)
                   |
                   v
                Pre-paint (compute paint properties: transforms, clips)
                   |
                   v
                Paint (record into a display list)
                   |
                   v
                Compositor (cc/) raster + draw
                   |
                   v
                GPU process composites surfaces -> screen
```

Each phase is incremental and dirty-bit driven. A change to one element's `color` does not relayout the document, it dirties paint for that element. A change to its `width` dirties layout for the subtree. A change to `display: none` dirties layout up to the nearest containing block.

### DOM Tree

The DOM is a tree of `Node` objects, all on the Oilpan heap. The hierarchy:

```
Node                                  (base)
 +- ContainerNode
 |   +- Document
 |   +- Element
 |   |   +- HTMLElement
 |   |   |   +- HTMLDivElement
 |   |   |   +- HTMLInputElement
 |   |   |   +- ...
 |   |   +- SVGElement
 |   |   +- MathMLElement
 |   +- DocumentFragment
 |       +- ShadowRoot
 +- CharacterData
 |   +- Text
 |   +- Comment
 +- DocumentType
 +- Attr (legacy, not in tree)
```

`Element` carries a `NamedNodeMap` of attributes and a pointer to `ElementRareData` (lazily allocated for elements with shadow roots, custom-element state, etc.).

DOM tree edits are O(1) amortized for `appendChild`, `insertBefore`, `removeChild`. The cost is in the invalidation they trigger, not the tree edit itself.

### Oilpan: BlinkGC

Most C++ codebases use `std::unique_ptr` and `std::shared_ptr` for ownership. Blink does not, because the DOM is a graph with cycles (an `Element` points to children, children point back to the parent, event listeners hold the element, the element holds a list of listeners). Reference counting would leak, and refactoring every cycle to weak pointers would be unmaintainable.

Oilpan is a tracing garbage collector for C++ in Blink. Objects derive from `GarbageCollected<T>`, fields use `Member<T>` and `WeakMember<T>` instead of raw pointers, and the GC traces the object graph.

```cpp
class Element : public ContainerNode {
 public:
  void Trace(Visitor* visitor) const override {
    visitor->Trace(attributes_);
    visitor->Trace(class_list_);
    visitor->Trace(rare_data_);
    ContainerNode::Trace(visitor);
  }

 private:
  Member<NamedNodeMap> attributes_;
  Member<DOMTokenList> class_list_;
  Member<ElementRareData> rare_data_;
};
```

Every `Member<>` field must be traced. Forgetting a Trace is the canonical Blink bug: the field gets collected mid-use and the next access is a use-after-free that AddressSanitizer catches with a fresh stack.

Oilpan uses incremental marking, concurrent marking, and concurrent sweeping under the hood. The collector is tuned to avoid pauses over 5 ms on the main thread.

`Persistent<T>` is the Oilpan equivalent of a root: a strong reference held outside the Oilpan heap (in C++ stack-rooted code or in non-Oilpan classes). `CrossThreadPersistent<T>` is for references from another thread.

### Style Recalc

CSS resolution is the most performance-sensitive phase for content-heavy pages. The model is:

1. Parse CSS into `StyleRule` objects organized into `RuleSet`s by selector hash.
2. For each element, find matching rules. Sort by cascade order and specificity.
3. Apply the cascade to produce `ComputedStyle`.
4. Reuse `ComputedStyle` across siblings when the values match (style sharing).

The naive implementation is O(elements * rules), which on a 5000-element page with 10000 rules is 50 million selector matches. Blink avoids this with:

- **Bloom filter ancestor pruning.** For descendant selectors `.foo .bar`, walk up from the candidate element, hash each ancestor's classes/IDs/tags into a Bloom filter, and skip rules whose required ancestor hash is not in the filter.
- **Right-to-left selector matching.** Selectors are matched starting at the rightmost compound, which is the element being styled. Most selectors fail at the first compound, terminating quickly.
- **RuleSet bucketing by rightmost compound.** Rules are bucketed by ID, class, tag, or attribute name of their rightmost compound. An element with class `btn` only checks the `.btn` bucket, not the entire stylesheet.
- **Style sharing.** Two siblings with identical classes, attributes, and inline styles often produce the same `ComputedStyle`. Blink detects this and reuses the result.

Style invalidation tracks which elements need recalc when a stylesheet, attribute, or class changes:

```cpp
// Simplified: a class change on element invalidates the rules that
// depend on that class.
void Element::ClassAttributeChanged(const AtomicString& new_value) {
  ClassChangedFromAttribute change_info{old_classes_, new_value};
  GetDocument()
      .GetStyleEngine()
      .ScheduleInvalidationsForClassChange(*this, change_info);
}
```

The invalidation set system encodes "if class X changes on an element, invalidate descendants matching subset Y" rather than re-running the entire selector matcher.

### Layout Tree

After style, Blink builds the layout tree. Each visible DOM element gets a `LayoutObject`. Some DOM nodes (display: none, head, script) get no LayoutObject. Some get more than one (a list item creates a marker plus the item itself).

```
LayoutObject                          (base)
 +- LayoutBox                         (anything with a CSS box model)
 |   +- LayoutBlock
 |   |   +- LayoutBlockFlow           (block flow container)
 |   |   +- LayoutNGFlexibleBox
 |   |   +- LayoutNGGrid
 |   +- LayoutInline                  (inline-level)
 |   +- LayoutReplaced                (img, video, canvas, iframe)
 +- LayoutText                        (text runs)
 +- LayoutTableCell, LayoutTableRow, ...
```

Layout (positioning) runs over this tree. Modern Blink uses LayoutNG ("Next Generation"), a rewrite that produces an immutable `NGFragment` tree as output. Fragments are cacheable across layout runs, which makes subtree re-layout cheap when only some descendants changed.

Layout is the single most expensive phase for complex pages. A `getBoundingClientRect()` from JavaScript synchronously flushes pending layout, which is the canonical "layout thrash" pattern: alternating reads and writes in a loop forces N layouts instead of 1.

### Paint and Pre-Paint

Pre-paint walks the layout tree computing paint properties: transforms, clips, effects, scroll. Each element produces a node in the paint property tree. The compositor uses these trees to skip relayout when only a transform changes (the GPU re-composites with a new matrix, no Blink work needed).

Paint walks the layout tree producing a display list (`PaintRecord`, a list of `DisplayItem`s). Each display item is a Skia draw operation, parameterized but not yet executed. The display list is handed to `cc/` for rasterization.

### Lifecycle Phases

`DocumentLifecycle` is a state machine that enforces phase ordering:

```
kVisualUpdatePending
kInStyleRecalc
kStyleClean
kInPerformLayout
kAfterPerformLayout
kLayoutClean
kInCompositingUpdate
kCompositingInputsClean
kInPrePaint
kPrePaintClean
kInPaint
kPaintClean
```

Blink asserts on phase order: you cannot read layout while in style recalc, you cannot mutate the DOM during paint. These asserts catch a class of bugs where script runs in the wrong phase (custom layout APIs in the past were rife with this).

### Frames, Documents, and the Top-Level View

A `Frame` corresponds to a `<frame>`/`<iframe>` or the top-level browsing context. `LocalFrame` lives in a renderer that owns the frame's content. `RemoteFrame` is a placeholder for a frame hosted in another renderer.

Each `LocalFrame` has at most one `Document` at a time (which is replaced on navigation). Each Document has its own DOM, its own style engine, its own LayoutView at the root, and its own V8 context.

### Worklets and Workers

Animation worklets, paint worklets, layout worklets (CSS Houdini) run on dedicated worker threads with their own V8 isolates. They cannot touch the DOM directly. They communicate with the main thread through structured-cloned messages, the same as Web Workers.

Service Workers and Web Workers each get their own V8 isolate too, which is why a Service Worker fetch handler does not block the main thread.

### Senior Interview Material

- "Why does Blink use a custom GC (Oilpan) instead of `std::shared_ptr`?"
- "Walk me through what happens between `element.style.width = '100px'` and the next paint."
- "Why is `getBoundingClientRect()` followed by a style write a performance bug?"
- "What does `contain: layout` do, and why is it sometimes a 10x speedup?"
- "Describe the right-to-left selector matching algorithm and why Blink uses it."

The next section opens up V8, which lives next to Blink in the same process and provides every JavaScript heap object that those `Element`s expose to script.

---
