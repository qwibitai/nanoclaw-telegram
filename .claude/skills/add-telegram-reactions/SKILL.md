---
name: add-telegram-reactions
description: Add two-way emoji reactions between the user and the NanoClaw agent in Telegram. The agent can react to incoming messages as a lightweight status signal (👀 → 👏) via the new `react_to_message` MCP tool; user reactions on the agent's messages arrive as synthetic `[Reaction: X] on message Y` events that the agent interprets as shortcut commands.
---

# Add Telegram Emoji Reactions

This skill adds a bidirectional emoji-reaction channel to the NanoClaw Telegram integration. It delivers two things:

1. **Agent → user status signals.** The agent can call the new `react_to_message(message_id, emoji)` MCP tool to react to the user's incoming message as a quick acknowledgment — 👀 when it starts, 👏 when it finishes, 💔 on failure, ✍ after a wiki ingest, etc. The user sees an instant reaction on their own message rather than waiting for a text reply, which is especially useful for long-running tasks (web research, document ingest, scheduled reports).

2. **User → agent shortcut commands.** When the user adds an emoji reaction to one of the agent's messages, the Telegram channel's new `message_reaction` handler delivers it back as a synthetic user message in the form `[Reaction: X] on message Y`. The agent interprets this as a shortcut command (👍 confirm, ❤ ingest to wiki, 🤩 repeat, 🔥 pin, 👌 close Todoist task, etc.) per the user-specific skill doc in the group.

The actual semantics of each emoji are **user-specific** and live in the group's skill docs / `CLAUDE.md`. This skill ships the transport layer — not the command vocabulary.

## What this adds

- `mcp__nanoclaw__react_to_message` MCP tool in the agent-runner
- `reactToMessage?(jid, messageId, emoji)` optional method on the `Channel` interface (`src/types.ts`)
- `bot.on('message_reaction')` handler + `reactToMessage()` method in `src/channels/telegram.ts`
- `allowed_updates: ['message', 'edited_message', 'callback_query', 'message_reaction']` in `bot.start()` (grammy's default polling set does NOT subscribe to reaction updates — this is required)
- `type: 'react'` IPC handler in `src/ipc.ts` with sender-group authorization (only the owning group or main group can emit reactions into a chat)
- `reactToMessage` wire-through from `startIpcWatcher` in `src/index.ts` via `findChannel(jid)` → `channel.reactToMessage`

If a channel does not implement `reactToMessage` (e.g. WhatsApp without the parallel reactions skill), the IPC is silently dropped with a `warn` log rather than throwing — so agents running on other channels continue to work cleanly even when they attempt to use the tool.

## Prerequisites

- The Telegram channel must already be installed (`/add-telegram` — the `nanoclaw-telegram` main branch merged into your NanoClaw install)
- Node.js, container runtime running (Docker or Apple Container)
- No new npm dependencies — uses grammy's existing `Bot.api.setMessageReaction`

## ⚠️ Telegram Bot API whitelist

Telegram restricts bot reactions to a fixed whitelist of ~74 emoji. As of Bot API 7.0 it includes:

```
👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡
🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈
😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿
🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂ 🤷 🤷‍♀ 😡
```

Emoji outside this list fail the API call with `Bad Request: REACTION_INVALID`. The `reactToMessage` wrapper logs at `warn` level on failure so these can be noticed and replaced over time. When designing a command vocabulary in your group's skill doc, pick exclusively from the whitelist — grammy's own types enforce it at compile time in the channel code.

Custom emoji reactions are premium-only and are not supported by this skill.

## Phase 1: Pre-flight

### Check if already applied

```bash
grep -q "reactToMessage" src/types.ts && echo "Already applied" || echo "Not applied"
```

If already applied, skip to **Phase 3: Verify**.

## Phase 2: Apply code changes

Five files change. All edits are additive — no behaviour changes for existing callers, and the conditional `reactToMessage?` on the `Channel` interface means channels that don't implement reactions keep working.

### `src/types.ts`

Add to the `Channel` interface:

```ts
// Optional: send an emoji reaction to a specific message. Channels that
// have a reactions API (Telegram) implement this; others leave it
// undefined and the host layer drops react_to_message IPCs with a warn.
reactToMessage?(jid: string, messageId: string, emoji: string): Promise<void>;
```

### `src/ipc.ts`

Add to `IpcDeps`:

```ts
reactToMessage?: (
  jid: string,
  messageId: string,
  emoji: string,
) => Promise<void>;
```

Inside the `messageFiles` processing loop, add a new branch after the existing `data.type === 'message'` block:

```ts
} else if (
  data.type === 'react' &&
  data.chatJid &&
  data.messageId &&
  data.emoji
) {
  const targetGroup = registeredGroups[data.chatJid];
  const authorized =
    isMain || (targetGroup && targetGroup.folder === sourceGroup);
  if (!authorized) {
    logger.warn(
      { chatJid: data.chatJid, sourceGroup },
      'Unauthorized IPC reaction attempt blocked',
    );
  } else if (!deps.reactToMessage) {
    logger.warn(
      { chatJid: data.chatJid, sourceGroup, emoji: data.emoji },
      'IPC reaction dropped — no channel supports reactToMessage',
    );
  } else {
    await deps.reactToMessage(data.chatJid, data.messageId, data.emoji);
    logger.info(
      {
        chatJid: data.chatJid,
        sourceGroup,
        messageId: data.messageId,
        emoji: data.emoji,
      },
      'IPC reaction sent',
    );
  }
}
```

### `src/channels/telegram.ts`

Add a private field `botId: number | null = null` to the `TelegramChannel` class.

Inside `connect()`, after the existing media handlers and before `this.bot.catch(...)`, add the incoming-reactions handler:

```ts
this.bot.on('message_reaction', async (ctx) => {
  const chatJid = `tg:${ctx.chat.id}`;
  const group = this.opts.registeredGroups()[chatJid];
  if (!group) return;

  const reaction = ctx.messageReaction;
  if (!reaction) return;

  // Filter the bot's own reactions out of the inbound stream
  const user = reaction.user;
  const reactorId = user?.id;
  if (this.botId != null && reactorId === this.botId) return;

  const timestamp = new Date(reaction.date * 1000).toISOString();
  const senderName = user
    ? user.first_name || user.username || user.id.toString()
    : 'Unknown';
  const sender = reactorId != null ? reactorId.toString() : '';

  // Deliver NEWLY added emoji only (set difference new - old)
  const oldEmojis = new Set<string>();
  for (const r of reaction.old_reaction || []) {
    if (r.type === 'emoji') oldEmojis.add(r.emoji);
  }
  const addedEmojis: string[] = [];
  for (const r of reaction.new_reaction || []) {
    if (r.type === 'emoji' && !oldEmojis.has(r.emoji)) {
      addedEmojis.push(r.emoji);
    }
  }
  if (addedEmojis.length === 0) return;

  const isGroup =
    ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
  this.opts.onChatMetadata(
    chatJid,
    timestamp,
    undefined,
    'telegram',
    isGroup,
  );

  for (const emoji of addedEmojis) {
    this.opts.onMessage(chatJid, {
      id: `reaction-${reaction.message_id}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 6)}`,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content: `[Reaction: ${emoji}] on message ${reaction.message_id}`,
      timestamp,
      is_from_me: false,
    });
  }
});
```

Add the `reactToMessage` method to the class:

```ts
async reactToMessage(
  jid: string,
  messageId: string,
  emoji: string,
): Promise<void> {
  if (!this.bot) {
    logger.warn('Telegram bot not initialized (reactToMessage)');
    return;
  }
  try {
    const numericChatId = Number(jid.replace(/^tg:/, ''));
    const numericMsgId = Number.parseInt(messageId, 10);
    if (Number.isNaN(numericChatId) || Number.isNaN(numericMsgId)) {
      logger.warn(
        { jid, messageId },
        'reactToMessage: invalid chat or message id',
      );
      return;
    }
    await this.bot.api.setMessageReaction(numericChatId, numericMsgId, [
      { type: 'emoji', emoji: emoji as never },
    ]);
    logger.info({ jid, messageId, emoji }, 'Telegram reaction sent');
  } catch (err) {
    logger.warn(
      { jid, messageId, emoji, err },
      'Failed to send Telegram reaction (likely REACTION_INVALID — emoji not in Bot API whitelist)',
    );
  }
}
```

Update the existing `this.bot.start({ onStart: ... })` call to include `allowed_updates` and capture `botId`:

```ts
this.bot!.start({
  allowed_updates: [
    'message',
    'edited_message',
    'callback_query',
    'message_reaction',
  ],
  onStart: (botInfo) => {
    this.botId = botInfo.id;
    // ...existing logging...
    resolve();
  },
});
```

### `container/agent-runner/src/ipc-mcp-stdio.ts`

Register a new MCP tool after the existing `send_message` tool:

```ts
server.tool(
  'react_to_message',
  `Send an emoji reaction to a specific message in the chat. A lightweight
status signal without a full text reply. Telegram only: other channels
silently drop the IPC. Telegram Bot API only accepts emoji from a fixed
~74 whitelist; unsupported emoji fail silently at the API layer and are
logged at warn level on the host.`,
  {
    message_id: z.string().describe('The message id to react to'),
    emoji: z.string().describe('The emoji character (must be in whitelist)'),
  },
  async (args) => {
    writeIpcFile(MESSAGES_DIR, {
      type: 'react',
      chatJid,
      messageId: args.message_id,
      emoji: args.emoji,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: `Reaction ${args.emoji} queued for message ${args.message_id}.`,
        },
      ],
    };
  },
);
```

### `src/index.ts`

In the `startIpcWatcher({ ... })` call, add a `reactToMessage` closure alongside the existing `sendMessage`:

```ts
reactToMessage: async (jid, messageId, emoji) => {
  const channel = findChannel(channels, jid);
  if (!channel) {
    logger.warn(
      { jid, messageId, emoji },
      'reactToMessage: no channel owns JID',
    );
    return;
  }
  if (!channel.reactToMessage) {
    logger.warn(
      { jid, channel: channel.name, messageId, emoji },
      'reactToMessage: channel does not implement reactions, dropping',
    );
    return;
  }
  await channel.reactToMessage(jid, messageId, emoji);
},
```

### Validate

```bash
npm run build
npm test
```

All tests must pass — the change is purely additive and no existing tests touch the new paths.

## Phase 3: Verify

### Rebuild + restart

```bash
npm run build
./container/build.sh        # rebuild container to pick up the new MCP tool
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# Linux: systemctl --user restart nanoclaw
```

On Apple Container, the buildkit may need a clean prune before the container rebuild picks up the agent-runner changes:

```bash
container builder stop && container builder rm && container builder start
./container/build.sh
```

### Sanity checks

1. Start a chat with your bot. Send any message.
2. Ask the agent to react: **"отреагируй на моё прошлое сообщение эмодзи 👀"** (or in English). It should invoke `react_to_message` and you should see a 👀 reaction appear on your message in Telegram within a second or two.
3. You react with 👍 on any message the agent sent. Check container logs for `[Reaction: 👍] on message <id>` as a synthetic user message being delivered.
4. `grep "Telegram reaction sent" logs/nanoclaw.log` should show successful reactions.
5. `grep "REACTION_INVALID" logs/nanoclaw.log` should show any emoji that failed the whitelist — if so, pick replacements from the list at the top of this doc.

## Phase 4: Design a command vocabulary

This skill ships the **transport layer only**. To actually use the bidirectional channel, document a command vocabulary in your group's skill docs or `CLAUDE.md`. Example sections:

### Agent → user status signals

Pick from the whitelist. Common choices:

| Emoji | Meaning |
|---|---|
| 👀 | Seen, starting |
| ⚡ | Long-running task |
| 👏 | Done |
| 💔 | Failed |
| 🤔 | Need info |
| 🫡 | Queued / scheduled |
| ✍ | Wiki ingest |
| 🙏 | Retrying |
| 🙊 | Acknowledged silently |

### User → agent commands

Also from the whitelist:

| Emoji | Command |
|---|---|
| 👍 | Confirm / approve last pending |
| 👎 | Reject / cancel |
| ❤ | Remember / ingest to knowledge base |
| 🤩 | Repeat last action |
| 🔥 | Important / pin |
| 👌 | Mark done |
| 🤬 | Stop / delete |
| 🤔 | Explain in more detail |
| 🫡 | Follow-up reminder |
| 😴 | Quiet, no text reply |

Adapt the table to your own workflow — these are defaults.

## Troubleshooting

### Reactions from the user don't arrive

- Check logs for `Telegram bot connected` — the connect trace should show the bot ID. If the bot started but no reaction events arrive, `allowed_updates` is probably missing `message_reaction`. Re-verify the `bot.start()` call.
- In group chats, the bot must be an admin to receive reaction updates. In private DMs, this is not required.
- The Bot API delivers reactions only for reactions added AFTER the bot started. Older reactions are not replayed.

### Agent's reactions don't appear

- `grep "REACTION_INVALID" logs/nanoclaw.log` — if present, the emoji isn't in the whitelist. Replace it.
- `grep "Telegram bot not initialized" logs/nanoclaw.log` — channel was reloaded mid-flight. Restart the service.
- In a group chat, bot permissions must include the ability to add reactions; default admin permissions usually grant this.

### Agent sees its own reactions as commands

- The `botId` filter requires that `connect()` populates `this.botId = botInfo.id` in `onStart`. Verify the code change landed.

## Removal

1. Revert the 5 file changes (or cherry-pick the commit with `-R`)
2. `npm run build && ./container/build.sh && launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
3. No database cleanup is needed — reactions are ephemeral, not persisted

## Relationship to the whatsapp/skill/reactions branch

There is an existing `skill/reactions` branch on the `nanoclaw-whatsapp` repo that also adds reaction support. That branch takes a heavier approach: a full `src/status-tracker.ts` forward-only state machine with persistence and retry, plus a `reactions` SQLite table for history. It's WhatsApp-only because it modifies WhatsApp channel files directly.

This Telegram skill is **lighter**:

- No state machine — the agent's CLAUDE.md is the state model
- No `reactions` table — reactions are ephemeral signals, not a persistent log
- Two-way from day one (the whatsapp skill is primarily one-way status, with reactions-as-log as a side effect)

If you want both channels to have reactions, both skills can coexist — they share the same `Channel.reactToMessage` interface boundary introduced here, and the host layer routes based on `findChannel(jid)`.
