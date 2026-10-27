# Crazy Clearance reply bot

Answers Instagram and Facebook DMs and comments for all three branches (Tipton, Oldham, Aylesbury) using the **Common Questions** Google Sheet and Claude.

- Only rows with Status **Confirmed** are ever used. Yellow rows go to staff.
- Anything else (orders, complaints, refunds, photos, unknown questions) goes to staff.
- Public comments that need staff get **no** public reply. DMs get a short holding message.
- When staff reply in a chat, the bot stays out of that chat for 12 hours.
- Code checks every reply before it is sent: prices, phone numbers, emails, links, postcodes, times and % must all appear in the approved answer it used. If not, the reply is blocked and staff are alerted.

## How it works

```
Customer DM/comment -> Meta webhook -> /webhook (signature checked)
  -> Google Sheet (cached 5 min) -> Claude picks reply / handoff / ignore
  -> safety checks -> send reply  OR  holding DM + staff alert
```

## Files

| File | What it does |
|---|---|
| `src/server.js` | Starts everything |
| `src/app.js` | Webhook routes, decision flow, `/admin` review page |
| `src/meta.js` | Signature check, reads Meta events, sends replies |
| `src/brain.js` | Prompt for Claude + safety checks |
| `src/sheet.js` | Reads the Google Sheet |
| `src/state.js` | Duplicate check, staff pause, chat memory, log |
| `scripts/try.js` | Try answers from your laptop |
| `data/common-questions.csv` | Offline copy of the sheet (used if no Google Sheet ID) |

## 1. Try it locally (10 min)

```bash
npm install
npm test
ANTHROPIC_API_KEY=sk-ant-... npm run try                     # runs 10 sample questions
ANTHROPIC_API_KEY=sk-ant-... npm run try -- "open sunday?" comment Aylesbury
```

## 2. Google Sheet

1. Upload `Crazy-Clearance-Common-Questions.xlsx` to Google Drive, open with Google Sheets.
2. Share > General access > **Anyone with the link: Viewer**. (The sheet holds public shop info only. Never put private data in it.)
3. Copy the ID from the URL: `docs.google.com/spreadsheets/d/<ID>/edit` -> `GOOGLE_SHEET_ID`.
4. Keep the tab name `Common Questions` and the header row (`ID, Category, Question, ...`). Staff edits show up within 5 minutes.

## 3. Meta setup

1. **One Business Portfolio** (business.facebook.com) that owns all 3 Facebook Pages. Link each Instagram account to its branch Page (Instagram must be a Professional account). Turn on Instagram app > Settings > Messages > **Allow access to messages**.
2. **Create app** at developers.facebook.com: type Business, add products **Messenger** and **Instagram** (API setup with Facebook login), and **Webhooks**.
3. **Deploy the server first** (step 4) so the webhook URL exists.
4. **Webhooks**: callback `https://<your-render-url>/webhook`, verify token = `META_VERIFY_TOKEN`.
   - Page object fields: `messages`, `message_echoes`, `feed`
   - Instagram object fields: `messages`, `comments`
5. **Tokens**: in Business settings > System users, create a system user, give it the 3 Pages, generate a token with the permissions below. Then get each Page's token:
   ```bash
   curl "https://graph.facebook.com/v23.0/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=SYSTEM_USER_TOKEN"
   ```
   This gives each Page ID, Page token and linked Instagram ID. Fill `ACCOUNTS_JSON` (Instagram entries use their Page's token).
6. **Subscribe each Page** to the app:
   ```bash
   curl -X POST "https://graph.facebook.com/v23.0/PAGE_ID/subscribed_apps?subscribed_fields=messages,message_echoes,feed&access_token=PAGE_TOKEN"
   ```
7. **Permissions** (need App Review + Business Verification for real customers): `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`, `pages_manage_engagement`, `pages_read_user_content`, `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`. Until approved, only people with a role on the app get replies. Use that to test.

## 4. Deploy on Render

1. Push this folder to a private GitHub repo.
2. Render > New > Blueprint > pick the repo (`render.yaml`). Use the Starter plan (the free plan sleeps).
3. Fill in the environment variables (see `.env.example`).
4. Check `https://<url>/health`.

## 5. Go live safely

1. Run in `BOT_MODE=shadow` for a few days. It decides but sends nothing.
2. Open `https://<url>/admin` (any username + `ADMIN_PASSWORD`) and read what it *would* have said.
3. Happy? Set `BOT_MODE=live`. Emergency stop: `BOT_MODE=off`.

## Keeping it right

- New answer: add a row in the sheet, set Status to Confirmed. No redeploy.
- Wrong answer: fix the row, or change Status back to "Check with manager" to stop the bot using it.
- Christmas / bank holidays: update the rows before the date.

## Limits

- Memory (staff pause, last 6 DM lines, `/admin` log) resets when the server restarts.
- DMs can only be answered within 24 hours of the customer's last message (Meta rule). The bot replies in seconds so this only matters for staff.
- TikTok is not covered.
