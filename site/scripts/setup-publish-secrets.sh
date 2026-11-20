#!/usr/bin/env bash
# Gives .github/workflows/site.yml what it needs to publish, once (as statewalker/cellb.dev's
# site/scripts/setup-publish-secrets.sh does for that site):
#
#   1. reads RustFS's own key pair from /opt/httpeers/.env on the httpeers server (over ssh; it is
#      kept nowhere else and this script writes it nowhere);
#   2. with it, using RustFS's own client `rc` (rustfs/cli), creates (or re-keys) a RustFS user whose policy reaches only the site's prefixes
#      of the `sites` bucket — the root pair could rewrite or delete every site;
#   3. checks the new pair can write and delete under sites/<domain>/.site/ (never served);
#   4. stores the new pair as the repository's HTTPEERS_S3_* secrets and sets SITE_DOMAIN.
#
# Secrets go through stdin and environment variables, never argv or the terminal. Re-running it
# rotates the user's secret key and the GitHub secrets together.
#
# Needs: ssh access to the server, docker (runs rustfs/rc), openssl, gh logged in with admin on
# the repository.
#
# Usage: site/scripts/setup-publish-secrets.sh
#   HTTPEERS_SSH   default kotelnikov@163.172.46.87
#   REPO           default statewalker/webrun-vcs
#   SITE_DOMAIN    default vcs.statewalker.com  (where the workflow publishes)
#   SITE_DOMAINS   default: vcs.statewalker.com (prefixes the user may write; vcs.statewalker.org
#                  only redirects to it, in Caddy, and needs no prefix)
#   SITE_USER      default vcs-site              (the RustFS user's access key)
set -euo pipefail

HTTPEERS_SSH=${HTTPEERS_SSH:-kotelnikov@163.172.46.87}
REPO=${REPO:-statewalker/webrun-vcs}
SITE_DOMAIN=${SITE_DOMAIN:-vcs.statewalker.com}
SITE_DOMAINS=${SITE_DOMAINS:-vcs.statewalker.com}
SITE_USER=${SITE_USER:-vcs-site}
ENDPOINT=https://s3.httpeers.net
RC_IMAGE=rustfs/rc:v0.1.37  # RustFS's own client; MinIO no longer publishes mc images

case " $SITE_DOMAINS " in *" $SITE_DOMAIN "*) ;; *)
  echo "SITE_DOMAIN '$SITE_DOMAIN' is not among SITE_DOMAINS '$SITE_DOMAINS'." >&2; exit 1 ;;
esac

echo "Reading the root pair from $HTTPEERS_SSH:/opt/httpeers/.env"
root_env=$(ssh "$HTTPEERS_SSH" 'grep -E "^S3_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)=" /opt/httpeers/.env')
ROOT_AK=$(sed -n 's/^S3_ACCESS_KEY_ID=//p' <<<"$root_env")
ROOT_SK=$(sed -n 's/^S3_SECRET_ACCESS_KEY=//p' <<<"$root_env")
unset root_env
[ -n "$ROOT_AK" ] && [ -n "$ROOT_SK" ] || { echo "S3_* keys not found in /opt/httpeers/.env." >&2; exit 1; }

SITE_SK=$(openssl rand -hex 32)

# The policy: list, read, write, delete inside each domain's prefix and nowhere else.
prefixes="" objects=""
for d in $SITE_DOMAINS; do
  prefixes+="${prefixes:+, }\"$d/*\""
  objects+="${objects:+, }\"arn:aws:s3:::sites/$d/*\""
done
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cat >"$tmp/policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": ["arn:aws:s3:::sites"],
      "Condition": { "StringLike": { "s3:prefix": [$prefixes] } } },
    { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": [$objects] }
  ]
}
JSON
# The container runs as its own user; mktemp made both readable only by us. The policy is not secret.
chmod a+rx "$tmp"; chmod a+r "$tmp/policy.json"

rc() { # rc in a container; keys come from the environment, so none reaches this host's argv.
  docker run --rm -i -v "$tmp:/w:ro" -e ROOT_AK -e ROOT_SK -e SITE_USER -e SITE_SK -e ENDPOINT \
    --entrypoint sh "$RC_IMAGE" -c "$1"
}
export ROOT_AK ROOT_SK SITE_USER SITE_SK ENDPOINT

echo "Creating RustFS user '$SITE_USER' with policy '$SITE_USER' on: $SITE_DOMAINS"
# shellcheck disable=SC2016  # expanded inside the container
rc '
  set -e
  rc alias set root "$ENDPOINT" "$ROOT_AK" "$ROOT_SK" >/dev/null
  rc admin policy create root "$SITE_USER" /w/policy.json
  rc admin user add root "$SITE_USER" "$SITE_SK"
  rc admin policy attach root "$SITE_USER" --user "$SITE_USER"
'

echo "Checking the new pair can write sites/$SITE_DOMAIN/.site/ (never served)"
rc "
  set -e
  rc alias set site \"\$ENDPOINT\" \"\$SITE_USER\" \"\$SITE_SK\" >/dev/null
  echo probe | rc pipe site/sites/$SITE_DOMAIN/.site/publish-probe >/dev/null
  rc object remove site/sites/$SITE_DOMAIN/.site/publish-probe >/dev/null
"

echo "Setting secrets and SITE_DOMAIN on $REPO"
printf %s "$SITE_USER" | gh secret set HTTPEERS_S3_ACCESS_KEY_ID -R "$REPO"
printf %s "$SITE_SK" | gh secret set HTTPEERS_S3_SECRET_ACCESS_KEY -R "$REPO"
gh variable set SITE_DOMAIN -R "$REPO" --body "$SITE_DOMAIN"

echo "Done. Publish: gh workflow run site.yml -R $REPO --ref main"
