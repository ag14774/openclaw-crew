"""Focused checks for the version-history boundary and static redirects."""

import importlib.util
import json
import sys
import tomllib
import unittest


sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("build_docs", "scripts/build-docs.py")
docs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(docs)


class BuildDocsTest(unittest.TestCase):
    def test_history_starts_at_baseline_and_keeps_future_releases(self):
        self.assertEqual(
            docs.release_tags(
                [
                    "v2026.10.0",
                    "v2026.10.12",
                    "v2026.10.13",
                    "v2026.10.14",
                    "v2026.11.0",
                    "v2027.1.0",
                    "v2026.10.14-rc1",
                    "other",
                ]
            ),
            ["v2026.10.13", "v2026.10.14", "v2026.11.0", "v2027.1.0"],
        )

    def test_redirect_leaves_fragment_handling_to_browser(self):
        page = docs.redirect(
            "../main/operations/", "https://example.org/main/operations/"
        )
        self.assertIn('content="0; url=../main/operations/"', page)
        self.assertNotIn("#", page)
        self.assertNotIn("<script", page)

    def test_artifact_has_versioned_urls_and_genuine_tag_provenance(self):
        root = docs.ROOT
        versions = json.loads((root / "site/versions.json").read_text())
        tags = docs.release_tags(docs.git("tag", "--list").splitlines())
        self.assertEqual({item["version"] for item in versions}, {"main", *tags})
        base = tomllib.loads((root / "zensical.toml").read_text())["project"][
            "site_url"
        ]
        for item in versions:
            version = item["version"]
            ref = "HEAD" if version == "main" else f"refs/tags/{version}"
            self.assertEqual(
                item["properties"],
                {
                    "ref": ref,
                    "commit": docs.git("rev-parse", f"{ref}^{{commit}}"),
                },
            )
            for page in (root / "site" / version).rglob("*.html"):
                if page.name == "404.html":
                    continue
                relative = page.relative_to(root / "site" / version)
                url = (
                    base
                    + version
                    + "/"
                    + relative.as_posix().removesuffix("index.html")
                )
                html = page.read_text()
                self.assertIn(f'<link rel="canonical" href="{url}">', html)
                self.assertIn('"version":{"provider":"mike"}', html)
                if version == "main":
                    redirect = root / "site" / relative
                    self.assertIn(f'href="{url}"', redirect.read_text())


if __name__ == "__main__":
    unittest.main()
