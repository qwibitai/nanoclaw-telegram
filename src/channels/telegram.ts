import https from 'https';
import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Resolve the effective JID for an incoming message.
 * If the message has a thread ID and that thread is registered as its own
 * group, return the thread-scoped JID. Otherwise fall back to the base chat JID,
 * which preserves the pre-threads behaviour of routing all thread messages
 * into the parent chat group.
 */
export function resolveJid(
  chatId: number | string,
  threadId: number | undefined,
  registeredGroups: Record<string, RegisteredGroup>,
): string {
  const baseJid = `tg:${chatId}`;
  if (!threadId) return baseJid;
  const threadJid = `tg:${chatId}:${threadId}`;
  return registeredGroups[threadJid] ? threadJid : baseJid;
}

/**
 * Build the /chatid reply text.
 * In a thread, shows both the thread-scoped JID and the base chat JID.
 */
export function formatChatIdReply(
  chatId: number | string,
  threadId: number | undefined,
  chatName: string,
  chatType: string,
  topicName?: string,
): string {
  const baseJid = `tg:${chatId}`;
  const threadJid = threadId ? `tg:${chatId}:${threadId}` : null;

  const lines = threadJid
    ? [
        `Thread ID: \`${threadJid}\`${topicName ? ` — ${topicName}` : ''} _(register to isolate this thread)_`,
        `Chat ID: \`${baseJid}\` — ${chatName} _(register to include all threads)_`,
        `Type: ${chatType}`,
      ]
    : [`Chat ID: \`${baseJid}\``, `Name: ${chatName}`, `Type: ${chatType}`];

  return lines.join('\n');
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private topicNames = new Map<string, string>(); // `${chatId}:${threadId}` → topic name

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Cache forum topic names so thread registrations get a meaningful name
    this.bot.on('message:forum_topic_created', (ctx) => {
      const threadId = ctx.message.message_thread_id;
      if (threadId) {
        this.topicNames.set(
          `${ctx.chat.id}:${threadId}`,
          ctx.message.forum_topic_created.name,
        );
      }
    });

    this.bot.on('message:forum_topic_edited', (ctx) => {
      const threadId = ctx.message.message_thread_id;
      if (threadId && ctx.message.forum_topic_edited.name) {
        this.topicNames.set(
          `${ctx.chat.id}:${threadId}`,
          ctx.message.forum_topic_edited.name,
        );
      }
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';
      const threadId = ctx.message?.message_thread_id;
      const topicName = threadId
        ? this.topicNames.get(`${chatId}:${threadId}`)
        : undefined;
      ctx.reply(
        formatChatIdReply(chatId, threadId, chatName, chatType, topicName),
        {
          parse_mode: 'Markdown',
        },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      const pingThreadId = ctx.message?.message_thread_id;
      if (pingThreadId) {
        ctx.reply(`${ASSISTANT_NAME} is online.`, {
          message_thread_id: pingThreadId,
        });
      } else {
        ctx.reply(`${ASSISTANT_NAME} is online.`);
      }
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const threadId = ctx.message.message_thread_id;
      const baseJid = `tg:${ctx.chat.id}`;
      const threadJid = threadId ? `tg:${ctx.chat.id}:${threadId}` : null;
      const groups = this.opts.registeredGroups();
      const chatJid = threadJid && groups[threadJid] ? threadJid : baseJid;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name — for thread-scoped JIDs prefer the topic name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (threadId &&
              chatJid === threadJid &&
              this.topicNames.get(`${ctx.chat.id}:${threadId}`)) ||
            (ctx.chat as any).title ||
            chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = groups[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        thread_id: threadId ? threadId.toString() : undefined,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const threadId = ctx.message?.message_thread_id;
      const baseJid = `tg:${ctx.chat.id}`;
      const threadJid = threadId ? `tg:${ctx.chat.id}:${threadId}` : null;
      const groups = this.opts.registeredGroups();
      const chatJid = threadJid && groups[threadJid] ? threadJid : baseJid;
      const group = groups[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      const nonTextChatName =
        threadId && chatJid === threadJid
          ? this.topicNames.get(`${ctx.chat.id}:${threadId}`)
          : undefined;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        nonTextChatName,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const [numericId, threadId] = jid.replace(/^tg:/, '').split(':');
      const threadOptions = threadId
        ? { message_thread_id: Number(threadId) }
        : {};

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text, threadOptions);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
            threadOptions,
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const [numericId, threadId] = jid.replace(/^tg:/, '').split(':');
      if (threadId) {
        await this.bot.api.sendChatAction(numericId, 'typing', {
          message_thread_id: Number(threadId),
        });
      } else {
        await this.bot.api.sendChatAction(numericId, 'typing');
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
