# Bivy on Omarchy

[Omarchy](https://omarchy.org) is an Arch Linux + Hyprland setup. Bivy runs on
it like any Linux machine, and follows it where that helps.

## The app matches your theme

When a node runs on Omarchy, the app takes on the machine's theme: its
background, text, accent and status colors, in light or dark to match. Switch
themes with `omarchy-theme-set` (or the theme menu) and every open app follows
within a couple of seconds, including your phone.

The node reads the active theme's `colors.toml` from
`~/.local/state/omarchy/current/theme/` (or `~/.config/omarchy/current/theme/`
on older installs). It resolves it the way Omarchy does, including themes that
only define ANSI `color0`–`color15`, and sends it to connected apps. The palette
travels over the same connection as everything else, so over a relay it is
end-to-end encrypted too.

**Machine** is the default in **Settings → Appearance** whenever the machine has
a theme. Choose **System**, **Light** or **Dark** to stop following it. On a
machine without Omarchy the option doesn't appear and nothing changes.

How the colors map onto Bivy's design tokens lives in
`packages/ui/tokens.css` (`:root[data-machine-theme]`): the app sets only the
raw `--machine-*` inputs and derives surfaces, lines and soft tints from them.
