# Bug: a class in a selector decided nothing

Fixed six times. The first attempt inverted the failure instead of removing it, and every
one after that was the same shape: a rule applied one level away from where Angular
applies it. They are written down in order, because the order is the lesson — each was
found by asking "and where does the compiler decide this", and each had looked obviously
right at the call site it was written in.

## What went wrong

`getMatchedSelectors` in `core/missing-imports` decides whether a candidate is reported
at all: no match, no diagnostic. It described the template element to Angular's matcher
with a tag and its attributes, and nothing else.

A `CssSelector` holds three things — `element`, `attrs` and `classNames` — and a `.foo`
in a selector is parsed into `classNames`, never into `attrs`. An element described only
by its attributes therefore carries **no classes at all** as far as the matcher is
concerned, whatever its `class` says.

That does not merely lose the positive case; it inverts the negative one. Every
`:not(.foo)` holds vacuously, because there is no `.foo` to find. So on

```html
<div foo class="disabled">
```

a directive selected by `[foo]:not(.disabled)` was reported as a missing import — for an
element Angular applies it to under no circumstances. A quick fix offering an import that
changes nothing, on a token that was never that directive's.

## The first fix, and why it was worse

The compiler answers this in `createCssSelectorFromNode`: for an attribute named `class`,
split the value on whitespace and `addClassName` each piece. Mirroring that at the call
site reads as a faithful copy, and it is not, because the attribute it reads is not the
attribute the compiler reads.

`ScannedTemplateElement.attributes` is flat, and the scan builds it out of static
attributes, bound inputs, outputs and references at once — with `String(attr.value)` for
the value. For a binding that is the expression's own `toString`:

```
[class]="disabled"   →   { name: "class", value: "disabled in app.component.html@0:11" }
```

Split on whitespace, that is three class names — `disabled`, `in`,
`app.component.html@0:11` — none of which the element has. The `disabled` among them then
satisfied `:not(.disabled)`, and `<div foo [class]="disabled">` stopped being reported at
all. A false positive traded for a false negative, which is the worse of the two: the
first offers a useless fix, the second hides a real missing import.

The compiler does not have this problem because it never looks at a binding's value:
`getAttrsForDirectiveMatching` maps every bound input to `''`. Directive matching happens
before any expression has a value, so a class that is only ever computed selects nothing.

## What it is now

Class names are taken where the AST still says what a node is — in `core/template-scan`,
from static text attributes only — and carried on `ScannedTemplateElement.classNames`.
The matcher is handed them directly and no longer reads the flattened `class` attribute.

The field is required rather than optional, so every place that builds a scanned element
has to say what its classes are; four of them turned up at compile time, which is the
point.

## The third and fourth: where a class comes from, and what it settles

Two more followed from the same root, and both are the shape of the second one — a rule
applied one level away from where the compiler applies it.

**A class on the element a structural directive is written on is not the template's.**
`<div *foo class="disabled">` parses into a synthetic template that keeps the `div`'s own
attributes, and the scan was reading them. Angular matches such a node against its
`templateAttrs` alone, so `*foo` is decided without the class — the directive applies, and
`[foo]:not(.disabled)` was being silenced on it. The compiler tells the two apart by
`tagName`: a written-out `<ng-template class="x">` is the case where the class does count,
and both are now tested, because a fix for one that breaks the other is easy to write.

**A `#class="ref"` is not a class.** A template reference has a name and a value that are
both plain strings, and the flattened attribute list the scan works from holds references
beside attributes. Reading the node's own `attributes` instead removes them, and a kind
check says which of those count, so neither the reading nor the check is the only thing
standing between a reference and a class.

**And a class settles which of two directives answers for the other.** `demandsOf`
compares what two selectors ask for and did not look at classes, so `[foo].a` and
`[foo].b` were one demand: on `<div foo class="a b">`, an imported `[foo].b` suppressed a
missing `[foo].a` entirely, though Angular applies both. That exclusion had been
deliberate and was written down as such — the argument being that this codebase does not
handle class selectors as a form. It handles them now, since the matcher was taught to,
and a comparison that is told less than the matcher is told will keep producing cases like
this one. Classes are part of `SelectorDemands`, sorted, and recursively inside each
`:not(...)`.

## The fifth: a binding overwrites the attribute it is named after

`getAttrsForDirectiveMatching` does not merge attributes and bindings, it *folds* them:
one map, written attributes first, then property and two-way bindings and events, and the
last writer wins with an empty value. So

```html
<div foo class="disabled" [class]="classes">
```

has no classes at all for matching — the binding overwrote the attribute — and the
compiler's own `createCssSelectorFromNode` returns `classNames: [""]` for it. Reading
only the written attributes kept `disabled`, and `[foo]:not(.disabled)` was silenced on
an element Angular does apply it to.

A `[class.disabled]` does the opposite and must: it is a *class* binding named
`disabled`, not a property binding named `class`, so it overwrites nothing and the static
classes stand. Only the binding kind separates them — `[class.class]` would be a class
binding named `class` — which is why `BindingType` had to come along with the AST node
constructors rather than the name being enough.

## The sixth: what a class does to the marker

One token carries one marker, and `rankOf` picks which selector holds it. Its first
question is whether the selector is *exactly* the attribute — no tag, no value, no
condition — and it never asked about classes, so `[foo].a` answered yes. With `[foo]` and
`[foo].a` both missing, the marker went to `[foo].a` and the diagnostic carried `.a[foo]`.
That is not cosmetic: a quick fix resolves elements by the selector in the code, and a
narrower one can miss the plain `[foo]` directive the user was after. Its second question
is how much a selector demands, counted over attributes alone, which made a class free.

Both now count classes. The first change is what stops `[foo].a` taking the marker from
`[foo]`; the second is what makes two classes outweigh one attribute.

## What the measurement still says

Of the **1804** selectors declared by the v22 fixture's dependencies, exactly **four**
mention a class, and all four mention it inside a `:not(...)`:

```
th:not(.nz-disable-th), td:not(.nz-disable-td)
thead:not(.ant-table-thead)
```

Not one selects *by* a class. That is why class matching is still not worth a search
dimension of its own — a directive selected by class would make every utility class in a
template a candidate for a missing import — and it is why all four of these bugs were
found by reading rather than by a user report. It is not a reason to leave any of them
in: the rarity bounds the blast radius, not the wrongness.

## Those four selectors are not the example

They read like the case this bug is about, and they are not: all four sit on known HTML
tags, and a known tag is only ever looked up by compound selector — `th[class]` — while
`th:not(.nz-disable-th)` is indexed under `th` and under itself. The directive never
reaches the matcher, so its class decides nothing in either direction. The reachable form
is an attribute directive whose selector carries a class condition, which is what the
example above is and what the tests use.

That boundary is itself a test, so that a later change to how known tags are looked up
does not quietly make the class rule load-bearing there without anyone noticing.

## Covered by

Two suites, because there turned out to be two questions.

`src/test/node/class-selector-matching.test.ts` — fourteen cases about **where a class
comes from**, each starting at `parseTemplate`, running the real `scanTemplate`, and
asking an index keyed by `parseAngularSelector` the way the indexer keys one. That last
part matters: an index answering every key reports `<div foo class="x">` twice, once for
`foo` and once for a `class` token no real index holds anything under, and a test built
that way would have been measuring itself.

`src/test/node/selector-rules.test.ts` — the matrix, about **what a class settles**. Its
element now carries `class="a d"` and five class-bearing selectors joined the table:
`[foo].a` and `.a[foo]`, which are one selector written two ways; `[foo]:not(.b)` against
`[foo]:not(.c)`, which are two; and `[foo].a.d`, which demands more than either. Every
pair of the fourteen is asserted against every other, which is the point of a table
rather than another example, and two marker cases sit beside it for the ranking. The
expectations are put through the compiler's own parse, because a diagnostic carries the
selector as the matcher spells it — `.a[foo]`, class first — and the table is about what
is reported, not about punctuation.

Each fix is load-bearing, checked by removing it one at a time:

| removed | what fails |
| --- | --- |
| class names entirely | 3 of the 14 integration cases |
| the static-attribute rule | the 2 bound-class cases |
| the binding-overwrites rule | the `[class]` and `[(class)]` cases |
| the synthetic-template rule | the structural-directive case |
| the attribute-kind rule | the `#class` case |
| classes in `demandsOf` | 6 rows of the matrix |
| classes in `isTheAttributeItself` | the `[foo]` marker case |
| classes in `demands` | the `[foo].a.d` marker case |
