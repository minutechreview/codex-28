# Deployment notes

Codex 28 is a static project intended for a public `minutechreview/codex-28` repository and GitHub Pages at `https://minutechreview.github.io/codex-28/`. The source branch holds the application, docs, and tests. The root of `gh-pages` holds only the reviewed public site payload.

## Voting release gate

The daily polls are prepared locally. Do not publish a functional-voting announcement or enable the UI until the shared backend is deployed and verified. The default `voting-config.json` contains `apiBaseUrl: null` and no invented results. [backend/README.md](backend/README.md) covers the Worker, D1 migration, persistent local verification, and activation steps.

Inventory on October 8 found no dedicated Codex 28 backend among the connected Supabase, Vercel, Netlify, or Sites projects. The two active Supabase databases belong to unrelated projects. Saved Cloudflare authentication is expired; no token was refreshed. The proposed scoped service is a new `codex-28-voting` Worker and dedicated D1 database on the existing Cloudflare account, using its `workers.dev` address while the website stays on GitHub Pages.

Before provisioning, obtain explicit approval to reconnect Cloudflare and create those resources. Verify the selected account's **Workers Free** plan and available D1 capacity. Stop for any new terms, broader permissions, credentials, payment, paid plan, or DNS changes. D1 Free quotas [return errors when exceeded](https://developers.cloudflare.com/d1/platform/pricing/), which the UI treats as unavailable; a paid plan can incur usage charges and requires separate approval. Check the current [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) as well.

After approval and successful remote smoke checks, set the actual HTTPS Worker URL in `voting-config.json`, run all checks, and publish the source changes and reviewed static build to their separate existing branches with normal commits. Compare remote heads before writing; preserve any intervening owner edits. Publish the latest authoritative `data.json` unchanged to `gh-pages`, and verify the two copies match byte for byte. Backend source, migrations, local databases, QA evidence, and tests never belong in the Pages payload.

Keep votes across releases: apply additive migrations to the same dedicated D1 database. Never recreate the database or reset poll IDs when a new day starts or a summary changes. Resetting a day to pending hides voting until it is republished but does not delete its prior database votes.

## Free GitHub Pages route

Use the existing authenticated GitHub account. First inspect `gh auth status` and the target repository. Create the dedicated public repository only if the name is available; stop if an existing repository is unrelated. Do not overwrite another project. GitHub Pages supports public repositories on GitHub Free, and a project site's default address includes its repository name. See [GitHub's Pages overview](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages). This route needs no new account, paid service, custom DNS, OAuth grant, credential, or live analytics setup.

Run `npm run check` and review the `dist/` payload before publishing. The build script uses an explicit public-file allowlist: HTML, CSS, browser JavaScript, the standalone JSON, `.nojekyll`, and licensed assets. Never publish the entire workspace, screenshots, private notes, credentials, `.env` files, or test tooling. Use a fresh, reviewed build output and verify it contains only intended public files.

For the first deployment, from the project directory:

```sh
npm run check
publish_dir=$(mktemp -d /tmp/codex-28-pages.XXXXXX)
cp -R dist/. "$publish_dir/"
git -C "$publish_dir" init --initial-branch=gh-pages
git -C "$publish_dir" add .
git -C "$publish_dir" commit -m "Publish Codex 28 static site"
git -C "$publish_dir" remote add origin https://github.com/minutechreview/codex-28.git
git -C "$publish_dir" push -u origin gh-pages
```

This initial push must be a normal push. If `gh-pages` already exists, inspect it and use its existing history; do not force-push over it. The build is a file copy, not an application compilation. `.nojekyll` keeps the branch content as the intended static payload.

In the repository's **Settings → Pages**, set **Source** to **Deploy from a branch**, select **gh-pages** and **/ (root)**, and save. GitHub documents this setup in [Configuring a publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site). If Pages is already configured, inspect it and preserve unrelated settings. The dedicated site's publication is authorized, but an unexpected security-sensitive permission or access grant requires a separate approval rather than silent activation.

Commit and push source files to the source branch separately. Keep the source and deployment histories reviewable. No custom domain is required.

## Publish a JSON-only update

The app fetches `data.json` at runtime, so changes to the JSON do not require rebuilding or changing UI files. Static hosting still has to receive the new file through a commit and Pages deployment.

After editing `data.json` in the source checkout, validate it, run checks, and commit/push that source change. Then clone the existing deployment branch into a separate directory:

```sh
publish_dir=$(mktemp -d /tmp/codex-28-data.XXXXXX)
git clone --single-branch --branch gh-pages https://github.com/minutechreview/codex-28.git "$publish_dir"
cp data.json "$publish_dir/data.json"
git -C "$publish_dir" diff -- data.json
git -C "$publish_dir" add -- data.json
git -C "$publish_dir" commit -m "Update Codex 28 reported results"
git -C "$publish_dir" push origin gh-pages
```

Only the deployment branch's JSON changes in this procedure. Wait for the Pages deployment to complete, then compare the live JSON with the source file. If both copies have the same bytes, the source and deployed data are synchronized. The browser's no-store fetch and cache-busting parameter request current data on the next page load or refresh; they do not bypass GitHub's need to deploy the commit first.

For UI or artwork changes, rebuild and update the existing `gh-pages` checkout with the reviewed full payload. Remove obsolete public assets deliberately, preserving license files for assets still included.

## Release checks

- Run syntax checks, the model tests, data validation, and the static build.
- Check desktop and narrow mobile layouts, touch targets, readable text, and absence of horizontal overflow.
- Check keyboard navigation, focus states, day labels and details, copy fallback, and reduced-motion behavior. Dot interaction must remain bounded and must not block normal scrolling or hide the scoreboard.
- Check the Los Angeles midnight boundaries, before-start and after-end behavior, counts for all four statuses, and pending's “awaiting” versus “ahead” distinction.
- Check malformed JSON, failed fetch, retry, never-updated, stale, and future timestamp states without inventing results.
- Test the project subpath `/codex-28/`, including the CSS, JavaScript modules, artwork, favicon, and JSON.
- Inspect the remote source and deployment commits. Confirm the actual live HTML and referenced assets return successfully, the JSON parses and validates, and no private files were published.

## Deployment evidence

Initial release verified live on **2026-10-05 at 13:54 UTC**, before the user-requested date-window correction. The actual remote application source and deployment commit IDs were read back from GitHub. Native GitHub Pages built the deployment commit successfully at `2026-10-05T13:51:58Z`.

| Evidence | Result |
| --- | --- |
| Repository | [minutechreview/codex-28](https://github.com/minutechreview/codex-28), public, default branch `main` |
| Live Pages URL | [https://minutechreview.github.io/codex-28/](https://minutechreview.github.io/codex-28/) |
| Released application source commit | `b271cca7bcb9c85c1ff6d75585402924b41a80fe` |
| Deployment branch commit | `483be9a0f00cfbfe3e3130495b413d352c02595d` |
| Pages configuration | `legacy` branch publication, `gh-pages`, `/`, public, HTTPS enforced, no custom domain |
| Pages build | `built`, exact deployment commit, no build error |
| Live payload | HTML, JSON, CSS, both JS modules, four character PNGs, favicon, and asset license all HTTP 200; all 11 file bytes match the local public build |
| Live data | Initial release schema valid; 0 improvements, 0 resets, 28 pending, 0 missed; never-updated sentinel |
| Local validation | Syntax checks, 41 Node tests, and 12-file allowlisted static build pass |
| Browser verification | Desktop / mobile screenshots; functional status, source, fetch-error, sharing, copy fallback, timezone, keyboard, pointer, touch, reduced-motion, and responsive checks passed |

The root live page also loaded successfully in a real Chromium browser. Responsive checks cover 320, 390, 768, and 1280 pixel widths without horizontal overflow. Mock reported outcomes were used only in browser tests, never in the deployed JSON. The four characters support bounded mouse/touch dragging, keyboard arrows / Home, and tap / Enter / Space cheers; their play area clips the restrained release reaction so it cannot obscure the scoreboard.

The public deployment contains only 12 deliberately selected files. Documentation and tests are public in the source branch but are not in the Pages payload. Screenshots, local QA outputs, and helper files were excluded from both public branches. No new account, paid service, credential, OAuth grant, access grant, custom DNS, or active analytics was introduced.

The final source branch includes a documentation follow-up after the released application commit. Read its current head from GitHub when you need the newest documentation revision.

Date-window correction: the user requested **October 5–November 1, 2026**, inclusive, with Monday, October 5 as Day 1. All 28 date entries and visible window labels were shifted by one calendar day; statuses, summaries, sources, timestamps, artwork, design, and interactions were preserved. Boundary tests cover the 25-hour final day during the November 1 Pacific daylight-saving transition.
