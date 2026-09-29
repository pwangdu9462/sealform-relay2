# SealForm relay

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/annangiv/sealform-relay)

A tiny Cloudflare Worker that **you** run to send [SealForm](https://sealform.co) responses to Zapier, Make, n8n, Slack, Discord, Google Chat or your own API, without SealForm ever being able to read them. It runs on Cloudflare's free plan.

## How it works

```
respondent's browser ──(encrypted)──▶ SealForm ──(still encrypted, signed)──▶ your relay ──(readable JSON)──▶ your webhook
```

- SealForm responses are end-to-end encrypted. On first start the relay **makes its own key pair** and keeps the private key in a Durable Object in **your** Cloudflare account. Nobody copies keys around.
- When you connect it, your browser seals the form's key to the relay's public key, the same way SealForm shares a form with a teammate.
- SealForm sends the relay ciphertext signed with SealForm's Ed25519 key. The relay checks the signature, decrypts **inside your Cloudflare account**, and posts readable JSON to your `WEBHOOK_URL`.
- SealForm never sees the decrypted answers, and it never learns your `WEBHOOK_URL`. The relay only reports back an HTTP status.
- Anything you send to a webhook can be read by that service. Only connect tools you trust with this data.

## Set up

1. In SealForm, open a form → **Integrations** → **Deploy relay to my Cloudflare** (or use the button above).
2. Sign in to Cloudflare (a free account is enough). When asked for **`WEBHOOK_URL`**, paste where responses should go, e.g. a Zapier "Catch Hook" or Slack incoming-webhook URL. Leave the other settings as they are, then deploy.
3. Copy the Worker's address (`https://sealform-relay.<you>.workers.dev`), paste it into SealForm, and click **Connect**.

If Cloudflare shows **No URLs enabled**, open the Worker → **Settings → Domains & Routes** and turn on `workers.dev`.

That's it: no keys to copy. To send a form somewhere else, change `WEBHOOK_URL` in Cloudflare, or deploy another relay.

Command line instead:

```bash
npm install && npx wrangler deploy
npx wrangler secret put WEBHOOK_URL
```

| Setting | Kind | Meaning |
|---|---|---|
| `WEBHOOK_URL` | secret | Where decrypted responses go |
| `SEALFORM_ORIGIN` | var | The SealForm to trust (default `https://sealform.co`) |
| `SEALFORM_PUBLIC_KEY` | var | Optional: pin SealForm's delivery key instead of fetching it (local testing) |

**Your webhook is another Worker in the same account?** Cloudflare doesn't let one `workers.dev` Worker call another by URL. Add a service binding named `WEBHOOK_SERVICE` to that Worker, and the relay will deliver through it.

## What your webhook receives

**Slack** (`hooks.slack.com/services/…`), **Discord** (`discord.com/api/webhooks/…`) and **Google Chat** (`chat.googleapis.com/…`) webhooks get a chat message listing each question and answer. Long responses are cut to the chat's size limit.

Everything else (Zapier, Make, n8n, your API) gets this JSON:

```json
{
  "source": "sealform",
  "form": { "id": "…", "title": "Patient intake" },
  "submission_id": "…",
  "submitted_at": "2026-09-28T19:30:00.000Z",
  "fields": {
    "Full name": "Robin",
    "Symptoms": ["Cough", "Fever"],
    "Insurance card": ["card.jpg"]
  }
}
```

Each question is a key, so in Zapier, Make or n8n you map **fields → Full name** directly, and it keeps working if you reorder the form. A repeated question gets a suffix: `Name`, `Name (2)`. Checkboxes come as lists, and files as their names.

File contents aren't forwarded, only their names. Download files from SealForm.

## Security notes

- `POST /deliver` rejects anything not signed by SealForm's Ed25519 delivery key (over `timestamp.body`, with a 5-minute window). The relay fetches that public key from `SEALFORM_ORIGIN/.well-known/sealform-delivery-key` and caches it.
- The relay never logs answers. Observability is off by default.
- To revoke a relay, remove it in SealForm. The form then gets a new key, so the old relay can't read new responses. Then delete the Worker.
- Crypto is `@noble/curves`, `@noble/ciphers` and `@noble/hashes` (audited, pure JS), matching libsodium's sealed boxes and XChaCha20-Poly1305. Run `npm test` to check interop with SealForm's browser code.
