# TOFIX

Pre-existing behavior quirks found while extracting editor-agnostic core modules
during the LSP migration (see PLAN.md). All of them were **preserved as-is**, because
each fix changes user-visible behavior and does not belong in a port. Tests pin the
current behavior, so fixing an item means updating its test too.

## 1. Relevance is encoded into `sortText` on two different scales

`src/core/completion-suggestions.ts:439` (indexed elements) starts at char code 97,
`src/core/completion-suggestions.ts:548` (built-in Angular elements) starts at 96:

```ts
`${String.fromCharCode(97 - relevance)}${insertText}`   // indexed
`${String.fromCharCode(96 - match.relevance)}${stdSelector}` // built-in
```

An indexed element with relevance 4 therefore produces the exact same `sortText`
prefix as a built-in with relevance 3, and the two are ordered arbitrarily. The two
scales are not comparable, even though the suggestions land in the same list.

Pinned by: "boosts a directive whose class name matches the attribute it offers"
in `src/test/suite/completion-suggestions.test.ts`.

Suggested fix: one shared scale, and a zero-padded numeric prefix
(e.g. `String(1000 - relevance).padStart(4, "0")`) instead of arithmetic on char codes.

## 2. The final sort disagrees with the order editors apply

`src/core/completion-suggestions.ts:577` sorts by `sortText.localeCompare(...)`.
Under locale collation the char-code encoding above comes out scrambled:

```
rel2 < rel6 < rel4 < rel5 < rel1 < rel3 < rel0 < rel7
```

Not user-visible today: VS Code and LSP clients re-sort by `sortText` with ordinal
comparison, where the encoding is correct (descending relevance). But the array we
hand out is not in the order the user sees, which makes the list misleading to test
against and to reason about.

Suggested fix: sort ordinally (`a.sortText < b.sortText ? -1 : ...`), or drop the
internal sort and treat `sortText` as the single source of order. Do this together
with item 1.

## 3. The tag-scoped relevance boost is practically unreachable, and inserts a broken attribute when it fires

`src/core/completion-suggestions.ts:357` adds +5 when the selector starts with the
tag under the cursor (`button[matButton]` inside `<button `). It only fires when the
full selector `button[matButton]` passes the prefix filter, which requires the user
to have typed nothing after the tag name — as soon as they type `mat`, only the
`matButton` / `[matButton]` trie variants match and the boost is gone.

Worse, when it does fire the attribute name is extracted from the whole selector, so
`insertText` becomes the literal `button[matButton]`
(`src/core/completion-suggestions.ts:310` → `:338`). Accepting the item writes
`<button button[matButton]`.

Pinned by: "boosts a directive selector scoped to the tag under the cursor" in
`src/test/suite/completion-suggestions.test.ts`.

Suggested fix: strip the leading tag name in `extractAttributeName` for
`tag[attr]`-shaped selectors, and apply the boost on the bare attribute variant so it
survives typing.

## 4. A quoted `>` on an opening-tag line hides the tag from backwards search

`src/core/completion-context.ts:202-203` compares raw `<`/`>` positions when
searching backwards for an unclosed opening tag, while `containsClosingTagBracket`
(quote-aware) is only used when checking whether the tag is closed. So:

```html
<div *ngIf="count > 5"
  matTool|          <!-- no completion context at all -->
```

The `>` inside the attribute value makes the line look closed, and completion goes
dead for the rest of that tag. Multi-line cases where the quoted `>` is not on the
opening line work fine.

Pinned by: "stops the backwards search at a line whose last > is quoted (existing
limitation)" in `src/test/suite/completion-context.test.ts`.

Suggested fix: use `containsClosingTagBracket` for the backwards search too.
