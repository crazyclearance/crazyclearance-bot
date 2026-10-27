// Test the bot's answers from your laptop before connecting Meta.
// Usage: ANTHROPIC_API_KEY=sk-... npm run try -- "are you open sunday?" [dm|comment] [Tipton|Oldham|Aylesbury]
// No message given = runs a built-in list of test questions.
import { readFileSync } from 'node:fs';
import { parseCsv, rowsToQuestions } from '../src/sheet.js';
import { createBrain } from '../src/brain.js';

const [msg, channel = 'dm', branch = 'Tipton'] = process.argv.slice(2);
const questions = rowsToQuestions(parseCsv(readFileSync(process.env.LOCAL_CSV || 'data/common-questions.csv', 'utf8')));
const decide = createBrain({ anthropicKey: process.env.ANTHROPIC_API_KEY, model: process.env.CLAUDE_MODEL || 'claude-haiku-5-5' });

const samples = msg ? [[msg, channel, branch]] : [
  ['are you open on sunday?', 'dm', 'Tipton'],
  ['open sunday?', 'comment', 'Aylesbury'],
  ['how much is this?', 'comment', 'Tipton'],
  ['can you hold this for me till saturday', 'dm', 'Oldham'],
  ['is this real or fake', 'comment', 'Tipton'],
  ['my order 1234 never came, this is a joke', 'dm', 'Tipton'],
  ['do you deliver to Birmingham?', 'dm', 'Tipton'],
  ['are you a bot?', 'dm', 'Oldham'],
  ['kya aap Sunday ko khule ho?', 'dm', 'Tipton'],
  ['🔥🔥', 'comment', 'Tipton'],
];

for (const [m, c, b] of samples) {
  const d = await decide({ questions, channel: c, branch: b, platform: 'instagram', message: m });
  console.log(`\n[${b} ${c}] ${m}\n -> ${d.action.toUpperCase()} ${d.used_ids?.join(',') || ''}\n    ${d.text || d.blockedText || ''}\n    (${d.reason})`);
}
