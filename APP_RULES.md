# cusPokerTools — MANDATORY APP RULES

These are hard requirements for the app's behavior. Do not regress them.

---

## RULE 1: ALWAYS SHOW THE EXACT SYNTAX THAT WENT INTO THE CALCULATOR (NON-NEGOTIABLE)

Every result — in BOTH the Simulations tab and the AI Assistant tab — MUST display the **exact, complete, copy-pasteable PPT syntax** that was actually computed, so the user can re-check it later (e.g. paste it into real ProPokerTools to verify).

The result block MUST always include, clearly labeled:
- **game** (holdem / omaha / doubleboard)
- **every player's exact range string**, one line per player, in order, with the hero marked. Percentages stay as their literal token (`10%`, `30%`, `15%-30%`) — that IS the exact syntax a user types into PPT. Specific hands show as their exact cards (`AdQdKhTh`).
- **board** (exact cards, or — if none)
- **dead** (exact cards, or — if none)

And the RESULT section MUST show **every player's equity** (not just the hero's), each next to the exact range it corresponds to, plus the combo count for range players.

### Why
The user has flagged this repeatedly and emphatically. The equity number is only trustworthy if the user can see — and later re-verify — the EXACT query that produced it. A result that hides the syntax (or shows only the hero's equity in a multiway pot, or lumps two villains into one number) is unverifiable and unacceptable. "Show the syntax, every time, copy-pasteable, with every player's equity" is the contract.

### Where this is enforced in code
- `parser/nl-query.js` → `formatResultBlock(query, result)` renders the EXACT SYNTAX + per-player RESULT block (AI tab).
- The Simulations tab results renderer must follow the same contract once it routes through the N-way engine.

---

## RULE 2: NEVER SILENTLY DROP A PLAYER OR CAP A RANGE

- A multiway query with N players (any mix of exact hands, ranges, percentages) MUST compute and display ALL N players. Never keep only the first range and discard the rest.
- Never silently cap a range at a fixed sample (the old "80 of 499 combos" bug). Either enumerate exhaustively or sample with enough trials for convergence, and state the trial count honestly.
- Equities across all players MUST sum to ~100%.

---

## RULE 3: NO HALLUCINATED / UNVERIFIED COMMENTARY

- The result's factual lines (board texture, etc.) must be COMPUTED from the cards, never guessed by an LLM. (A rainbow board must never be described as having "flush draws.")
- The math block is rendered deterministically by the app, not written by the model.

---

## RULE 4: THE ENGINE BEHIND BOTH TABS MUST BE THE SAME VALIDATED ENGINE

- The Simulations tab and the AI Assistant tab must use the SAME validated N-way equity engine (`parser/ppt-equity.js` + `ppt-eval.js` + the parsers). They must not diverge: the same query must give the same answer in either tab.
