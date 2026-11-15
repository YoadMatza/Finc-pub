# "Ask my money" v2: a chat that answers (plan, 2026-11-13)

The owner's report on 2026-11-13 (screenshot): asked for the average monthly and yearly car spending without foreign
transactions, the chat asked three clarifying questions in a row, never gave a number, and one reply showed raw JSON
(`{"answer":"…חו\"ל…"}`). "In general it seems a bit dumb."

Nothing here is built yet.

## 1. What goes wrong today (packages/core/src/ai/chat.ts)

| # | Cause | Effect seen |
|---|---|---|
| 1 | The protocol is "reply with one JSON object" as plain text, and `parseReply` falls back to the raw text when `JSON.parse` fails. Hebrew abbreviations carry a quote mark (חו"ל, ש"ח, בע"מ); one badly escaped quote breaks the JSON. | Raw `{"answer": …}` on screen. |
| 2 | `maxTokens: 1500` for every round. On OpenAI's reasoning models (gpt-5-mini, the default) the hidden reasoning spends the same budget. | Long answers can be cut mid-JSON → same raw text, or an empty answer. |
| 3 | Each turn starts with no lookups: only the conversation text is sent back, so the data fetched for the previous question is gone. | "Both" / "yes" → the model has nothing to compute with, so it asks again. |
| 4 | No tool totals spending over a filter. `spend_by_category` gives one range, `find_transactions` caps at 50 rows, nothing filters by currency or by category group (car = fuel + parking + insurance + maintenance + public transport), nothing gives a monthly average. | The model cannot answer "average per month, without abroad", so it stalls with questions. |
| 5 | The prompt says what not to do ("never invent numbers") but not to go ahead: nothing says "pick a sensible default, say it, answer". | Interrogation instead of an answer. |
| 6 | No test of answer quality: tests check the protocol and privacy, never "did it answer the question". | Regressions are invisible. |

## 2. The plan

### Step 1: reliable replies (the bug)
- Use each provider's structured output instead of free text. Anthropic gets native tool use (each finc tool becomes a tool
  definition, and the answer is a final `answer` tool). OpenAI gets function calling or `response_format: json_schema`. A
  local model keeps the text protocol.
- Tolerant fallback for the text protocol: if `JSON.parse` fails, extract the `answer` string (handle unescaped quotes
  inside Hebrew words), unescape it, and never show `{"answer"` to the user. If nothing can be extracted, show "I couldn't
  form an answer, try again" and log the kind only.
- Token budget: a larger output budget for the final answer, and on reasoning models `reasoning_effort: low` for lookup
  rounds, with an explicit "ran out of tokens" message instead of a half-reply.

### Step 2: an answer-first assistant
- Prompt rules:
  - Answer first with sensible defaults and state them in one line ("last 12 full months, foreign = charged in a foreign
    currency").
  - Ask a clarifying question only when the answer would be materially different, and at most one per question.
  - Never ask the user to confirm what they already said.
  - When the user says "both", do both.
- Memory across turns: the server keeps the last turn's lookups (results already sent to the model, nothing new leaves
  the PC) keyed by a chat id the web sends. A follow-up continues from them.
- Better tools, aggregation done on the PC, the model gets only totals:
  - `spend_summary`: filters for category or group (car, lifestyle…), merchant, date range, currency (ILS only / foreign
    only / all), account type, bucket (fixed / variable / instalments). It groups by month, category, merchant or none, and
    returns the total, months counted, the monthly average (full months only), a 12-month total and the count. One call
    answers the screenshot's question.
  - `compare_periods`: this month vs the same month last year, or vs the 6-month average, per category.
  - `find_transactions`: adds a currency filter and a total over all matches (still at most 50 rows listed).
  - Category groups are visible to the model: the group key and its Hebrew/English names are already approved egress words.
- Answers:
  - Numbers first, one-line method ("based on 12 full months, 11/2025–10/2026").
  - Hebrew numbers direction-isolated, as in Telegram.
  - Follow-up chips on the web: "by month", "with abroad", "show the transactions".

### Step 3: model choice
- Today the default is gpt-5-mini (cheap, fast, the weakest at multi-step questions). Settings → AI gets a "chat model"
  choice separate from categorisation, with a rough cost per 100 questions shown:
  - fast: haiku / gpt-5-mini;
  - better: claude-sonnet-5-5 / gpt-5.
  With step 1–2 a small model should do well; the eval (step 4) shows whether "better" is worth it.

### Step 4: a quality check (eval)
- 25 questions in Hebrew and English over a fixed fixture database. Each has a known correct number, the right tool, and
  the expected behaviour: answer directly, or ask once when it is truly ambiguous.
- They include the screenshot's car question, "how much abroad this year", "biggest increase vs last year", "when is the
  next insurance payment", follow-ups ("and by month?"), and a privacy probe (a person's name must stay masked).
- `finc chat-eval --model …` runs them against the configured provider on demand (costs a few cents, never automatic) and
  prints answered / correct / asked-instead / leaked. Pure-protocol tests stay in vitest with a fake provider.

## 3. Privacy and safety (unchanged rules)
- Only merchant and category names, amounts and dates reach the model, through the existing `modelName` / `guardEgress`.
  The new tools return aggregates, which means less detail than today's row lists.
- Lookup memory lives in the worker's memory for 30 minutes per chat id, not on disk, and is cleared by "new chat" and by
  any vault lock.
- Still descriptive only: no investment or product advice.

## 4. Build order
1. Reliable replies + token budget (the bug; small, ship first).
2. `spend_summary` + currency/group filters + prompt rules + lookup memory.
3. Eval set + `finc chat-eval`; run it on the current model and on one stronger model.
4. Model choice in Settings (only if the eval says it matters) and follow-up chips.

## 5. Decisions for the owner
1. Step 3's model choice: keep gpt-5-mini as the default, or move the chat to a stronger model (more cost per question)?
2. Running the eval calls the AI provider with fixture data only (no real data): about 25–50 calls per run. OK?
3. "Foreign": charged in a foreign currency (what the bank data has). A shekel charge at a foreign site can't be told
   apart reliably. OK as the definition?
