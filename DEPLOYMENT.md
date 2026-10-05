# Deployment notes

Codex 28 is a static project intended for a public `minutechreview/codex-28` repository and GitHub Pages at `https://minutechreview.github.io/codex-28/`. The source branch holds the application, docs, and tests. The root of `gh-pages` holds only the reviewed public site payload.

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

At documentation creation, the URLs below are intended targets, not a verified live claim. The release owner should replace this pending record only after inspecting the actual remote commits and live responses.

| Evidence | Status |
| --- | --- |
| Repository | Target: `https://github.com/minutechreview/codex-28` |
| Live Pages URL | Target: `https://minutechreview.github.io/codex-28/` |
| Source commit | Pending verification |
| Deployment branch commit | Pending verification |
| Pages configuration / deployment result | Pending verification |
| Live HTML, JSON, and referenced assets | Pending verification |
| Responsive screenshots / preview | Pending final visual check |

Record a timestamp and observed commit IDs alongside the final evidence. A successful local build or a successful push alone does not establish that Pages is live.
