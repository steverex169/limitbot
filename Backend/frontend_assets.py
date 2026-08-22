"""Builds the three responses a browser asks for out of the split Frontend sources.

The dashboard used to be one index.html holding every page, one styles.css and
one script.js. Those are now a file per concern under pages/, partials/,
dialogs/, css/ and js/, so a page can be opened and edited on its own.

The browser is still served a single /styles.css and a single /script.js. That
is deliberate:

  * This server speaks HTTP/1.0, so there is no keep-alive. Twenty stylesheets
    and twenty scripts would mean forty TCP connections per load.
  * Concatenating in a fixed order is what keeps the CSS cascade and the
    script's top-level execution order exactly as authored. The stylesheets
    carry same-specificity overrides that only resolve correctly in order, and
    the script relies on function declarations hoisting across the whole file.

The numeric filename prefixes ARE the order. Files are concatenated by sorted
name, so renaming one renumbers where its rules and statements land. Do not
renumber without checking what the moved block overrides.

Sources are re-read when any of them changes on disk, so editing a page during
development does not need a restart.
"""

import hashlib
import re
import threading

# An include is the whole line, so the marker's own indentation is discarded and
# the included file keeps the indentation it was written with.
INCLUDE_MARKER = re.compile(r"^[ \t]*<!--#include\s+(?P<path>[^\s>]+)\s+-->[ \t]*$")

# An include may itself include; the limit only stops a cycle from hanging a
# request.
MAX_INCLUDE_DEPTH = 8


class ComposedAsset:
    """One response assembled from several files, rebuilt when any of them change.

    Holds the built body and its ETag so repeat loads answer 304 instead of
    resending the whole bundle. Responses carry Cache-Control: no-cache, which
    means revalidate, not "do not cache".
    """

    def __init__(self, root, content_type, sources, render):
        self.root = root
        self.content_type = content_type
        self._sources = sources
        self._render = render
        self._lock = threading.Lock()
        self._stamp = None
        self._body = b""
        self._etag = ""

    def _fingerprint(self, paths):
        stamp = []
        for path in paths:
            try:
                info = path.stat()
            except OSError:
                stamp.append((str(path), None, None))
            else:
                stamp.append((str(path), info.st_mtime_ns, info.st_size))
        return tuple(stamp)

    def current(self):
        """Return (body, etag), rebuilding first if any source file changed."""
        with self._lock:
            paths = self._sources()
            stamp = self._fingerprint(paths)
            if stamp != self._stamp:
                body = self._render(paths).encode("utf-8")
                self._body = body
                self._etag = '"{}"'.format(hashlib.sha256(body).hexdigest()[:32])
                self._stamp = stamp
            return self._body, self._etag


def _ordered(directory, suffix):
    """Source files in load order. The numeric prefix is the order."""
    if not directory.is_dir():
        return []
    return sorted(p for p in directory.iterdir() if p.suffix == suffix and p.is_file())


def _read_within(root, relative):
    """Read a source file, refusing anything that escapes the Frontend directory."""
    target = (root / relative).resolve()
    if not target.is_relative_to(root.resolve()):
        raise ValueError(f"Include escapes the frontend directory: {relative}")
    return target.read_text(encoding="utf-8")


def _expand_includes(root, text, depth=0):
    if depth >= MAX_INCLUDE_DEPTH:
        raise ValueError("Include nesting is too deep; check for a cycle")

    out = []
    for line in text.splitlines(keepends=True):
        match = INCLUDE_MARKER.match(line.rstrip("\r\n"))
        if match is None:
            out.append(line)
            continue
        included = _read_within(root, match.group("path"))
        out.append(_expand_includes(root, included, depth + 1))
    return "".join(out)


def build(app_directory):
    """Return the composed html/css/js assets for a Frontend directory."""
    root = app_directory

    def html_sources():
        pages = []
        for name in ("pages", "partials", "dialogs"):
            pages.extend(_ordered(root / name, ".html"))
        return [root / "index.html"] + pages

    def render_html(_paths):
        return _expand_includes(root, (root / "index.html").read_text(encoding="utf-8"))

    def concatenate(paths):
        return "".join(path.read_text(encoding="utf-8") for path in paths)

    return {
        "html": ComposedAsset(
            root, "text/html; charset=utf-8", html_sources, render_html
        ),
        "css": ComposedAsset(
            root,
            "text/css; charset=utf-8",
            lambda: _ordered(root / "css", ".css"),
            concatenate,
        ),
        "js": ComposedAsset(
            root,
            "text/javascript; charset=utf-8",
            lambda: _ordered(root / "js", ".js"),
            concatenate,
        ),
    }


def serve(handler, asset):
    """Write an assembled bundle to a BaseHTTPRequestHandler.

    These are built in memory rather than read off disk, so the 304 that
    SimpleHTTPRequestHandler would have produced from Last-Modified has to be
    produced here instead. Without it every load would re-send the whole
    bundle, because static responses are marked no-cache (revalidate) rather
    than given a lifetime.

    Raises OSError or ValueError if the sources cannot be assembled; nothing
    has been written to the socket when it does, so the caller is free to send
    an error response instead.
    """
    body, etag = asset.current()

    known = [
        tag.strip()
        for tag in handler.headers.get("If-None-Match", "").split(",")
        if tag.strip()
    ]
    if etag in known:
        handler.send_response(304)
        handler.send_header("ETag", etag)
        handler.end_headers()
        return

    handler.send_response(200)
    handler.send_header("Content-Type", asset.content_type)
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("ETag", etag)
    handler.end_headers()
    if handler.command != "HEAD":
        handler.wfile.write(body)
