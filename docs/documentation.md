# Build and preview the documentation

This site uses standard [Zensical](https://zensical.org/docs/) **0.0.68** with `zensical.toml`, the bundled modern theme, native search and Markdown. There are no custom templates, JavaScript, analytics or remote fonts. The existing pixel logo is used unchanged.

The header links to the repository beside search. The native version selector switches between **main** and release documentation, starting with **v2026.10.6**. Earlier releases are not archived. Main lives under `main/`; the site's root and existing page URLs redirect to main.

## Reproducible environment

Use **Python 3.13.5** (the CI version) and **uv 0.12.10**. `pyproject.toml` pins Zensical and the [maintained mike fork](https://zensical.org/docs/compatibility/mkdocs/mike/) at an immutable Git revision; `uv.lock` locks the environment. From the repository root:

```bash
python3 -m pip install uv==0.12.10
uv sync --locked --python 3.13.5
git fetch origin main --tags
uv run --locked python scripts/build-docs.py
uv run --locked python scripts/test-build-docs.py
uv run --locked python -m http.server 8000 --bind localhost --directory site
```

Preview at **<http://127.0.0.1:8000/>**. The configured address is loopback-only. Stop the foreground preview with Ctrl-C. `site/` is generated output; `.venv/` and `.cache/` are local build state. None belongs in a commit.

Edit pages under `docs/`, then update `nav` in `zensical.toml` when adding a page. Links to site pages should be relative Markdown links; links to source files outside `docs/` should point to the repository on GitHub.

Before committing, run the strict clean build and the repository's formatter check. Review navigation, search results, light/dark appearance and mobile layout. Keep screenshots and validation logs outside `docs/` and `site/`. Review both source and generated output for private content before publication.

To upgrade dependencies deliberately, change the pin, regenerate with `uv lock`, review the lock diff and validate the site. Normal builds use `--locked` so they do not silently resolve a new environment.

## CI and publishing

`scripts/build-docs.py` strictly builds the working checkout as main and every known release tag from v2026.10.6 onward. Each release uses its own tagged `docs/` and `zensical.toml`, with only the canonical base URL, output location, repository header and native mike selector overlaid. The locked build environment is shared. The artifact contains version directories, mike's `versions.json` with source commit IDs, and static redirects for current pages. No publishing branch is needed.

`docs-check.yml` validates that same artifact on pull requests with read-only repository permissions. It does not deploy or publish previews.

`docs-pages.yml` runs on pushes to **main** and after a successful Release workflow. Every run checks out latest main with all tags, builds the complete artifact and uploads it to Pages. Its build job has only repository read permission; a separate `github-pages` deployment job has `pages: write` and `id-token: write`. This docs workflow does not release or deploy the plugin. Zensical build caching is not used in CI.

The configured canonical URL is **`https://ageorgiou.com/openclaw-jarvis-gilfoyle/`**. Pages publishes from GitHub Actions. A successful local or PR build does not establish that hosting is configured or live.

## Official guidance

- [Get started](https://zensical.org/docs/get-started/): Python virtual environments and uv installation.
- [Configuration basics](https://zensical.org/docs/setup/basics/): standard TOML project settings.
- [Colors](https://zensical.org/docs/setup/colors/) and [fonts](https://zensical.org/docs/setup/fonts/): palette toggle and system fonts.
- [Validation](https://zensical.org/docs/setup/validation/): internal links, anchors and strict builds.
- [Publishing](https://zensical.org/docs/publish-your-site/): GitHub Pages actions and publishing prerequisites.
