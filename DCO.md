# Developer Certificate of Origin

Bivy takes contributions under the [Developer Certificate of
Origin](https://developercertificate.org/) 1.1. There is no copyright
assignment and nothing to sign up for: you keep the copyright in your work, and
it is licensed to everyone under the project's [MIT license](LICENSE), like the
rest of the code.

## How to sign off

Add a `Signed-off-by` line to each commit, with the name and email you commit
under. Git writes it for you with `-s`:

```sh
git commit -s -m "Fix the thing"
```

```text
Signed-off-by: Jane Developer <jane@example.com>
```

To add it to commits you already made:

```sh
git rebase --signoff main   # or: git commit --amend -s --no-edit
git push --force-with-lease
```

The DCO check on your pull request confirms every commit has one.

## What you are certifying

The text below is the Developer Certificate of Origin, version 1.1, verbatim.

```text
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```
