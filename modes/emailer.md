# Mode: emailer -- Outreach Queue and Sender

## Purpose

Run a controlled outreach workflow that drafts, queues, approves, and sends emails.

Hard rule for this user:
- Always attach /Users/patel/Code/career-ops/DevSDE2026.pdf
- Never generate or swap resume files per role
- Message text may be adapted to JD context

## Inputs

- data/applications.md
- reports/
- config/profile.yml
- data/email-queue.tsv (created on first run)
- data/email-history.md (created on first run)
- data/contacto-export.json (written by contacto mode, consumed by --from-contacto)

## Commands

Initialize storage:

```bash
node emailer.mjs init
```

Check queue status (counts, today's cap, ready/failed):

```bash
node emailer.mjs status
```

Queue drafts from tracker rows (uses emails found in Notes):

```bash
node emailer.mjs queue --from-tracker [--template cold|followup|referral]
```

Queue contacts saved from /career-ops contacto:

```bash
node emailer.mjs queue --from-contacto [--template cold|followup|referral]
# or specify a custom path:
node emailer.mjs queue --from-contacto-file path/to/contacts.json
```

Queue manual contacts:

```bash
node emailer.mjs queue \
  --to "Recruiter <recruiter@company.com>,cto@company.com" \
  --company "Acme" --role "Backend Engineer" \
  --jd "Own APIs and platform reliability" \
  [--template cold|followup|referral] [--guessed]
```

Preview queue:

```bash
node emailer.mjs preview
node emailer.mjs preview --status drafted --full
```

Validate guessed email domains (DNS MX check):

```bash
node emailer.mjs validate
node emailer.mjs validate --ids 7,8
```

Edit a draft (body/subject/recipient/jd/confidence):

```bash
node emailer.mjs edit --id 3 --body "Hi John, ..."
node emailer.mjs edit --id 3 --subject "New subject line"
node emailer.mjs edit --id 3 --to "Jane Smith <jane@co.com>"
node emailer.mjs edit --id 3 --confidence verified
```

Approve queue items:

```bash
node emailer.mjs approve --ids 1,2
node emailer.mjs approve --ids 7,8 --allow_guessed
```

Retry failed sends (resets status to approved):

```bash
node emailer.mjs retry --ids 3,4
```

Delete draft/failed rows (cannot delete sent rows):

```bash
node emailer.mjs delete --ids 5,6
```

Dry run send (default, no network send):

```bash
node emailer.mjs send --ids 1,2
```

Live send — shows full drafts first, requires --confirmed to proceed:

```bash
# Step 1: review drafts (no send yet)
EMAIL_SMTP_USER="your-address@gmail.com" EMAIL_SMTP_PASS="<app-password>" \
  node emailer.mjs send --ids 1,2 --live

# Step 2: confirm and send
EMAIL_SMTP_USER="your-address@gmail.com" EMAIL_SMTP_PASS="<app-password>" \
  node emailer.mjs send --ids 1,2 --live --confirmed

# With guessed recipients:
EMAIL_SMTP_USER="your-address@gmail.com" EMAIL_SMTP_PASS="<app-password>" \
  node emailer.mjs send --ids 7,8 --live --confirmed --allow_guessed
```

## contacto-export.json format (for --from-contacto)

When /career-ops contacto finds contacts, save them as:

```json
{
  "company": "Acme Corp",
  "role": "Backend Engineer",
  "jd_summary": "Platform reliability, API ownership, Kubernetes",
  "template": "cold",
  "contacts": [
    { "name": "Jane Smith", "email": "jane.smith@acme.com", "confidence": "guessed", "type": "hiring_manager" },
    { "name": "Bob Jones", "email": "bob@acme.com", "confidence": "verified", "type": "cto" }
  ]
}
```

Confidence values: "verified" (email directly published) or "guessed" (inferred pattern).

## Template variants

| Template | Use case |
|----------|----------|
| `cold` | First outreach — never contacted before (default) |
| `followup` | After earlier application or outreach with no reply |
| `referral` | Peer/network approach — no direct job ask |

## Guardrails

- Explicit approval required before live sends (`status=approved`)
- Live send always shows full draft preview first — requires `--confirmed` to proceed
- Dry-run default when `--live` is omitted
- Daily cap: 20 emails
- Min spacing guard: 90 seconds between sends
- Guessed recipients require `--allow_guessed` flag
- Duplicate history: warns if same email+company already sent, but does not block
- Editing body/subject of approved row resets it to drafted (re-approval required)
- Sent rows cannot be edited or deleted

## Output

- Queue state in data/email-queue.tsv
- Send logs in data/email-history.md

## Notes

- Keep outreach quality high. Prefer targeted outreach over spam.
- Never send without user confirmation.
- After contacto runs, ask Claude to write data/contacto-export.json before using --from-contacto.
