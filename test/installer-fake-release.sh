# Sourced by the installer suites: a stand-in for github.com/bivysh/bivy/releases
# that install.sh reads through curl's file transport (BIVY_RELEASES_URL=file://…).

# This machine's archive target, as install.sh computes it.
fake_target() {
  local os arch
  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; esac
  case "$(uname -m)" in x86_64 | amd64) arch=x64 ;; aarch64 | arm64) arch=arm64 ;; esac
  printf '%s-%s' "$os" "$arch"
}

# make_release <releases-dir> <tag-dir> <version>: an archive whose bin/bivy
# prints its version and appends every other invocation to $FAKE_BIVY_LOG.
make_release() {
  local releases="$1" tag="$2" version="$3" target name dir
  target="$(fake_target)"
  name="bivy-$version-$target"
  dir="$(mktemp -d)"
  mkdir -p "$dir/$name/bin" "$dir/$name/runtime/bin" "$releases/download/$tag"
  printf '{"version":"%s","target":"%s"}\n' "$version" "$target" > "$dir/$name/bivy-archive.json"
  cat > "$dir/$name/bin/bivy" <<STUB
#!/bin/sh
[ "\$1" = --version ] && { echo $version; exit 0; }
echo "$version \$*" >> "\${FAKE_BIVY_LOG:-/dev/null}"
STUB
  printf '#!/bin/sh\nprintf claude\n' > "$dir/$name/runtime/bin/node"
  chmod +x "$dir/$name/bin/bivy" "$dir/$name/runtime/bin/node"
  tar -czf "$releases/download/$tag/$name.tar.gz" -C "$dir" "$name"
  rm -rf "$dir"
  (cd "$releases/download/$tag" && sha256sum "$name.tar.gz" > SHA256SUMS)
}
