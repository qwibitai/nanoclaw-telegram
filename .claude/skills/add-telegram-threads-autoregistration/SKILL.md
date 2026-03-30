---
name: add-telegram-threads-autoregistration
description: Auto-register Telegram forum threads as isolated groups. Each new thread in a registered supergroup gets its own group context automatically. Requires Telegram channel with thread support (use /add-telegram then apply the telegram-threads branch). Triggers on "auto-register threads", "telegram threads", "forum topics isolation".
---

# Add Auto-Register Telegram Threads

This skill makes NanoClaw automatically register each Telegram forum thread as its own isolated group the first time a message is received in it. The thread inherits the parent group's trigger, container config, and `requiresTrigger` setting.

**Prerequisite**: The Telegram channel must be set up with forum thread support. The `TelegramChannel` class in `src/channels/telegram.ts` must already have a `topicNames` map and `forum_topic_created`/`forum_topic_edited` listeners. If those are not present, apply the telegram-threads changes first.

## How It Works

- When a message arrives in a thread of a registered supergroup, the host checks whether a group for `tg:<chatId>:<threadId>` exists
- If not, it auto-registers it using the cached forum topic name (if available) or `Thread <id>` as the group name
- The thread group folder is `<parentFolder>_<threadSlug>` (e.g. `telegram_mygroup_support`) — readable and derived from the parent group's folder and the topic name
- From that point on, messages in the thread are routed to its own isolated group context

## Implementation

### Step 1: Expose `registerGroup` to channels

Read `src/channels/registry.ts`. Add an optional `registerGroup` callback to the `ChannelOpts` interface so channels can register new groups at runtime:

```typescript
registerGroup?: (jid: string, group: RegisteredGroup) => void;
```

Import `RegisteredGroup` from `../types.js` if it is not already imported.

### Step 2: Wire `registerGroup` into channel opts

Read `src/index.ts`. Find where `channelOpts` is constructed and add `registerGroup` to it:

```typescript
registerGroup,
```

The `registerGroup` function already exists in `index.ts` — this just makes it accessible to channels.

### Step 3: Update the Telegram channel

Read `src/channels/telegram.ts` in full before making any changes.

#### 3a. Add `registerGroup` to `TelegramChannelOpts`

Add the optional callback to the `TelegramChannelOpts` interface:

```typescript
registerGroup?: (jid: string, group: RegisteredGroup) => void;
```

#### 3b. Add the `autoRegisterThread` private method

Add this method to `TelegramChannel`:

```typescript
private autoRegisterThread(
  chatId: number | string,
  threadId: number,
  parentGroup: RegisteredGroup,
): void {
  if (!this.opts.registerGroup) return;
  const jid = `tg:${chatId}:${threadId}`;
  const name =
    this.topicNames.get(`${chatId}:${threadId}`) || `Thread ${threadId}`;
  const threadSlug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || `thread_${threadId}`;
  const folder = `${parentGroup.folder}_${threadSlug}`.slice(0, 64);
  this.opts.registerGroup(jid, {
    name,
    folder,
    trigger: parentGroup.trigger,
    added_at: new Date().toISOString(),
    containerConfig: parentGroup.containerConfig,
    requiresTrigger: parentGroup.requiresTrigger,
  });
  logger.info({ jid, name, folder }, 'Auto-registered Telegram thread');
}
```

#### 3c. Auto-register in the text message handler

In the `message:text` handler, after resolving `threadId`, `baseJid`, and `threadJid`, and after calling `this.opts.registeredGroups()`, add the auto-register check before resolving `chatJid`:

```typescript
if (threadId && threadJid && !groups[threadJid] && groups[baseJid]) {
  this.autoRegisterThread(ctx.chat.id, threadId, groups[baseJid]);
  groups = this.opts.registeredGroups();
}
```

The variable holding registered groups must be declared with `let` so it can be reassigned after registration.

#### 3d. Auto-register in the non-text message handler

Apply the same pattern inside the `storeNonText` helper. After resolving `threadId`, `baseJid`, `threadJid`, and calling `registeredGroups()`, add:

```typescript
if (threadId && threadJid && !groups[threadJid] && groups[baseJid]) {
  this.autoRegisterThread(ctx.chat.id, threadId, groups[baseJid]);
  groups = this.opts.registeredGroups();
}
```

### Step 4: Build and restart

```bash
npm run build
# macOS:
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
# Linux:
systemctl --user restart nanoclaw
```

### Step 5: Test

Tell the user:

> Send a message in any thread of a registered Telegram supergroup. Then run `/chatid` in that thread — you should see a thread-scoped JID (`tg:<chatId>:<threadId>`). Check the groups list to confirm it was auto-registered.
>
> Check logs: `grep "Auto-registered" logs/nanoclaw.log`

## Architecture Notes

- Auto-registration happens on first message — threads that are never messaged are never registered
- The thread folder is derived from the parent group's folder and the topic name slug, so it is human-readable (e.g. `telegram_mygroup_support`) and stable as long as the topic name doesn't change
- If the forum topic name is not cached yet (e.g. the bot restarted after the topic was created), the group name falls back to `Thread <id>` and can be renamed manually
- The parent group's trigger, `requiresTrigger`, and `containerConfig` are all inherited

## Removal

To remove auto-register thread support:

1. Remove the `autoRegisterThread` method from `TelegramChannel`
2. Remove the auto-register checks from the `message:text` handler and `storeNonText`
3. Remove `registerGroup?` from `TelegramChannelOpts`
4. Remove `registerGroup?` from `ChannelOpts` in `src/channels/registry.ts` (only if no other channel uses it)
5. Remove `registerGroup` from `channelOpts` in `src/index.ts` (only if no other channel uses it)
6. Rebuild and restart
