// All settings come from environment variables (set them in Render > Environment).

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}. See .env.example`);
  return v;
}

/**
 * ACCOUNTS_JSON: one entry per Facebook Page / Instagram account the bot answers for.
 * Key = the Page ID or Instagram account ID that Meta puts in webhooks.
 * Instagram accounts use the access token of the Facebook Page they are linked to.
 * Example:
 * {
 *   "111": {"platform":"facebook","branch":"Tipton","token":"EAAB..."},
 *   "1784...": {"platform":"instagram","branch":"Tipton","token":"EAAB...(Tipton page token)"}
 * }
 */
export function loadAccounts(raw = process.env.ACCOUNTS_JSON) {
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  for (const [id, a] of Object.entries(parsed)) {
    if (!['facebook', 'instagram'].includes(a.platform)) throw new Error(`Account ${id}: platform must be facebook or instagram`);
    if (!['Tipton', 'Oldham', 'Aylesbury'].includes(a.branch)) throw new Error(`Account ${id}: branch must be Tipton, Oldham or Aylesbury`);
    if (!a.token) throw new Error(`Account ${id}: token missing`);
  }
  return parsed;
}

export function loadConfig() {
  const mode = (process.env.BOT_MODE || 'shadow').toLowerCase();
  if (!['live', 'shadow', 'off'].includes(mode)) throw new Error('BOT_MODE must be live, shadow or off');
  return {
    port: Number(process.env.PORT || 3000),
    // live = send replies, shadow = work out replies but only log them, off = ignore everything
    mode,
    verifyToken: required('META_VERIFY_TOKEN'),
    appSecret: required('META_APP_SECRET'),
    // Needed to tell the bot's own messages apart from staff replies.
    appId: required('META_APP_ID'),
    graphVersion: process.env.META_GRAPH_VERSION || 'v23.0',
    accounts: loadAccounts(),
    anthropicKey: required('ANTHROPIC_API_KEY'),
    model: process.env.CLAUDE_MODEL || 'claude-haiku-5-5',
    sheetId: process.env.GOOGLE_SHEET_ID || '',
    sheetTab: process.env.GOOGLE_SHEET_TAB || 'Common Questions',
    localCsv: process.env.LOCAL_CSV || 'data/common-questions.csv',
    sheetCacheSeconds: Number(process.env.SHEET_CACHE_SECONDS || 300),
    // Sent in DMs when the bot hands over to staff. Empty = stay silent.
    holdingDm: process.env.HOLDING_DM ?? "Thanks for your message! Someone from the team will get back to you shortly.",
    // After a staff member replies in a chat, the bot stays out of that chat for this many hours.
    humanPauseHours: Number(process.env.HUMAN_PAUSE_HOURS || 12),
    handoffWebhookUrl: process.env.HANDOFF_WEBHOOK_URL || '',
    adminPassword: process.env.ADMIN_PASSWORD || '',
  };
}
