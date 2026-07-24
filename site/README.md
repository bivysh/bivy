# Marketing / install site

The static site served at [bivy.sh](https://bivy.sh). Plain HTML, no build step,
no dependencies.

It lives in this repo, next to the code and docs it describes, so a change to the
installer or a doc link can't leave the site stale.

## Layout

```text
index.html        landing page
contact.html      contact
privacy.html      privacy policy
terms.html        terms
legal.css         shared styling for the legal pages
icon.svg tent.png brand marks
screenshots/      product screenshots used by the landing page
```

`site/install.sh` is **generated** and gitignored. The canonical installer is
`install.sh` at the repo root — that is the file to edit, and the one
`test/installer-migration.sh` tests. Render copies it into this directory at
build time, so `bivy.sh/install.sh` is byte-identical to the tested file by
construction.

## Preview locally

```bash
cp install.sh site/install.sh      # only needed to preview the installer route
python3 -m http.server 8080 --directory site
# open http://localhost:8080
```

## Deploy

Render picks up [`render.yaml`](../render.yaml) at the repo root and publishes
this directory. The only build step is the `install.sh` copy. No environment
variables, no secrets.

Bivy is distributed on [npm](https://www.npmjs.com/package/bivy), so this site
hosts no release tarball or manifest. See [`docs/releasing.md`](../docs/releasing.md).
