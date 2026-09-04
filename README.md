# shopify-email-syncer

Sync local Shopify **notification email** templates (order confirmation,
shipping confirmation, password reset, …) into a store's Admin.

Shopify notification templates are Liquid blobs editable **only** in
Admin → Settings → Notifications — no Admin API (REST or GraphQL) can read or
write their bodies. This tool automates the only possible client: it drives
the Admin editor with Playwright, replacing the "Email body (HTML)" content
with your local file, filling "Email subject" from the file's header, and
clicking Save. In practice it lets you keep notification templates in git and
treat the repo as the source of truth.

## Requirements

- Node.js 18+
- Google Chrome installed (the tool uses your installed Chrome; it never
  downloads a browser)
- Staff access to the store's Shopify Admin

## Usage

Run directly from GitHub:

```sh
npx --yes github:nebulab/shopify-email-syncer --store my-store --templates ./emails --dry-run
```

Or clone and run locally:

```sh
npm install
node bin/shopify-email-syncer.mjs --store my-store --templates ./emails
```

Typical flow:

```sh
# 1. Drift check: compares every template, changes nothing
shopify-email-syncer --store my-store --templates ./emails --dry-run

# 2. Push one template
shopify-email-syncer --store my-store --templates ./emails --only order_confirmation

# 3. Push everything, then send a test email of each to your inbox
shopify-email-syncer --store my-store --templates ./emails --send-test
```

The **first run opens a headed Chrome window**: log in to the Shopify Admin
by hand (email + 2FA). The session persists in
`~/.shopify-email-syncer/chrome-profile`, so later runs — including runs against
other stores of the same account — reuse it without a new login.

## Flags

| Flag | Meaning |
| --- | --- |
| `--store <handle>` | **Required.** The Admin store handle — the part after `/store/` in `admin.shopify.com/store/<handle>`. |
| `--templates <dir>` | **Required.** Directory containing the `.liquid` template files. |
| `--map <file>` | JSON file mapping Admin handles to file names (see below). |
| `--only a,b,c` | Limit to these template handles or file names. |
| `--dry-run` | Read + compare only; never edits, never saves. |
| `--send-test` | After each processed template, trigger Admin's "Send test email" (goes to the logged-in staff account). |
| `--profile <dir>` | Chrome profile directory (default `~/.shopify-email-syncer/chrome-profile`). |
| `--help`, `--version` | The usual. |

## Template files

**Body**: the whole file is pasted as the email body, verbatim.

**Subject**: parsed from a `Subject:` line inside the file's leading
`{% comment %}` block — the same string you would otherwise re-type into the
Admin subject field:

```liquid
{% comment %}
  Order confirmation — sent when an order is placed.
  Subject: Order {% raw %}{{ name }}{% endraw %} confirmed
{% endcomment %}
<!doctype html>
...
```

`{% raw %}` tags around Liquid in the subject are stripped before pasting:
they exist so the header comment survives body rendering, and were never part
of the subject. A file without a `Subject:` line gets its body pasted and its
subject left untouched (with a warning).

See [`examples/templates/order_confirmation.liquid`](examples/templates/order_confirmation.liquid)
for a minimal complete file.

### Mapping files to Admin handles

Each Admin template has a handle — the slug in its editor URL,
`admin.shopify.com/store/<store>/email_templates/<handle>/edit`.

By default, handles are derived from file names, with hyphens becoming
underscores (Shopify handles never contain hyphens):

```
order-confirmation.liquid  ->  order_confirmation
customer_account_reset.liquid  ->  customer_account_reset
```

If your file names don't match the handles, add a `templates.json` next to the
templates (or point `--map` at one) mapping handle → file name:

```json
{
  "order_confirmation": "order-confirmation.liquid",
  "failed_payment_processing": "payment-error.liquid",
  "pickup_receipt": "picked-up-by-customer.liquid"
}
```

When a `templates.json` exists in the templates directory, it is the source of
truth: only the templates it lists are processed.

## How it works (and why it's safe)

- **Idempotent.** A template whose Admin body and subject already equal the
  local file is skipped — which is what makes `--dry-run` a fleet-wide drift
  checker.
- **Never blind-writes.** The Admin body is read and compared before any
  edit. If the editor content can't be read (it never hydrated, or the handle
  doesn't exist on the store), the template fails instead of being
  overwritten.
- **Saves are verified against the server.** After Save, the page is reloaded
  and the body + subject re-read: the in-page editor still holds whatever was
  written even when the save request failed, so only a post-reload match
  counts as success. Transient failures (a save race, a slow cold-Chrome
  hydration) are retried once.
- **Editor-agnostic.** Writes through CodeMirror 6 (the Admin editor today),
  with fallbacks for Ace, CodeMirror 5, a plain textarea, and — last resort —
  synthesized keyboard input, in case Shopify swaps the editor again.

Exit status is `0` when every selected template was processed (and every
requested test email sent), `1` otherwise.

## Gotchas

- **Preview and "Send test email" render the last SAVED template**, never
  unsaved editor content. The tool saves before sending, but under
  `--dry-run` nothing is saved, so `--send-test` mails whatever is currently
  live — useful for reviewing the status quo, not the local copy.
- **Nothing syncs back.** If someone edits a template in Admin, the next run
  overwrites it with the local copy (and `--dry-run` reports it as drift).
  That's the point — the repo is the source of truth — but agree on it with
  whoever else touches Admin.
- **Admin language**: button/field detection covers English and Italian
  Admin UIs. For any other Admin display language, either switch the staff
  account's language to English or extend the locator regexes in
  `bin/shopify-email-syncer.mjs` (`save`, `subjectField`, `sendTestEmail`).
- **One instance at a time.** Runs share a persistent Chrome profile; don't
  launch two runs concurrently against the same profile.

## Using it from Claude Code / coding agents

This tool is agent-friendly by design: deterministic flags, per-template
`=`/`~`/`+`/`!` output lines, a machine-checkable exit code, and a `--dry-run`
that never mutates anything. Notes for agents:

- It launches a **headed** Chrome and may need a human to complete the first
  login — run it in the foreground, outside any sandbox that blocks GUI apps
  or network access, and tell the user to expect a browser window.
- Start with `--dry-run` to report drift; push with `--only <handle>` for
  targeted updates.
- Never run two instances in parallel (shared Chrome profile).
- Template bodies can be thousands of lines; the tool handles the slow editor
  hydration itself. Don't kill a run that looks momentarily idle.

## Development

The whole tool is one file, `bin/shopify-email-syncer.mjs`. It depends only on
`playwright-core` (no browser download — it uses the installed Google Chrome
via `channel: 'chrome'`).

```sh
npm install
node bin/shopify-email-syncer.mjs --help
```

## License

[MIT](LICENSE)
