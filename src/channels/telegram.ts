import https from 'https';
import { Bot } from 'grammy';

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
 * Strip markdown syntax for clean plain-text fallback.
 * Preserves all content — only removes formatting markers.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '') // headings
    .replace(/\*\*(.+?)\*\*/g, '$1') // **bold**
    .replace(/__(.+?)__/g, '$1') // __bold__
    .replace(/\*(.+?)\*/g, '$1') // *italic*
    .replace(/_(.+?)_/g, '$1') // _italic_
    .replace(/~~(.+?)~~/g, '$1') // ~~strike~~
    .replace(
      /`{3}[\s\S]*?`{3}/g,
      (
        m, // ```code blocks``` — keep content
      ) => m.replace(/^`{3}\w*\n?/, '').replace(/\n?`{3}$/, ''),
    )
    .replace(/`(.+?)`/g, '$1') // `inline code`
    .replace(/^\s*---+\s*$/gm, '') // horizontal rules
    .replace(/^>\s?/gm, '') // > blockquotes
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // [text](url) → text
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Convert standard Markdown (as produced by LLMs) to Telegram-compatible HTML.
 * Only emits tags that Telegram's HTML parse_mode supports:
 * <b>, <i>, <s>, <code>, <pre>, <a href>, <blockquote>.
 *
 * Security: all text is HTML-escaped before tags are applied, so injected
 * HTML in the input is neutralised.
 */
export function markdownToHtml(text: string): string {
  if (!text) return text;

  // Phase 1: Extract code blocks and inline code before any processing.
  // This prevents formatting regexes from matching inside code.
  const codeBlocks: { lang: string; content: string }[] = [];
  const inlineCodes: string[] = [];

  // Fenced code blocks (``` ... ```)
  let result = text.replace(
    /^```(\w*)\n([\s\S]*?)^```$/gm,
    (_, lang, content) => {
      codeBlocks.push({ lang, content });
      return `\x00CB${codeBlocks.length - 1}\x00`;
    },
  );

  // Inline code (` ... `)
  result = result.replace(/`([^`]+)`/g, (_, content) => {
    inlineCodes.push(content);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // Phase 2: HTML-escape all remaining text first (neutralises injected HTML)
  result = escapeHtml(result);

  // Formatting conversions — order matters:
  // Double-char markers (**,__,~~) before single-char (*,_)

  // Bold: **text** and __text__
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  result = result.replace(/__(.+?)__/g, '<b>$1</b>');

  // Italic: *text* and _text_
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>');
  result = result.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<i>$1</i>');

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Headings → bold (no <h1>-<h6> in Telegram)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // Blockquotes: lines starting with > (HTML-escaped to &gt;)
  // Collect consecutive blockquote lines into a single <blockquote>
  result = result.replace(
    /(?:^&gt;\s?(.*)$\n?)+/gm,
    (match) => {
      const lines = match
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => l.replace(/^&gt;\s?/, ''));
      return `<blockquote>${lines.join('\n')}</blockquote>`;
    },
  );

  // Images: ![alt](url) → link (before link regex so ! prefix is consumed)
  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Horizontal rules → remove
  result = result.replace(/^\s*[-*_]{3,}\s*$/gm, '');

  // Phase 3: Restore protected regions with HTML-escaped content

  // Restore code blocks
  result = result.replace(/\x00CB(\d+)\x00/g, (_, idx) => {
    const block = codeBlocks[Number(idx)];
    const escaped = escapeHtml(block.content);
    if (block.lang) {
      return `<pre><code class="language-${block.lang}">${escaped}</code></pre>`;
    }
    return `<pre>${escaped}</pre>`;
  });

  // Restore inline code
  result = result.replace(/\x00IC(\d+)\x00/g, (_, idx) => {
    return `<code>${escapeHtml(inlineCodes[Number(idx)])}</code>`;
  });

  return result;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

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

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: <code>tg:${chatId}</code>\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'HTML' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

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
      const group = this.opts.registeredGroups()[chatJid];
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
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
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
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
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

  /**
   * Convert a raw text chunk to HTML and send it, falling back to
   * clean plain text if Telegram rejects the formatted message.
   */
  private async sendChunk(chatId: string, chunk: string): Promise<void> {
    try {
      const formatted = markdownToHtml(chunk);
      await this.bot!.api.sendMessage(chatId, formatted, {
        parse_mode: 'HTML',
      });
    } catch {
      // HTML send failed (e.g. malformed tags from edge-case markdown).
      // Fall back to clean plain text with markdown syntax stripped.
      logger.debug(
        { chatId },
        'MarkdownV2 send failed, falling back to plain text',
      );
      await this.bot!.api.sendMessage(chatId, stripMarkdown(chunk));
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Split raw text first, then convert each chunk independently.
      // This avoids breaking MarkdownV2 escape sequences mid-message.
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await this.sendChunk(numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.sendChunk(numericId, text.slice(i, i + MAX_LENGTH));
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
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
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
