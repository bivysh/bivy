# AUR package

`PKGBUILD` packages the GitHub release archives for Arch Linux (and Omarchy) as
`bivy-bin`. Each archive is prebuilt for its architecture and bundles its own
Node runtime, hence the `-bin` suffix and no Node.js dependency. It installs
under `/usr/lib/bivy` with `/usr/bin/bivy` linking its launcher.

The package writes `.bivy-install.json` into the install, so `bivy update` and
the app's Update button tell you to update through your AUR helper instead of
replacing files pacman owns.

## Publishing a release

```bash
node scripts/aur-bump.mjs 0.22.0      # sets pkgver, pkgrel=1 and each arch's sha256 from the release
cd packaging/aur
makepkg --printsrcinfo > .SRCINFO
makepkg -si                           # optional: build and install locally
```

Then commit `PKGBUILD` and `.SRCINFO` to the AUR repository
(`ssh://aur@aur.archlinux.org/bivy-bin.git`).
