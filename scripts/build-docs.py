"""Assemble the Pages artifact from the checkout and genuine release tags."""

import io
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import tomllib
from html import escape

from mike.versions import Versions
import tomli_w


ROOT = Path(__file__).resolve().parents[1]
BASELINE = (2026, 10, 13)


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def release_tags(tags):
    return [
        tag
        for tag in tags
        if (match := re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", tag))
        and tuple(map(int, match.groups())) >= BASELINE
    ]


def redirect(target, canonical):
    target, canonical = escape(target, quote=True), escape(canonical, quote=True)
    return (
        '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">\n'
        "<title>Documentation moved</title>\n"
        f'<link rel="canonical" href="{canonical}">\n'
        f'<meta http-equiv="refresh" content="0; url={target}">\n'
        f'</head><body><a href="{target}">Continue to documentation</a></body></html>\n'
    )


def build():
    output = ROOT / "site"
    if output.exists():
        shutil.rmtree(output)
    output.mkdir()
    presentation = tomllib.loads((ROOT / "zensical.toml").read_text())["project"]
    base_url = presentation["site_url"].rstrip("/") + "/"
    versions = Versions()
    tags = release_tags(git("tag", "--list").splitlines())

    with tempfile.TemporaryDirectory(prefix="crew-docs-") as temporary:
        for version in ["main", *tags]:
            source = Path(temporary) / version
            source.mkdir()
            ref = "HEAD" if version == "main" else f"refs/tags/{version}"
            if version == "main":
                shutil.copytree(ROOT / "docs", source / "docs")
                shutil.copy2(ROOT / "zensical.toml", source / "zensical.toml")
            else:
                archive = subprocess.check_output(
                    ["git", "archive", ref, "docs", "zensical.toml"], cwd=ROOT
                )
                with tarfile.open(fileobj=io.BytesIO(archive)) as files:
                    files.extractall(source, filter="data")

            config_path = source / "zensical.toml"
            config = tomllib.loads(config_path.read_text())
            project = config["project"]
            project["site_url"] = base_url
            project["site_dir"] = "site"
            for key in ("repo_url", "repo_name"):
                project[key] = presentation[key]
            project.setdefault("extra", {})["version"] = {"provider": "mike"}
            config_path.write_text(tomli_w.dumps(config))
            subprocess.run(
                [
                    "zensical",
                    "build",
                    "--clean",
                    "--strict",
                    "--config-file",
                    str(config_path),
                ],
                cwd=source,
                env={**os.environ, "MIKE_DOCS_VERSION": version},
                check=True,
            )
            shutil.move(source / "site", output / version)
            info = versions.add(version)
            info.properties = {
                "ref": ref,
                "commit": git("rev-parse", f"{ref}^{{commit}}"),
            }

    (output / "versions.json").write_text(versions.dumps() + "\n")
    for page in (output / "main").rglob("*.html"):
        if page.name == "404.html":
            continue
        relative = page.relative_to(output / "main")
        destination = output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        target = os.path.relpath(page, destination.parent)
        canonical = base_url + "main/" + relative.as_posix()
        if page.name == "index.html":
            target = target.removesuffix("index.html")
            canonical = canonical.removesuffix("index.html")
        destination.write_text(redirect(target, canonical))


if __name__ == "__main__":
    build()
