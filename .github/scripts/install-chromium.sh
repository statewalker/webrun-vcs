#!/usr/bin/env bash
# Installs Playwright's Chromium for a CI job. Usage, with the command that runs playwright:
#
#   bash .github/scripts/install-chromium.sh pnpm --filter @statewalker/vcs-site exec playwright
#
# `playwright install --with-deps` also installs Chromium's system libraries with apt. When the
# runner cannot reach the Ubuntu mirrors ("Temporary failure resolving 'archive.ubuntu.com'"), that
# step fails after minutes of apt retries and the whole job goes red before any test runs. GitHub's
# Ubuntu images already ship Chrome and the libraries it needs, so then Chromium is installed
# without them, with a warning: the tests show whether anything is missing.
set -uo pipefail
pw=("$@")
[ ${#pw[@]} -gt 0 ] || pw=(pnpm exec playwright)

if getent hosts archive.ubuntu.com >/dev/null 2>&1; then
  if "${pw[@]}" install --with-deps chromium; then exit 0; fi
  echo "::warning::playwright install --with-deps failed; installing Chromium without its system packages"
else
  echo "::warning::archive.ubuntu.com does not resolve; installing Chromium without its system packages (the runner image has them)"
fi
"${pw[@]}" install chromium
