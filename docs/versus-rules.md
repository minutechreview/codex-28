# VERSUS counting rules

This draft reads the existing sources without rewriting either. Tibo's 28 day/status/summary/source records are in `data.json`. Team metadata and the parallel `days[].grokbot` arrays are in `versus.json`. The requested all-in-one schema is not present. The adapter checks the two calendars agree. Labels, portraits, summaries and links come from those files, including the source spelling **Lauren Tan**.

## Separate hits and resets

One record explicitly classified `improvement` counts as one hit. One `reset` counts as one reset and **zero hits**, even when its prose mentions improvements. `pending` and `missed` are zero hits and zero resets. A summary is not a structured list: the adapter does not split numbered prose into invented updates. The Tibo card currently shows **3 improvement records and 2 reset records**, not a count of every feature mentioned in those summaries.

Each Grok item has an update number, summary and source, but the current 11 records have **no type/status field**. Both its improvement and reset totals are **unknown**, with 0 confirmed hits/0 confirmed resets and 11 unclassified records. This does not mean Grok shipped zero improvements. Optional explicit `status` or `type` can be interpreted by the adapter in a future owner-authored update; this draft adds none. No data file was changed.

Daily winners compare classified improvement records (resets excluded). Any unclassified or pending populated lane makes the result **UNRESOLVED**. Empty lanes show **NO MOVE**. If both lanes are empty, their recorded count is a **DRAW**, with pending/future labels retained; that does not establish a real-world missed day. Current populated rounds 1–6 are unresolved. A window-end **KO** requires the window to have ended and all records to be classified with no pending results. Winner = greater total confirmed hits, equal totals = final draw. Current data cannot establish a final winner.

## Community health

The separate daily team poll is visitor preference, not the source-data winner. With `totalVotes=dotsVotes+botsVotes`, the exact functions are:

```
tiboHealth = 100 - (100 * botsVotes / max(totalVotes, 1)) * 0.9
potetoHealth = 100 - (100 * dotsVotes / max(totalVotes, 1)) * 0.9
```

Above 50 is green, 25–50 inclusive yellow, below 25 red. The strict below-10 flashing condition is supported but cannot be reached by legitimate votes because these formulas have a 10% minimum. Unconfigured bars are neutral displays marked `HP —`; no shared zero counts are fabricated. White damage trails and shake respond to a new server-confirmed count, not optimistic local increments. Sound starts muted and needs an explicit gesture to enable it. Reduced motion removes shake, decorative movement and flashing.

## Calendar

The existing October 5–November 1, 2026 window is this fan tracker's convention, not a verified official pledge or deadline. Round number and countdown use the data's IANA `America/Los_Angeles` timezone. The countdown searches for the next local date boundary, covering 23-hour and 25-hour DST days. Round 0 is before the window; it caps at 28 after the window. Passing midnight never invents source results.
