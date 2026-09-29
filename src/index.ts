/**
 * SealForm relay: a Cloudflare Worker that YOU run, holding the only key that
 * lets an integration read your form's responses.
 *
 * SealForm sends it ciphertext; it decrypts here, inside your Cloudflare
 * account, and forwards the answers to your WEBHOOK_URL: plain JSON for Zapier,
 * Make, n8n or your API; a chat message for Slack, Discord and Google Chat. SealForm never sees the plaintext or where it goes.
 *
 * Nothing to copy from SealForm: on first start the relay makes its own key
 * pair and keeps the private key in a Durable Object in your account. When you
 * connect it, your browser seals the form's key to the relay's public key.
 *
 * Settings:
 *   WEBHOOK_URL          (secret) where decrypted responses go
 *   SEALFORM_ORIGIN      (var) SealForm to trust, default https://sealform.co
 *   SEALFORM_PUBLIC_KEY  (var, optional) pin SealForm's delivery key instead of
 *                        fetching it; needed when SealForm isn't reachable
 *                        from Cloudflare, e.g. local development
 *   WEBHOOK_SERVICE      (optional service binding) deliver to another Worker in
 *                        your account; workers.dev Workers can't fetch each other by URL
 */
import { DurableObject } from 'cloudflare:workers'
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { decryptSubmission, fromB64, publicKeyFor, toB64 } from './crypto'
import { bodyFor, targetFor, type Readable } from './format'

export interface Env {
  KEYS: DurableObjectNamespace<RelayKeys>
  WEBHOOK_URL: string
  SEALFORM_ORIGIN?: string
  SEALFORM_PUBLIC_KEY?: string
  WEBHOOK_SERVICE?: Fetcher
}

/**
 * Holds the relay's private key. A Durable Object gives one strongly
 * consistent copy, so two Cloudflare locations can't each create a key.
 */
export class RelayKeys extends DurableObject {
  async secretKey(): Promise<Uint8Array> {
    const existing = await this.ctx.storage.get<Uint8Array>('relay_sk')
    if (existing) return new Uint8Array(existing)
    const sk = x25519.utils.randomSecretKey()
    await this.ctx.storage.put('relay_sk', sk)
    return sk
  }
}

async function relaySecretKey(env: Env): Promise<Uint8Array> {
  return env.KEYS.get(env.KEYS.idFromName('relay')).secretKey()
}

let cachedSealformKey: { key: Uint8Array; at: number } | null = null

/** SealForm's Ed25519 delivery key: pinned by config, else fetched and cached. */
async function sealformKey(env: Env, forceRefresh = false): Promise<Uint8Array> {
  if (env.SEALFORM_PUBLIC_KEY) return fromB64(env.SEALFORM_PUBLIC_KEY)
  if (!forceRefresh && cachedSealformKey && Date.now() - cachedSealformKey.at < 3600_000) return cachedSealformKey.key
  const origin = (env.SEALFORM_ORIGIN || 'https://sealform.co').replace(/\/$/, '')
  const res = await fetch(`${origin}/.well-known/sealform-delivery-key`)
  if (!res.ok) throw new Error(`could not fetch SealForm key (HTTP ${res.status})`)
  const body = (await res.json()) as { public_key: string }
  cachedSealformKey = { key: fromB64(body.public_key), at: Date.now() }
  return cachedSealformKey.key
}

type Field = { id: string; type: string; label: string }

type Delivery = {
  integration_id: string
  form: { id: string; title: string; schema: { fields?: Field[] } }
  submission: { id: string; key_version: number; sealed_key: string; ciphertext: string; created_at: number }
  sealed_form_sk: string
}

const MAX_SKEW_SECS = 300
const LAYOUT = new Set(['heading', 'text', 'divider', 'link'])

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Turns decrypted answers into { question, answer } rows, in form order. */
function readable(delivery: Delivery, answers: Record<string, unknown>) {
  const fields = (delivery.form.schema.fields ?? []).filter((f) => !LAYOUT.has(f.type))
  return fields.map((f) => {
    let value = answers[f.id] ?? null
    // File answers carry a decryption key: forward name/type/size only.
    if (f.type === 'file' && Array.isArray(value)) {
      value = value.map((x: Record<string, unknown>) => ({ name: x.name, type: x.type, size: x.size }))
    }
    return { id: f.id, question: f.label, type: f.type, answer: value }
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // Health check: SealForm compares this public key with the one it
    // registered, so a mistyped URL or someone else's relay is refused.
    if (request.method === 'GET' && url.pathname === '/') {
      return json({
        service: 'sealform-relay',
        ok: true,
        public_key: toB64(publicKeyFor(await relaySecretKey(env))),
        webhook_configured: Boolean(env.WEBHOOK_URL),
        webhook_kind: env.WEBHOOK_URL ? targetFor(env.WEBHOOK_URL) : null,
      })
    }

    if (request.method !== 'POST' || url.pathname !== '/deliver') return json({ error: 'not found' }, 404)
    if (!env.WEBHOOK_URL) return json({ error: 'WEBHOOK_URL is not set' }, 500)

    // Only SealForm can make the relay decrypt: deliveries carry an Ed25519
    // signature over "<timestamp>.<body>" from SealForm's delivery key.
    const body = await request.text()
    const ts = Number(request.headers.get('x-sealform-timestamp') ?? '0')
    const sigB64 = request.headers.get('x-sealform-signature') ?? ''
    if (!ts || Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SECS) return json({ error: 'stale request' }, 401)
    const message = new TextEncoder().encode(`${ts}.${body}`)
    let sig: Uint8Array
    try {
      sig = fromB64(sigB64)
    } catch {
      return json({ error: 'bad signature' }, 401)
    }
    const verify = async (refresh: boolean) => {
      try {
        return sig.length === 64 && ed25519.verify(sig, message, await sealformKey(env, refresh))
      } catch {
        return false
      }
    }
    // One refetch covers SealForm rotating its key.
    if (!(await verify(false)) && !(await verify(true))) return json({ error: 'bad signature' }, 401)

    let delivery: Delivery
    let answers: Record<string, unknown>
    let submittedAt: number
    try {
      delivery = JSON.parse(body)
      const env2 = decryptSubmission(await relaySecretKey(env), {
        form_id: delivery.form.id,
        key_version: delivery.submission.key_version,
        sealed_form_sk: delivery.sealed_form_sk,
        sealed_key: delivery.submission.sealed_key,
        ciphertext: delivery.submission.ciphertext,
      })
      answers = env2.answers
      submittedAt = env2.submitted_at
    } catch {
      // Never log the payload: it is encrypted, but keep logs empty on principle.
      return json({ error: 'could not decrypt; this relay may not be connected to that form' }, 422)
    }

    const out: Readable = {
      source: 'sealform',
      form: { id: delivery.form.id, title: delivery.form.title },
      submission_id: delivery.submission.id,
      submitted_at: new Date(submittedAt || delivery.submission.created_at * 1000).toISOString(),
      answers: readable(delivery, answers),
    }
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'sealform-relay/1' },
      body: JSON.stringify(bodyFor(targetFor(env.WEBHOOK_URL), out)),
    }
    const res = env.WEBHOOK_SERVICE ? await env.WEBHOOK_SERVICE.fetch(env.WEBHOOK_URL, init) : await fetch(env.WEBHOOK_URL, init)
    // Only the status goes back to SealForm, never the plaintext.
    return json({ delivered: res.ok, webhook_status: res.status }, res.ok ? 200 : 502)
  },
}
