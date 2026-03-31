# Review Decisions

### `/answer` can hard-fail due to strict model ID matching

- **Severity**: P1
- **Reviewer said**: `resolveModel()` only accepts an exact ID match and returns `undefined` otherwise, making `/answer` unusable when the default model is not configured but other models are available.
- **Decision**: Fixed
- **Reason**: Added fallback `?? available[0]` so if the preferred model is not found, the first available model is used instead. The env var override still takes priority for exact match.

---

### Unvalidated extracted questions can crash the questionnaire UI

- **Severity**: P1
- **Reviewer said**: If LLM extraction returns a question with `allowOther: false` and empty `options`, pressing Enter dereferences `undefined` from `opts[optionIndex]` on an empty array.
- **Decision**: Fixed
- **Reason**: `parseExtractedQuestions` now forces `allowOther: true` when `options` is empty (`options.length === 0 || q.allowOther !== false`), ensuring there is always at least the "Type something" option rendered.

---

### Duplicate extracted question IDs can collapse answers

- **Severity**: P2
- **Reviewer said**: `parseExtractedQuestions()` trusts LLM-provided `id` field. Duplicate IDs cause the `answers` map to overwrite prior answers, making `allAnswered()` report true early.
- **Decision**: Fixed
- **Reason**: Changed to always use index-based IDs (`q${i + 1}`) instead of trusting LLM output, guaranteeing uniqueness.

---

### `parseExtractedQuestions` assumes `questions` is always an array

- **Severity**: P2
- **Reviewer said**: If the LLM returns `{ "questions": {} }`, assigning to `raw` and calling `.filter()` throws since filter is not a function on non-arrays.
- **Decision**: Fixed
- **Reason**: Added `Array.isArray(parsed?.questions)` guard; falls back to empty array if not an array.

---

### `options` elements are not validated before property access

- **Severity**: P2
- **Reviewer said**: Option entries are cast to `Record<string, unknown>` without checking type. A `null` entry throws on property access.
- **Decision**: Fixed
- **Reason**: Added `.filter()` on option entries to reject non-objects before mapping, matching the same pattern used for question-level validation.

---

### `/answer` dereferences `ctx.ui` when UI is unavailable

- **Severity**: P1
- **Reviewer said**: In the `!ctx.hasUI` branch, calling `ctx.ui.notify()` could throw if `ui` is not guaranteed to exist.
- **Decision**: Disagree
- **Reason**: `ctx.ui` is always present on `ExtensionContext` (it is a required field on the interface, not optional). `hasUI` indicates whether interactive features like `ctx.ui.custom()` are available, but `notify()` is safe in all modes. Multiple other extensions in this project use the identical pattern (`review/index.ts`, `btw.ts`, `todo.ts`). This is an established convention.

---
