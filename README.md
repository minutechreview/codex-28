# Codex 28

A small, unofficial fan scoreboard for a 28-day watch of broadly useful Codex / ChatGPT Work improvements or full usage resets. A cream scoreboard, a colorful dot cheering section, and a public JSON file keep the project simple to use and update.

The October 5–November 1, 2026 window is **this tracker's counting convention**, supplied for this project. It is not presented as a verified official schedule. The source is [Tibo's @thsottiaux profile](https://x.com/thsottiaux); the project does not claim a verified pledge permalink. All 28 outcomes initially remain pending, with “Never updated · results unverified” displayed. No improvement, reset, or missed day has been inferred.

This project is unaffiliated with OpenAI or Tibo and makes no promises on their behalf.

## Run locally

Use Node.js 20 or later, npm, and Python 3. There are no application dependencies to install.

```sh
npm start
```

Open [http://127.0.0.1:4173/](http://127.0.0.1:4173/). Use an HTTP server, because the browser fetches `data.json`; opening `index.html` as a local file is not a supported preview.

```sh
npm run check
```

This checks JavaScript syntax, runs the Node test suite, validates the public data, and copies the intended static payload to `dist/`. `npm run lint`, `npm test`, and `npm run build` are also available separately. The source is plain HTML, CSS, and browser ES modules; there is no UI bundler.

## Public data

`data.json` is fetched as a separate public file at runtime. It is neither imported into JavaScript nor compiled into the UI. Each load and refresh uses `cache: 'no-store'` and a cache-busting query parameter. Relative asset URLs and the module-relative JSON URL support a GitHub Pages project subpath such as `/codex-28/`.

Every object must have exactly the documented keys. Missing or extra keys are rejected.

| Root key | Rule |
| --- | --- |
| `startDate` | A real calendar date in exact `YYYY-MM-DD` format. Initially `2026-10-05`. |
| `endDate` | A real `YYYY-MM-DD` date exactly 27 calendar days after `startDate`, making 28 inclusive days. Initially `2026-11-01`. |
| `timezone` | A named IANA timezone supported by `Intl.DateTimeFormat`, with no surrounding whitespace or numeric offset. Initially `America/Los_Angeles`. |
| `source` | A plain HTTPS X profile or post URL, at most 250 characters. Initially `https://x.com/thsottiaux`. |
| `days` | Exactly 28 objects, in ascending consecutive day order. |
| `updatedAt` | A valid ISO timestamp with seconds and an explicit `Z` or `±HH:MM` offset. Optional fractional seconds have one to three digits. |

Each object in `days` has these five keys:

| Day key | Rule |
| --- | --- |
| `day` | An integer from 1 through 28, matching its array position. |
| `date` | The exact consecutive `YYYY-MM-DD` date for that day. |
| `status` | Exactly `improvement`, `reset`, `pending`, or `missed`. |
| `summary` | Plain text of at most 500 characters. A non-pending result requires a nonblank explanation. Empty text is allowed for pending days. |
| `tweetUrl` | `null`, or a plain HTTPS X post URL. |

A pending entry looks like this:

```json
{
  "day": 1,
  "date": "2026-10-05",
  "status": "pending",
  "summary": "",
  "tweetUrl": null
}
```

X URLs may use only `x.com` or `www.x.com`, followed by a 1–15 character username of letters, digits, or underscores. A post path adds `/status/` and a numeric ID. A trailing slash is allowed. Queries, fragments, whitespace, credentials, explicit ports, other hosts, and non-HTTPS schemes are rejected. `tweetUrl` requires the post form; `source` also permits a profile. Add actual source URLs, never placeholder or invented post links.

`1970-01-01T00:00:00.000Z` is the explicit **never updated** sentinel. It is not a claimed reporting date, and it is valid only while every day is pending. When entering real results, set `updatedAt` to the actual manual update time. Data at least 24 hours old is labeled potentially stale. A timestamp more than five minutes ahead of the current clock receives a warning rather than being silently treated as fresh.

The schema is enforced in `model.js`; public text is inserted with `textContent`, and source links are validated before rendering. Invalid JSON, invalid schema, HTTP errors, and a 10-second fetch timeout show an unavailable state and a refresh button. A failed refresh keeps the last successfully loaded data visible with a clear warning. There is no fabricated fallback result.

## Counting and editing outcomes

The day counter uses the calendar date in `America/Los_Angeles`, independently of browser locale or timezone. Before the window it shows day 0; during the window it shows days 1–28; afterward it stays at 28. It updates while a tab remains open across midnight.

Pending days on or before the local current date are “awaiting a source report”; later pending days are “future day · check-in ahead.” The pending counter includes both and displays the breakdown. Time passing never changes a pending result to `missed`. Record `missed` only as an explicit, sourced manual decision, with an explanation. Reports can be added after the counting window closes.

To update:

1. Read the relevant source post and edit only the appropriate day entry in `data.json`.
2. Set the status, a concise factual summary, and the real post URL when available. Leave unknown outcomes pending.
3. Replace the sentinel with the actual update timestamp. Retain the date range and timezone unless deliberately changing the tracker's convention.
4. Validate the file and review the preview:

   ```sh
   node --input-type=module -e 'import { readFile } from "node:fs/promises"; import { validateData } from "./model.js"; validateData(JSON.parse(await readFile("data.json", "utf8"))); console.log("data.json is valid");'
   npm run check
   ```

5. Commit the source JSON and publish that same file to the root of the `gh-pages` branch. See [DEPLOYMENT.md](DEPLOYMENT.md) for the JSON-only update procedure.

No UI rebuild is needed to change the data's meaning: the browser reads the standalone JSON. **GitHub Pages still needs a commit and a deployment of the changed JSON.** Editing a local file does not update the live site. Keep the source branch's `data.json` and the deployed branch's copy identical.

## Interaction and accessibility

Day buttons reveal their result and source without changing data. Tab reaches the selected day; arrow keys move among days, and Home / End select the first / last day. Buttons announce their date, status, and whether they are awaiting a report or still ahead. Statuses have text labels in addition to color, and day details use a polite live region.

The four matching Dot Launcher characters can be dragged within their own play area. Tap or press Enter / Space for a small cheer; arrow keys move a focused dot, and Home returns it to its starting position. Release gives a restrained bounce. Scrolling works outside the dot buttons. These reactions never change scoreboard data. Reduced-motion preferences disable decorative animation. Share opens an X compose intent for the current page; it does not post automatically. Copy link uses the clipboard API and reveals a selected manual-copy field if clipboard access fails. No JavaScript is required to reach the source profile or raw public data.

## Hosting and project scope

The repository is [minutechreview/codex-28](https://github.com/minutechreview/codex-28), with the live GitHub Pages URL [minutechreview.github.io/codex-28/](https://minutechreview.github.io/codex-28/). The actual remote commits, successful Pages build, and live file checks are recorded in [deployment evidence](DEPLOYMENT.md#deployment-evidence).

The project uses static hosting only: no paid API, login, backend, X scraper, or daily watcher. Analytics is an inactive placeholder comment; there is no active tracking script or analytics account. The deployment uses an existing authenticated GitHub account and free Pages hosting, with no custom domain, DNS change, new credentials, or access grants.

## License

Code and documentation are [MIT licensed](LICENSE). Original artwork has its own terms in [assets/LICENSE.txt](assets/LICENSE.txt), which lists the included assets and provenance. The dot artwork is fan-project illustration, not official OpenAI, Codex, ChatGPT, or X artwork. Keep the asset license file with redistributed artwork.
