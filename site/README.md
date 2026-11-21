# Dragonvale website

Builds the GitHub Pages site from the Markdown in this repository. `.github/workflows/pages.yml` runs it on every push to `main`.

```sh
cd site
pnpm install
pnpm build   # writes ../_site
pnpm serve   # builds, then serves ../_site at http://localhost:8080
```

## Navigation

Wide screens show three columns: the page list on the left, the page, and an **On this page** outline of its headings (levels 2–4) on the right. The outline highlights the section you are reading. Each side column folds into a slim rail with its `«`/`»` button. The browser remembers the choice. Between 821 and 1199 pixels wide, the outline starts folded.

On phones, ☰ opens a drawer with **Pages** and **On this page** tabs. Choosing a heading jumps to it and closes the drawer. Pages with fewer than two headings get no outline.

## Catching up on changes

Every page has a **Show changes since** control. Pick an earlier version, or a date, and the current page is shown with new words highlighted in gold and changed passages marked in the margin. Use **Prev/Next** (or the `n`/`p` keys) to step through the changes. **Show removed text** brings back deleted passages, struck through.

- Each reader's browser remembers which version of each page it last showed them. When a page has changed since then, a ✦ appears next to it in the sidebar, and the page offers to show what changed.
- Links can carry the comparison:
  - `page.html?since=2026-10-27` compares against the page as it stood at the end of that day. While reading that way, links to other pages keep the same date, so a player can catch up on the whole site since their last session.
  - `page.html?since=<commit>` compares against one specific earlier version.
- **Recent Changes** lists every commit and the pages it touched. It also has a date picker that lists every page changed after a given date.

The build renders each earlier version of each page into `_site/versions/`, so it needs the full git history (`fetch-depth: 0` in CI).

## Configuration

`config.json`:

- `title`: the site name.
- `repoUrl`: the repository, used for the "source" and "full history" links.
- `directoryTitles`: display names for folders, keyed by folder name.
- `exclude`: paths (files or folders) left out of the site entirely.
