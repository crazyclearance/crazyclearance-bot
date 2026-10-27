import Anthropic from '@anthropic-ai/sdk';

const MAX_LEN = { dm: 600, comment: 220 };

export function buildSystemPrompt(questions) {
  const usable = questions.filter(q => q.usable);
  const notReady = questions.filter(q => !q.usable);
  const qa = usable.map(q =>
    `[${q.id}] ${q.question}\n  Also asked as: ${q.aliases}\n  Branch: ${q.branch}\n  DM answer: ${q.dm}\n  Comment answer: ${q.comment || '(no public answer, hand off)'}`
  ).join('\n\n');
  const blocked = notReady.map(q => `- ${q.question} (${q.aliases})`).join('\n');

  return `You answer Instagram and Facebook comments and DMs for Crazy Clearance, a UK clearance retailer with warehouses in Tipton, Oldham (the "Manchester" branch) and Aylesbury, plus online at crazyclearance.uk.

You may ONLY use facts from the APPROVED ANSWERS below. Each answer has an ID.

How to decide:
- If one or more approved answers cover the customer's message, reply using them. Keep their facts exactly (times, postcodes, phone numbers, emails, links). You may shorten or join them, and fit them to the message.
- Otherwise choose "handoff". Always hand off when: the topic is in NOT YET APPROVED, nothing approved fits, the customer is angry or complaining, it's about a specific order, payment problem, refund decision, legal issue, safety issue, a job application, or anything you would have to guess.
- Never state or guess a price, stock level, delivery date or refund outcome. Never invent phone numbers, emails, links, addresses or opening times.
- If asked whether you are a bot or a real person, say honestly that you're the shop's assistant and the team can jump in (Q47). Never claim to be human.
- Spam, abuse, emoji-only, "nice", tags of friends or messages that need no answer: choose "ignore".

Style:
- British English, friendly, short. Max one emoji.
- DM: up to 3-4 sentences. Reply in the customer's language if they don't write in English.
- Public comment: ONE short line. Never ask for personal details (order number, phone, email, address) in public. Point them to DM instead.
- Do not start with "Hi [name]" style placeholders. Do not sign off with a name.

The account that received the message belongs to one branch (given with each message). If the customer doesn't say which branch they mean, assume that branch for opening times and address, but don't hide the others if they ask.

APPROVED ANSWERS:
${qa}

NOT YET APPROVED (always hand off):
${blocked || '- (none)'}`;
}

export const DECIDE_TOOL = {
  name: 'decide',
  description: 'Give your decision for this customer message.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['reply', 'handoff', 'ignore'] },
      used_ids: { type: 'array', items: { type: 'string' }, description: 'IDs of approved answers the reply is based on, e.g. ["Q02"]' },
      text: { type: 'string', description: 'The reply to send. Empty unless action is reply.' },
      reason: { type: 'string', description: 'Short note for staff: why this action.' },
    },
    required: ['action', 'used_ids', 'text', 'reason'],
  },
};

// Pull out things that must never be invented: prices, phone numbers, emails, links, postcodes, times.
export function extractFacts(text) {
  const patterns = [
    /£\s?\d[\d,.]*/g,
    /\b0\d{3,4}\s?\d{3}\s?\d{3,4}\b/g,
    /[\w.+-]+@[\w-]+\.[\w.]+/g,
    /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+\.(?:uk|com|co\.uk|org|net)(?:\/[^\s]*)?/gi,
    /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/g,
    /\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/gi,
    /\b\d+\s?%/g,
  ];
  const found = new Set();
  for (const p of patterns) for (const m of text.match(p) || []) found.add(m.toLowerCase().replace(/\s+/g, '').replace(/[.,!?)]+$/, ''));
  return found;
}

/**
 * Safety checks in code, so a bad model output can never be sent.
 * Returns {ok:true} or {ok:false, why}.
 */
export function checkReply(decision, questions, channel) {
  const byId = new Map(questions.map(q => [q.id, q]));
  const ids = (decision.used_ids || []).map(s => String(s).toUpperCase().trim());
  const text = (decision.text || '').trim();

  if (!text) return { ok: false, why: 'empty reply' };
  if (ids.length === 0) return { ok: false, why: 'reply not based on any approved answer' };
  for (const id of ids) {
    const q = byId.get(id);
    if (!q) return { ok: false, why: `unknown answer id ${id}` };
    if (!q.usable) return { ok: false, why: `${id} is not confirmed yet` };
    if (channel === 'comment' && !q.comment) return { ok: false, why: `${id} has no public comment answer` };
  }
  if (text.length > MAX_LEN[channel]) return { ok: false, why: `reply too long for ${channel}` };
  if (/\[[^\]]*\]/.test(text)) return { ok: false, why: 'reply contains a [placeholder]' };

  const source = ids.map(id => `${byId.get(id).dm} ${byId.get(id).comment}`).join(' ');
  const allowed = extractFacts(source);
  for (const fact of extractFacts(text)) {
    if (!allowed.has(fact)) return { ok: false, why: `reply contains "${fact}" which is not in the approved answers` };
  }
  if (channel === 'comment' && /\b(your|ur)\s+(order number|phone|number|email|address|postcode)\b/i.test(text)) {
    return { ok: false, why: 'public comment asks for personal details' };
  }
  const emojis = text.match(/\p{Extended_Pictographic}/gu) || [];
  if (emojis.length > 1) return { ok: false, why: 'more than one emoji' };
  return { ok: true };
}

export function createBrain(cfg, client = new Anthropic({ apiKey: cfg.anthropicKey })) {
  let cachedPrompt = { questions: null, text: '' };

  return async function decide({ questions, channel, branch, platform, message, history = [] }) {
    if (cachedPrompt.questions !== questions) cachedPrompt = { questions, text: buildSystemPrompt(questions) };

    const context = history.length
      ? `Earlier in this chat:\n${history.map(h => `${h.role === 'customer' ? 'Customer' : 'Shop'}: ${h.text}`).join('\n')}\n\n`
      : '';
    const userContent = `${context}Account branch: ${branch}\nPlatform: ${platform}\nChannel: ${channel === 'dm' ? 'private DM' : 'PUBLIC comment on a post'}\nCustomer message:\n"""${message}"""`;

    const res = await client.messages.create({
      model: cfg.model,
      max_tokens: 500,
      system: [{ type: 'text', text: cachedPrompt.text, cache_control: { type: 'ephemeral' } }],
      tools: [DECIDE_TOOL],
      tool_choice: { type: 'tool', name: 'decide' },
      messages: [{ role: 'user', content: userContent }],
    });
    const call = res.content.find(b => b.type === 'tool_use');
    if (!call) return { action: 'handoff', used_ids: [], text: '', reason: 'model gave no decision' };
    const d = call.input;

    if (d.action !== 'reply') return d;
    const check = checkReply(d, questions, channel);
    if (!check.ok) return { ...d, action: 'handoff', blockedText: d.text, text: '', reason: `Blocked by safety check: ${check.why}` };
    return d;
  };
}
