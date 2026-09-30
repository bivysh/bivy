# AUR package

`PKGBUILD` packages the npm release of `@bivy/bivy` for Arch Linux (and
Omarchy) as `bivy`. It is a Node.js package, not a prebuilt binary, so it follows
the [Node.js package guidelines](https://wiki.archlinux.org/title/Node.js_package_guidelines)
and has no `-bin` suffix.

The package writes `.bivy-install.json` into the install, so `bivy update` and
the app's Update button tell you to update through your AUR helper instead of
replacing files pacman owns.

## Publishing a release

```bash
node scripts/aur-bump.mjs 0.21.0      # sets pkgver, pkgrel=1 and the sha256 from npm
cd packaging/aur
makepkg --printsrcinfo > .SRCINFO
makepkg -si                           # optional: build and install locally
```

Then commit `PKGBUILD` and `.SRCINFO` to the AUR repository
(`ssh://aur@aur.archlinux.org/bivy.git`).
