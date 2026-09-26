# HMS Mgt bot inbox

This pull request is the **question queue** for the HMS Mgt iMessage group bot.

Do **not** merge it. The bot posts one GitHub issue comment per queued `@dev` / `@ops` question. An answering service (or a person) reads that comment, then writes the reply into the Mac bot's desk outbox file so iMessage gets the answer.

Comment shape:

- a short human line (`desk`, sender, question)
- a fenced `json` block with `desk`, `question`, `trigger_text`, `reply_to`, `chat_guid`, `source_chat_guid`, `sender_handle`, `ts`

`reply_to` is the queue guid the outbox expects.
