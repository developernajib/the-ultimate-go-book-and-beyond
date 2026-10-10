## 159.10 HTML Parser and DOM Construction

Parsing HTML looks easy until you actually do it. The HTML5 spec normalizes a 30-year history of malformed markup, document.write quirks, encoding sniffs, and SVG/MathML foreign content. Blink's parser at `third_party/blink/renderer/core/html/parser/` is a faithful implementation of the spec, plus speculative parsing, plus streaming, plus integration with the network loader.

### The Two-Stage Spec

The HTML5 parsing algorithm is two-stage:

1. **Tokenizer.** A state machine over input bytes. Produces a stream of tokens: `StartTag`, `EndTag`, `Character`, `Comment`, `Doctype`, `EOF`.
2. **Tree builder.** Consumes tokens, maintains a stack of open elements and the document tree, and applies the spec's per-state insertion modes.

```cpp
// Simplified Blink layout in third_party/blink/renderer/core/html/parser/
class HTMLTokenizer {
  enum class State {
    kData, kRCDATA, kRawText, kPlainText, kTagOpen, kEndTagOpen,
    kTagName, kBeforeAttributeName, kAttributeName, /* ~70 more */
  };
  State state_;
  HTMLToken* token_;
};

class HTMLTreeBuilder {
  enum class InsertionMode {
    kInitial, kBeforeHTML, kBeforeHead, kInHead,
    kAfterHead, kInBody, kText, kInTable, kInTableText, kInCaption,
    kInColumnGroup, kInTableBody, kInRow, kInCell, kInSelect, /* ... */
  };
  InsertionMode mode_;
  HeapVector<Member<Element>> open_elements_stack_;
};
```

The tokenizer alone has ~80 states. The tree builder's insertion modes implement the messy parts of legacy HTML (autoclosing `<p>` tags, foster parenting around tables, foreign content reentry).

### Streaming and Encoding

The parser is fed bytes incrementally as the network delivers them. The first few hundred bytes are sniffed for encoding (BOM, `<meta charset>`, HTTP `Content-Type`). If the sniff later proves wrong, the parser may have to restart.

```
Network bytes  ->  Encoding sniffer  ->  Decoder (UTF-8 / Windows-1252 / ...)
                                          |
                                          v
                                       Code units (UTF-16)
                                          |
                                          v
                                       Tokenizer
                                          |
                                          v
                                       Tree builder
                                          |
                                          v
                                       DOM (live)
```

Each stage is incremental. A 200 KB document does not buffer fully in any one stage, tokens emit as soon as enough input has arrived.

### Speculative Parsing

A `<script>` tag without `async` or `defer` blocks parsing: the parser must wait for the script to download and execute before continuing, because the script could call `document.write`. This is the #1 cause of slow page loads in legacy code.

Blink mitigates this with speculative parsing. While the main parser is blocked, a background "preload scanner" continues tokenizing the document looking for `<link>`, `<script>`, `<img>` references. It does not build DOM. Its only output is preload requests fired into the network stack ahead of when the parser would have requested them.

```cpp
// Simplified blink::HTMLPreloadScanner
class HTMLPreloadScanner {
 public:
  // Runs on a background thread. Tokenizes ahead.
  void Scan(SegmentedString input);

  // Emits preload hints to the resource loader.
};
```

The result: by the time the blocking script returns, the next ten resources are already in the cache. Speculative parsing is one of the highest-use optimizations in modern browsers.

### document.write

`document.write` is a leftover from when HTML was streamed over slow modems. It inserts characters into the input stream at the current parse position. The tokenizer must consume those characters before continuing with the network bytes that came after the script.

The implementation: each `document.write` call splices a new `SegmentedString` into the parser's input. The parser pops back to the spliced data, tokenizes it, then resumes the original stream.

`document.write` defeats speculative parsing because the speculation does not know what bytes the script will inject. Modern Chrome aggressively warns about and sometimes outright blocks `document.write` of script tags from third-party origins.

### Tree Construction Quirks

A subset of the legacy weirdness the tree builder handles:

- **Implicit close tags.** `<p>foo<p>bar` produces two siblings, not nesting, because `<p>` cannot contain `<p>`.
- **Foster parenting.** A stray `<div>` inside `<table>` (but outside `<td>`) is moved to before the table.
- **Optional tags.** `<html>`, `<head>`, `<body>`, `<tbody>`, `<tr>`, `<td>` are all optional in many positions.
- **Active formatting elements.** `<b>1<i>2</b>3</i>` produces `<b>1<i>2</i></b><i>3</i>` ("the adoption agency algorithm").
- **Foreign content.** `<svg>` and `<math>` switch to XML-flavored parsing rules and back.

Each of these has a corresponding insertion mode and specific transitions. The spec is tested by web-platform-tests with thousands of cases.

### DOM Construction

Tokens become DOM nodes through `HTMLConstructionSite::InsertElement` and friends:

```cpp
void HTMLConstructionSite::InsertHTMLElement(AtomicHTMLToken* token) {
  Element* element = CreateHTMLElement(token);
  AttachLater(CurrentNode(), element);
  open_elements_.Push(element);
  // Custom-element reactions, mutation observers, slotting all kicked.
}
```

`AttachLater` defers actually inserting the element until a yield point, batching DOM inserts to minimize style invalidation churn.

### Custom Elements

`document.createElement('my-element')` triggers the custom-element registry. The constructor (a class extending `HTMLElement`) runs in the V8 context. Lifecycle callbacks fire at well-defined points:

- `connectedCallback()` when the element enters the document.
- `disconnectedCallback()` when removed.
- `attributeChangedCallback(name, old, new)` for observed attributes.
- `adoptedCallback()` on cross-document moves.

The parser handles custom elements through the "custom element reactions" stack: callbacks are queued during parsing and flushed at safe yield points to avoid re-entering the parser from script.

### Yielding to the Event Loop

Parsing a multi-megabyte document on the main thread cannot block paint and input indefinitely. The parser yields periodically to the event loop. The yield points are governed by `kDefaultYieldDelay` and run after every batch of tokens, allowing layout, paint, and input handling to interleave.

### Network and Body Loader Integration

In modern Chrome, the parser receives bytes through the `BodyTextDecoder`, which receives bytes from the network service through a Mojo data pipe. The pipe uses shared memory ring buffers, the renderer never copies bytes from the network process beyond the data pipe boundary.

```
Network process: TCP / TLS / HTTP/2
   ->  data_pipe (shared mem ring)  ->  Renderer parser input
```

This zero-copy path is part of why Chrome's network performance is what it is.

### The DOMParser API

JavaScript's `DOMParser` API and `innerHTML` setter both run the same parser, but in "fragment parsing" mode: the algorithm starts in `kInBody` (or context-element-appropriate state) and produces a DocumentFragment. Used heavily by frameworks for HTML templating.

### Performance Numbers

- Tokenize a token: ~100 to 300 ns typical.
- Insert a DOM element: ~500 ns to 2 microseconds (allocation + tree linking + observer dispatch).
- Speculative-parse 1 MB of HTML: roughly 5 ms on desktop.
- Full DOM construction for a Gmail-sized page: 50 to 200 ms total parse time, mostly hidden behind streaming.

### Senior Interview Material

- "Why is the HTML parser a state machine and not a recursive descent parser?"
- "Walk me through speculative parsing. What does it solve?"
- "Why does `document.write` of a `<script>` tag still exist in 2025?"
- "Explain foster parenting with a code example."
- "How does the parser yield to the event loop? What goes wrong if it does not?"

The next section moves to the network stack: how those bytes got to the parser in the first place.

---
