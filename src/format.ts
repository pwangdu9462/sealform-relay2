/**
 * Shapes the readable response for the webhook it's going to. Slack, Discord
 * and Google Chat only accept their own message format; everything else
 * (Zapier, Make, n8n, your API) gets flat JSON: { fields: { question: answer } }.
 */
export type Readable = {
  source: 'sealform'
  form: { id: string; title: string }
  submission_id: string
  submitted_at: string
  answers: { id: string; question: string; type: string; answer: unknown }[]
}

export type Target = 'slack' | 'discord' | 'google_chat' | 'json'

export function targetFor(webhookUrl: string): Target {
  let host = ''
  let path = ''
  try {
    const u = new URL(webhookUrl)
    host = u.hostname
    path = u.pathname
  } catch {
    return 'json'
  }
  if (host === 'hooks.slack.com' && path.startsWith('/services/')) return 'slack'
  if (/^(ptb\.|canary\.)?discord(app)?\.com$/.test(host) && path.startsWith('/api/webhooks/')) return 'discord'
  if (host === 'chat.googleapis.com') return 'google_chat'
  return 'json'
}

/** One answer as text: lists joined, files by name, empty as a dash. */
export function answerText(answer: unknown): string {
  if (answer === null || answer === undefined || answer === '') return '—'
  if (Array.isArray(answer)) {
    if (answer.length === 0) return '—'
    return answer.map((x) => (x && typeof x === 'object' && 'name' in x ? String(x.name) : answerText(x))).join(', ')
  }
  if (typeof answer === 'object') return JSON.stringify(answer)
  return String(answer)
}

/** Answer value for JSON: files by name, everything else as answered. */
function jsonAnswer(answer: unknown): unknown {
  if (Array.isArray(answer)) return answer.map((x) => (x && typeof x === 'object' && 'name' in x ? String(x.name) : x))
  return answer ?? null
}

/** { question: answer }, so automations map by question, not position. Repeated questions get " (2)". */
export function fieldsOf(r: Readable): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const a of r.answers) {
    const base = a.question.trim() || a.id
    let key = base
    for (let n = 2; key in fields; n++) key = `${base} (${n})`
    fields[key] = jsonAnswer(a.answer)
  }
  return fields
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

/** Plain-text lines shared by the chat formats: "*Question*\nanswer". */
function lines(r: Readable, bold: (s: string) => string, max: number) {
  const head = `${bold(`New response: ${r.form.title}`)}\n`
  let text = head
  for (const a of r.answers) {
    const next = `\n${bold(a.question)}\n${answerText(a.answer)}\n`
    if (text.length + next.length > max - 40) {
      text += '\n…more answers in SealForm'
      break
    }
    text += next
  }
  return clip(text, max)
}

export function bodyFor(target: Target, r: Readable): unknown {
  switch (target) {
    case 'slack':
      return { text: lines(r, (s) => `*${s.replace(/\*/g, '')}*`, 3000) }
    case 'discord':
      return {
        username: 'SealForm',
        content: lines(r, (s) => `**${s.replace(/\*/g, '')}**`, 2000),
        allowed_mentions: { parse: [] },
      }
    case 'google_chat':
      return { text: lines(r, (s) => `*${s.replace(/\*/g, '')}*`, 4000) }
    default:
      return {
        source: r.source,
        form: r.form,
        submission_id: r.submission_id,
        submitted_at: r.submitted_at,
        fields: fieldsOf(r),
      }
  }
}
