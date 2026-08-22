# Frontend layout

This used to be three files: an `index.html` holding every page, one
`styles.css` and one `script.js`. It is now one file per page and per concern.

```
index.html              the shell: <head>, <body>, and the include markers
pages/                  one file per routed page
partials/               chrome shared by every page (topbar, sidebar)
dialogs/                one file per <dialog>
css/                    stylesheets, loaded in numeric order
js/                     scripts, loaded in numeric order
```

## What the browser gets

The browser is still served a single `/styles.css` and a single `/script.js`.
`Backend/frontend_assets.py` stitches the sources together per request and
caches the result until a source file changes, so editing a page during
development does not need a restart.

They are composed rather than linked because this server speaks HTTP/1.0. There
is no keep-alive, so twenty `<link>` tags and twenty `<script>` tags would mean
forty TCP connections on every page load.

## The numeric prefixes are load order

`css/` and `js/` files are concatenated by sorted filename. The number is not
decoration:

- The stylesheets contain same-specificity overrides that only resolve
  correctly in order. `13-theme-dark.css` has to land after every light rule it
  overrides, and `20-build-ramp.css` redefines several of its own selectors
  further down the file.
- `script.js` is one script, not a set of modules, so every function
  declaration hoists across all of `js/`. Top-level statements still run in
  file order — `19-events.js` wires handlers that `20-session.js` then relies
  on.

Renaming a file changes where its rules and statements land. Check what the
moved block overrides before renumbering.

## Adding a page

1. Add `pages/<name>.html` with the page's `<section>`.
2. Add `<!--#include pages/<name>.html -->` to `index.html`.
3. Add the route to the page-route set in `Backend/main.py` `do_GET`, and a
   matching predicate plus visibility branch in `js/03-router.js`.
4. Add the sidebar link in `partials/sidebar.html` and its click handler in
   `js/19-events.js`.

Includes replace the whole marker line, so an included file keeps its own
indentation and the marker's indentation is discarded.
