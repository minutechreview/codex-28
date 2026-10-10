# Repository audit — VERSUS draft

Baseline: `main` 6096c53; `gh-pages` 73b6bcb. Fresh clone was clean, with no local edits. The root read UI, all documentation/config/data/license files and asset inventory; parallel audits read the full model/build/tests and full Worker/poll/local QA sources before implementation. Every tracked authored text/source file was read. No vendor bundles or dependencies are tracked. Six binary artwork/portrait files were inventoried, retained unchanged, and are described by `assets/LICENSE.txt` (dot artwork) plus their filenames/dimensions. Four generated fan dots are PNGs; two supplied portraits are 400×400 JPEGs. The original authored SVG/favicon is retained. No existing generated/vendor assets were edited. New typography is an unchanged bundled Google Fonts Press Start 2P TTF with its upstream OFL notice; the new favicon and share layout are original authored artifacts.

`data.json` SHA-256 (source and deployment):

```
d3afceec07918f307e4e391afa8e5b2d1c7f862ba50c3221e14ac6702578a926
```

`git diff origin/main origin/gh-pages -- data.json` is empty. The complete branch diff removes 18 source-only files (documentation, backend, package/build scripts and tests) from the deployment branch; all shared static payload files match. Both data files and both existing avatars are unchanged. Neither branch is synchronized or written by this task.

The actual schema mismatch, classification uncertainty and name spelling are recorded in [versus-rules.md](versus-rules.md). The two preserved sources supply all runtime content; missing classification is surfaced visibly. Static metadata/share image are regenerated from them for the draft.

The earlier approval poll is independent. Its `app.js`, `styles.css`, `polls.js`, `voting-config.json`, backend and tests remain intact. The former entry page is preserved at `legacy/index.html`, with relative asset paths adjusted for that directory. It is a local compatibility preview and is excluded from the new public build. Opening it locally can contact the old configured Worker; the redesign never imports it or reads the old configuration.

No cloud resources, credentials, accounts, billing, security rules, main/gh-pages branches, production votes or live backend were changed. This branch and draft PR are review artifacts only.
