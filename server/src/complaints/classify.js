// Claude classification of a complaint (category, tone, severity, areas, hard route, a
// one-line summary). Only redacted text is sent (redact.js). Off unless ANTHROPIC_API_KEY
// is set; the rules classifier (taxonomy.js) always runs and is the fallback.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { AREAS, CATEGORIES, CATEGORY_KEYS, CAUSES, CAUSE_KEYS, HARD_ROUTES, TONES } from './taxonomy.js';

const MODEL = 'claude-opus-5-5';
const MAX_CHARS = 12_000; // one complaint thread; longer threads keep the first and last parts

const Result = z.object({
  is_complaint: z.boolean(),
  category: z.enum(CATEGORY_KEYS),
  tone: z.enum(TONES),
  severity: z.number().int().min(1).max(4),
  areas: z.array(z.enum(AREAS)),
  hard_route: z.enum([...Object.keys(HARD_ROUTES), 'none']),
  resolution_mentioned: z.string(),
  cause: z.enum([...CAUSE_KEYS, 'other']),
  contributing: z.array(z.enum(CAUSE_KEYS)),
  cause_evidence: z.string(),
  summary: z.string(),
  confidence: z.number().min(0).max(1),
});

const SYSTEM = `You classify customer complaints for a residential cleaning company in Ottawa.
Personal details have been replaced with placeholders like [name] and [address]; never try to recover them.

Categories: ${CATEGORIES.map((c) => `${c.key} (${c.label})`).join('; ')}; other (anything else, or unclear).
Tone: mild, frustrated, angry, threat_leave (says they will cancel or switch companies), threat_review (mentions a public review or social media).
Severity: 1 minor annoyance, 2 clear service failure, 3 serious failure or strong emotion, 4 needs a manager (damage, safety, theft, legal).
Hard route (only when clearly present): damage_over_100 (damage the client values over $100), theft_missing, safety, misconduct, legal_chargeback (lawyer, small claims, chargeback or card dispute); otherwise none.
is_complaint is false for questions, scheduling requests, compliments, and internal messages with no client dissatisfaction.
summary: one plain sentence describing what went wrong, with no names, addresses or amounts that identify the client.
resolution_mentioned: what the company offered or did, if the text says (e.g. "reclean offered", "30% refund"), else "".

Root cause: the category is WHAT the client complained about; the cause is WHY it happened. They are separate:
a complaint about missed areas whose client says their regular cleaner left has category quality_missed and cause regular_left.
Pick the one cause that best explains why, from this codebook, or "other" when none fits or the text doesn't say:
${CAUSES.map((c) => `- ${c.key}: ${c.label}. ${c.definition} Not this when: ${c.not_when}`).join('\n')}
The cause must be able to explain the category you chose. Never pair marketing_emails with anything but communication or other;
never give a quality or consistency cause to a damage, missing_item or conduct_safety complaint unless the client says that is why it happened.
Ignore email footers, signatures and system boilerplate ("unsubscribe", "view in browser") when choosing a cause.
contributing: up to two other causes from the codebook that clearly also played a part (never the same as cause); usually empty.
cause_evidence: the client's own words (at most 25, copied exactly, placeholders kept) that show the cause; "" when cause is other.`;

export function createClassifier({ apiKey, log = { warn() {} }, client = null } = {}) {
  if (!apiKey && !client) return null;
  const anthropic = client || new Anthropic({ apiKey, maxRetries: 3 });
  return async function classify(redactedText) {
    let text = String(redactedText || '');
    if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS * 0.7)}\n[…]\n${text.slice(-MAX_CHARS * 0.3)}`;
    try {
      const response = await anthropic.messages.parse({
        model: MODEL,
        max_tokens: 3000,
        output_config: { effort: 'low', format: zodOutputFormat(Result) },
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: `<complaint>\n${text}\n</complaint>` }],
      });
      if (response.stop_reason === 'refusal' || !response.parsed_output) return null;
      const r = response.parsed_output;
      return { ...r, hard_route: r.hard_route === 'none' ? null : r.hard_route, contributing: (r.contributing || []).slice(0, 2) };
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) log.warn('Claude classification: API key rejected; using rules only');
      else if (err instanceof Anthropic.RateLimitError) log.warn('Claude classification: rate limited; using rules for this case');
      else if (err instanceof Anthropic.APIError) log.warn('Claude classification failed; using rules', { status: err.status });
      else log.warn('Claude classification failed; using rules', { error: err.message });
      return null;
    }
  };
}
