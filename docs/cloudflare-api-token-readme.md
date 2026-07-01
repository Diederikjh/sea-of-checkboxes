# Cloudflare API Token README

This repo uses one Cloudflare API token for both GitHub Actions deploy workflows:

- `.github/workflows/deploy-worker.yml`
- `.github/workflows/deploy-pages.yml`

The token is stored in GitHub as the repository secret `CLOUDFLARE_API_TOKEN`.

## Create The Token

In Cloudflare:

1. Go to `Manage Account`.
2. Open `Account API Tokens`.
3. Select `Create token`.
4. Name it `sea-of-checkboxes-github-deploy`.

Add these account-token permissions:

| Permission group | Policy value |
| --- | --- |
| `Pages` | `Read` |
| `Pages` | `Write` |
| `Workers R2 Storage` | `Read` |
| `Workers R2 Storage` | `Write` |
| `Workers KV Storage` | `Read` |
| `Workers KV Storage` | `Write` |
| `Workers Scripts` | `Read` |
| `Workers Scripts` | `Write` |

TODO might be simpler to just use:

- Workers Scripts (Edit)
- Workers R2 Storage (Edit)
- Cloudflare Pages (Edit) (needed for Pages deploy workflow)
- Account Settings (Read)
- User Memberships (Read)
- User Details (Read)


Cloudflare may not show a permission group named `Cloudflare Workers` in this UI.
For this repo, use the more specific `Workers Scripts`, `Workers KV Storage`, and
`Workers R2 Storage` groups instead.

## Resource Scope

If Cloudflare offers a resource scope selector, scope the token to this Cloudflare
account. If the `Account API Tokens` page does not offer a `Specific account`
choice, that is expected: account-owned tokens are already created under the
current account context.

Do not scope this token to specific Workers. The worker deploy references more
than one account-level resource type:

- Worker script
- Durable Object bindings and migrations
- KV namespace binding for share links
- R2 bucket binding for tile snapshots
- Pages project deploy

Scoping to specific Workers can make `wrangler deploy` or `wrangler pages deploy`
fail even when the script permission itself looks correct.

Leave client IP filtering blank for GitHub Actions unless you are prepared to
maintain GitHub-hosted runner IP ranges. A token expiration date is optional; if
you set one, add a calendar reminder to rotate the GitHub secret before it
expires.

## Save It In GitHub

Cloudflare only shows the token value once. Copy it and set the GitHub secret:

```bash
gh secret set CLOUDFLARE_API_TOKEN
```

Paste the token when prompted.

Also confirm the account ID secret is set:

```bash
gh secret set CLOUDFLARE_ACCOUNT_ID
```

## Verify Locally

To verify the token before rerunning CI:

```bash
read -rsp "Cloudflare API token: " CLOUDFLARE_API_TOKEN
echo

curl -fsS "https://api.cloudflare.com/client/v4/user/tokens/verify" \
  --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
```

The response should include `"success": true`.

You can also run a Wrangler auth check:

```bash
CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN}" pnpm dlx wrangler whoami
```

Do not commit the token or add it to an env file tracked by git.
