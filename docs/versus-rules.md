# VERSUS counting rules

This draft reads the existing sources without rewriting either. Tibo's 28 day/status/summary/source records are in `data.json`. Team metadata and the parallel `days[].grokbot` arrays are in `versus.json`. The adapter loads both and checks the two calendars agree. Both source schemas remain strict: unknown fields are rejected. Labels, portraits, summaries and links come from those files, including **Lauren Tan (@poteto, she/her)** on the right using `assets/poteto.jpg`, and Tibo on the left using `assets/tibo.jpg`.

## One hit per shipped update, both sides

Rayan's rule: count every shipped update/improvement on both sides, shown per day from Day 1, and count both sides the same way.

- **Tibo / Team Dots.** `data.json` stays unchanged (the live Worker rejects unknown fields). Its summaries already number Tibo's updates (1.1 is the Day 1 speed-up; 2.1–2.4; 3.1–3.2; 4.1–4.2; 5.1–5.2). Those items are listed in `versus.json` `days[].tibo`, each `{number, summary, tweetUrl, status}` with `status` `improvement` or `reset`, and the day's `data.json` source URL. Nothing beyond what `data.json` already states is added. Prose is not parsed at runtime.
- **Grok Bot / Team Bots.** `days[].grokbot` entries carry `status: "improvement"` or `"reset"`. An entry without `status` is unclassified.
- **Hits.** Each `improvement` item is one hit.
- **Resets.** A `data.json` day with status `reset` shows a USAGE RESET card (with that day's summary and source) and adds one to the reset counter. It never counts as a hit and never removes that day's listed launches. Day 2 therefore scores 4 hits + 1 reset.
- **Consistency checks.** A `pending` or `missed` day must have an empty `tibo` list. An `improvement` day may not contain reset items. An `improvement` day with no `tibo` list is shown as unclassified (round UNRESOLVED) rather than guessed; a `reset` day with no list is a pure reset with 0 hits. Unknown fields, bad numbers, duplicate numbers and unsafe links are rejected.

## Rounds and final result

Each round goes to the side with **more improvements that day**. Equal counts are a **DRAW** (including two empty lanes on a reported day). If either side's day is still **pending** in `data.json`, or any entry is unclassified, the round is **UNRESOLVED**. Empty lanes show **NO MOVE**.

Current rounds: 1 draw (1–1), 2 Team Dots (4–1), 3 Team Bots (3–2), 4 Team Dots (2–1), 5 Team Bots (3–2), 6 unresolved (Tibo pending; Grok Bot 2). Totals: Tibo 11 hits / 2 resets, Grok Bot 11 hits / 0 resets.

A window-end **KO** requires the window to have ended and all records to be classified with no pending days. Winner = greater total hits; equal totals = final draw.

**Upkeep:** whenever Tibo's day is added to `data.json`, add its numbered items to `versus.json` `days[].tibo` too (same day source URL), then run `npm run share:generate`. Otherwise an improvement day shows as unclassified.

## Community health

The separate daily team poll is visitor preference, not the source-data winner. With `totalVotes=dotsVotes+botsVotes`, the exact functions are:

```
tiboHealth = 100 - (100 * botsVotes / max(totalVotes, 1)) * 0.9
potetoHealth = 100 - (100 * dotsVotes / max(totalVotes, 1)) * 0.9
```

Above 50 is green, 25–50 inclusive yellow, below 25 red. The strict below-10 flashing condition is supported but cannot be reached by legitimate votes because these formulas have a 10% minimum. Unconfigured bars are neutral displays marked `HP —`; no shared zero counts are fabricated. White damage trails and shake respond to a new server-confirmed count, not optimistic local increments. Sound starts muted and needs an explicit gesture to enable it. Reduced motion removes shake, decorative movement and flashing.

## Calendar

The existing October 5–November 1, 2026 window is this fan tracker's convention, not a verified official pledge or deadline. Round number and countdown use the data's IANA `America/Los_Angeles` timezone. The countdown searches for the next local date boundary, covering 23-hour and 25-hour DST days. Round 0 is before the window; it caps at 28 after the window. Passing midnight never invents source results.
