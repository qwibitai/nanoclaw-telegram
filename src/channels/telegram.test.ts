import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock env reader (used by the factory, not needed in unit tests)
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- Grammy mock ---

type Handler = (...args: any[]) => any;

const botRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('grammy', () => ({
  Bot: class MockBot {
    token: string;
    commandHandlers = new Map<string, Handler>();
    filterHandlers = new Map<string, Handler[]>();
    errorHandler: Handler | null = null;

    api = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
    };

    constructor(token: string) {
      this.token = token;
      botRef.current = this;
    }

    command(name: string, handler: Handler) {
      this.commandHandlers.set(name, handler);
    }

    on(filter: string, handler: Handler) {
      const existing = this.filterHandlers.get(filter) || [];
      existing.push(handler);
      this.filterHandlers.set(filter, existing);
    }

    catch(handler: Handler) {
      this.errorHandler = handler;
    }

    start(opts: { onStart: (botInfo: any) => void }) {
      opts.onStart({ username: 'andy_ai_bot', id: 12345 });
    }

    stop() {}
  },
}));

import {
  TelegramChannel,
  TelegramChannelOpts,
  resolveJid,
  formatChatIdReply,
} from './telegram.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<TelegramChannelOpts>,
): TelegramChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'tg:100200300': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createTextCtx(overrides: {
  chatId?: number;
  chatType?: string;
  chatTitle?: string;
  text: string;
  fromId?: number;
  firstName?: string;
  username?: string;
  messageId?: number;
  date?: number;
  entities?: any[];
  threadId?: number;
}) {
  const chatId = overrides.chatId ?? 100200300;
  const chatType = overrides.chatType ?? 'group';
  return {
    chat: {
      id: chatId,
      type: chatType,
      title: overrides.chatTitle ?? 'Test Group',
    },
    from: {
      id: overrides.fromId ?? 99001,
      first_name: overrides.firstName ?? 'Alice',
      username: overrides.username ?? 'alice_user',
    },
    message: {
      text: overrides.text,
      date: overrides.date ?? Math.floor(Date.now() / 1000),
      message_id: overrides.messageId ?? 1,
      entities: overrides.entities ?? [],
      message_thread_id: overrides.threadId,
    },
    me: { username: 'andy_ai_bot' },
    reply: vi.fn(),
  };
}

function createMediaCtx(overrides: {
  chatId?: number;
  chatType?: string;
  fromId?: number;
  firstName?: string;
  date?: number;
  messageId?: number;
  caption?: string;
  extra?: Record<string, any>;
  threadId?: number;
}) {
  const chatId = overrides.chatId ?? 100200300;
  return {
    chat: {
      id: chatId,
      type: overrides.chatType ?? 'group',
      title: 'Test Group',
    },
    from: {
      id: overrides.fromId ?? 99001,
      first_name: overrides.firstName ?? 'Alice',
      username: 'alice_user',
    },
    message: {
      date: overrides.date ?? Math.floor(Date.now() / 1000),
      message_id: overrides.messageId ?? 1,
      caption: overrides.caption,
      message_thread_id: overrides.threadId,
      ...(overrides.extra || {}),
    },
    me: { username: 'andy_ai_bot' },
  };
}

function currentBot() {
  return botRef.current;
}

async function triggerTextMessage(ctx: ReturnType<typeof createTextCtx>) {
  const handlers = currentBot().filterHandlers.get('message:text') || [];
  for (const h of handlers) await h(ctx);
}

async function triggerMediaMessage(
  filter: string,
  ctx: ReturnType<typeof createMediaCtx>,
) {
  const handlers = currentBot().filterHandlers.get(filter) || [];
  for (const h of handlers) await h(ctx);
}

async function triggerForumTopicCreated(ctx: {
  chat: { id: number };
  message: { message_thread_id: number; forum_topic_created: { name: string } };
}) {
  const handlers =
    currentBot().filterHandlers.get('message:forum_topic_created') || [];
  for (const h of handlers) await h(ctx);
}

async function triggerForumTopicEdited(ctx: {
  chat: { id: number };
  message: { message_thread_id: number; forum_topic_edited: { name?: string } };
}) {
  const handlers =
    currentBot().filterHandlers.get('message:forum_topic_edited') || [];
  for (const h of handlers) await h(ctx);
}

// --- Pure function tests ---

describe('resolveJid', () => {
  it('returns base JID when there is no thread ID', () => {
    expect(resolveJid(123, undefined, {})).toBe('tg:123');
  });

  it('returns base JID when thread is not registered', () => {
    expect(
      resolveJid(123, 456, {
        'tg:123': { name: 'G', folder: 'g', trigger: '', added_at: '' },
      }),
    ).toBe('tg:123');
  });

  it('returns thread JID when thread is registered', () => {
    expect(
      resolveJid(123, 456, {
        'tg:123:456': { name: 'T', folder: 't', trigger: '', added_at: '' },
      }),
    ).toBe('tg:123:456');
  });

  it('prefers thread JID over base JID when both are registered', () => {
    const groups = {
      'tg:123': { name: 'G', folder: 'g', trigger: '', added_at: '' },
      'tg:123:456': { name: 'T', folder: 't', trigger: '', added_at: '' },
    };
    expect(resolveJid(123, 456, groups)).toBe('tg:123:456');
  });

  it('falls back to base JID for a different unregistered thread in the same chat', () => {
    expect(
      resolveJid(123, 789, {
        'tg:123:456': { name: 'T', folder: 't', trigger: '', added_at: '' },
      }),
    ).toBe('tg:123');
  });

  it('handles string chatId', () => {
    expect(
      resolveJid('-100987', 10, {
        'tg:-100987:10': { name: 'T', folder: 't', trigger: '', added_at: '' },
      }),
    ).toBe('tg:-100987:10');
  });
});

describe('formatChatIdReply', () => {
  it('formats a plain (non-thread) reply', () => {
    const result = formatChatIdReply(123, undefined, 'My Chat', 'private');
    expect(result).toBe('Chat ID: `tg:123`\nName: My Chat\nType: private');
  });

  it('formats a thread reply without a cached topic name', () => {
    const result = formatChatIdReply(-100123, 456, 'My Group', 'supergroup');
    expect(result).toContain('`tg:-100123:456`');
    expect(result).toContain('_(register to isolate this thread)_');
    expect(result).toContain('`tg:-100123`');
    expect(result).toContain('My Group');
    expect(result).toContain('supergroup');
  });

  it('includes topic name in the thread line when provided', () => {
    const result = formatChatIdReply(
      -100123,
      456,
      'My Group',
      'supergroup',
      'Support',
    );
    expect(result).toContain('`tg:-100123:456` — Support');
  });

  it('shows parent chat name on the base JID line, not the topic name', () => {
    const result = formatChatIdReply(
      -100123,
      456,
      'My Group',
      'supergroup',
      'Support',
    );
    const lines = result.split('\n');
    const chatLine = lines.find((l) => l.startsWith('Chat ID:'))!;
    expect(chatLine).toContain('My Group');
    expect(chatLine).not.toContain('Support');
  });

  it('omits a standalone Name line for thread replies', () => {
    const result = formatChatIdReply(-100123, 456, 'My Group', 'supergroup');
    expect(result).not.toMatch(/^Name:/m);
  });
});

// --- Class tests ---

describe('TelegramChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when bot starts', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('registers command and message handlers on connect', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(currentBot().commandHandlers.has('chatid')).toBe(true);
      expect(currentBot().commandHandlers.has('ping')).toBe(true);
      expect(currentBot().filterHandlers.has('message:text')).toBe(true);
      expect(currentBot().filterHandlers.has('message:photo')).toBe(true);
      expect(currentBot().filterHandlers.has('message:video')).toBe(true);
      expect(currentBot().filterHandlers.has('message:voice')).toBe(true);
      expect(currentBot().filterHandlers.has('message:audio')).toBe(true);
      expect(currentBot().filterHandlers.has('message:document')).toBe(true);
      expect(currentBot().filterHandlers.has('message:sticker')).toBe(true);
      expect(currentBot().filterHandlers.has('message:location')).toBe(true);
      expect(currentBot().filterHandlers.has('message:contact')).toBe(true);
    });

    it('registers error handler on connect', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(currentBot().errorHandler).not.toBeNull();
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Text message handling ---

  describe('text message handling', () => {
    it('delivers message for registered group', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hello everyone' });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Test Group',
        'telegram',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          id: '1',
          chat_jid: 'tg:100200300',
          sender: '99001',
          sender_name: 'Alice',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ chatId: 999999, text: 'Unknown chat' });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:999999',
        expect.any(String),
        'Test Group',
        'telegram',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips bot commands (/chatid, /ping) but passes other / messages through', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // Bot commands should be skipped
      const ctx1 = createTextCtx({ text: '/chatid' });
      await triggerTextMessage(ctx1);
      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();

      const ctx2 = createTextCtx({ text: '/ping' });
      await triggerTextMessage(ctx2);
      expect(opts.onMessage).not.toHaveBeenCalled();

      // Non-bot /commands should flow through
      const ctx3 = createTextCtx({ text: '/remote-control' });
      await triggerTextMessage(ctx3);
      expect(opts.onMessage).toHaveBeenCalledTimes(1);
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '/remote-control' }),
      );
    });

    it('extracts sender name from first_name', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi', firstName: 'Bob' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: 'Bob' }),
      );
    });

    it('falls back to username when first_name missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi' });
      ctx.from.first_name = undefined as any;
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: 'alice_user' }),
      );
    });

    it('falls back to user ID when name and username missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi', fromId: 42 });
      ctx.from.first_name = undefined as any;
      ctx.from.username = undefined as any;
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: '42' }),
      );
    });

    it('uses sender name as chat name for private chats', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:100200300': {
            name: 'Private',
            folder: 'private',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Hello',
        chatType: 'private',
        firstName: 'Alice',
      });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Alice', // Private chats use sender name
        'telegram',
        false,
      );
    });

    it('uses chat title as name for group chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Hello',
        chatType: 'supergroup',
        chatTitle: 'Project Team',
      });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Project Team',
        'telegram',
        true,
      );
    });

    it('converts message.date to ISO timestamp', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const unixTime = 1704067200; // 2024-01-01T00:00:00.000Z
      const ctx = createTextCtx({ text: 'Hello', date: unixTime });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.000Z',
        }),
      );
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('translates @bot_username mention to trigger format', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@andy_ai_bot what time is it?',
        entities: [{ type: 'mention', offset: 0, length: 12 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@Andy @andy_ai_bot what time is it?',
        }),
      );
    });

    it('does not translate if message already matches trigger', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@Andy @andy_ai_bot hello',
        entities: [{ type: 'mention', offset: 6, length: 12 }],
      });
      await triggerTextMessage(ctx);

      // Should NOT double-prepend — already starts with @Andy
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@Andy @andy_ai_bot hello',
        }),
      );
    });

    it('does not translate mentions of other bots', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@some_other_bot hi',
        entities: [{ type: 'mention', offset: 0, length: 15 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@some_other_bot hi', // No translation
        }),
      );
    });

    it('handles mention in middle of message', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'hey @andy_ai_bot check this',
        entities: [{ type: 'mention', offset: 4, length: 12 }],
      });
      await triggerTextMessage(ctx);

      // Bot is mentioned, message doesn't match trigger → prepend trigger
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@Andy hey @andy_ai_bot check this',
        }),
      );
    });

    it('handles message with no entities', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'plain message' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: 'plain message',
        }),
      );
    });

    it('ignores non-mention entities', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'check https://example.com',
        entities: [{ type: 'url', offset: 6, length: 19 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: 'check https://example.com',
        }),
      );
    });
  });

  // --- Non-text messages ---

  describe('non-text messages', () => {
    it('stores photo with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Photo]' }),
      );
    });

    it('stores photo with caption', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({ caption: 'Look at this' });
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Photo] Look at this' }),
      );
    });

    it('stores video with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:video', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Video]' }),
      );
    });

    it('stores voice message with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:voice', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Voice message]' }),
      );
    });

    it('stores audio with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:audio', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Audio]' }),
      );
    });

    it('stores document with filename', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: { document: { file_name: 'report.pdf' } },
      });
      await triggerMediaMessage('message:document', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Document: report.pdf]' }),
      );
    });

    it('stores document with fallback name when filename missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({ extra: { document: {} } });
      await triggerMediaMessage('message:document', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Document: file]' }),
      );
    });

    it('stores sticker with emoji', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: { sticker: { emoji: '😂' } },
      });
      await triggerMediaMessage('message:sticker', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Sticker 😂]' }),
      );
    });

    it('stores location with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:location', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Location]' }),
      );
    });

    it('stores contact with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:contact', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Contact]' }),
      );
    });

    it('ignores non-text messages from unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({ chatId: 999999 });
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via bot API', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:100200300', 'Hello');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        'Hello',
        { parse_mode: 'Markdown' },
      );
    });

    it('strips tg: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:-1001234567890', 'Group message');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '-1001234567890',
        'Group message',
        { parse_mode: 'Markdown' },
      );
    });

    it('splits messages exceeding 4096 characters', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const longText = 'x'.repeat(5000);
      await channel.sendMessage('tg:100200300', longText);

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(2);
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        1,
        '100200300',
        'x'.repeat(4096),
        { parse_mode: 'Markdown' },
      );
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        2,
        '100200300',
        'x'.repeat(904),
        { parse_mode: 'Markdown' },
      );
    });

    it('sends exactly one message at 4096 characters', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const exactText = 'y'.repeat(4096);
      await channel.sendMessage('tg:100200300', exactText);

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('handles send failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.sendMessage.mockRejectedValueOnce(
        new Error('Network error'),
      );

      // Should not throw
      await expect(
        channel.sendMessage('tg:100200300', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('does nothing when bot is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      // Don't connect — bot is null
      await channel.sendMessage('tg:100200300', 'No bot');

      // No error, no API call
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns tg: JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(true);
    });

    it('owns tg: JIDs with negative IDs (groups)', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('tg:-1001234567890')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own WhatsApp DM JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('sends typing action when isTyping is true', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.setTyping('tg:100200300', true);

      expect(currentBot().api.sendChatAction).toHaveBeenCalledWith(
        '100200300',
        'typing',
      );
    });

    it('does nothing when isTyping is false', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.setTyping('tg:100200300', false);

      expect(currentBot().api.sendChatAction).not.toHaveBeenCalled();
    });

    it('does nothing when bot is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      // Don't connect
      await channel.setTyping('tg:100200300', true);

      // No error, no API call
    });

    it('handles typing indicator failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.sendChatAction.mockRejectedValueOnce(
        new Error('Rate limited'),
      );

      await expect(
        channel.setTyping('tg:100200300', true),
      ).resolves.toBeUndefined();
    });
  });

  // --- Bot commands ---

  describe('bot commands', () => {
    it('/chatid replies with chat ID and metadata', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('chatid')!;
      const ctx = {
        chat: { id: 100200300, type: 'group' as const },
        from: { first_name: 'Alice' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('tg:100200300'),
        expect.objectContaining({ parse_mode: 'Markdown' }),
      );
    });

    it('/chatid shows chat type', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('chatid')!;
      const ctx = {
        chat: { id: 555, type: 'private' as const },
        from: { first_name: 'Bob' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('private'),
        expect.any(Object),
      );
    });

    it('/ping replies with bot status', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('ping')!;
      const ctx = { reply: vi.fn() };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Andy is online.');
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "telegram"', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.name).toBe('telegram');
    });
  });

  // --- Thread (forum topic) routing ---

  describe('thread routing', () => {
    function threadOpts(threadJid = 'tg:100200300:456') {
      return createTestOpts({
        registeredGroups: vi.fn(() => ({
          [threadJid]: {
            name: 'Support Thread',
            folder: 'support-thread',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
    }

    it('routes text message to thread JID when thread is registered', async () => {
      const opts = threadOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hello', threadId: 456 });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300:456',
        expect.objectContaining({ chat_jid: 'tg:100200300:456' }),
      );
    });

    it('falls back to base JID when thread is not registered', async () => {
      const opts = createTestOpts(); // only 'tg:100200300' registered, not the thread
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hello', threadId: 456 });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ chat_jid: 'tg:100200300' }),
      );
    });

    it('routes non-text message to thread JID when thread is registered', async () => {
      const opts = threadOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({ threadId: 456 });
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300:456',
        expect.objectContaining({
          chat_jid: 'tg:100200300:456',
          content: '[Photo]',
        }),
      );
    });

    it('uses topic name as chatName for thread-scoped messages', async () => {
      const opts = threadOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // Seed the topic name cache
      await triggerForumTopicCreated({
        chat: { id: 100200300 },
        message: {
          message_thread_id: 456,
          forum_topic_created: { name: 'Support' },
        },
      });

      const ctx = createTextCtx({ text: 'Help please', threadId: 456 });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300:456',
        expect.any(String),
        'Support',
        'telegram',
        true,
      );
    });

    it('falls back to parent chat title when topic name not cached', async () => {
      const opts = threadOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Hello',
        threadId: 456,
        chatTitle: 'My Group',
      });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300:456',
        expect.any(String),
        'My Group',
        'telegram',
        true,
      );
    });
  });

  // --- Topic name caching ---

  describe('topic name caching', () => {
    it('caches topic name on forum_topic_created', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:100200300:10': {
            name: 'Thread',
            folder: 'thread',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await triggerForumTopicCreated({
        chat: { id: 100200300 },
        message: {
          message_thread_id: 10,
          forum_topic_created: { name: 'Announcements' },
        },
      });

      // Verify the name is used in subsequent messages
      const ctx = createTextCtx({ text: 'Hi', threadId: 10 });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300:10',
        expect.any(String),
        'Announcements',
        'telegram',
        true,
      );
    });

    it('updates cached topic name on forum_topic_edited', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:100200300:10': {
            name: 'Thread',
            folder: 'thread',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await triggerForumTopicCreated({
        chat: { id: 100200300 },
        message: {
          message_thread_id: 10,
          forum_topic_created: { name: 'Old Name' },
        },
      });

      await triggerForumTopicEdited({
        chat: { id: 100200300 },
        message: {
          message_thread_id: 10,
          forum_topic_edited: { name: 'New Name' },
        },
      });

      const ctx = createTextCtx({ text: 'Hi', threadId: 10 });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300:10',
        expect.any(String),
        'New Name',
        'telegram',
        true,
      );
    });

    it('ignores forum_topic_edited when name field is absent', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:100200300:10': {
            name: 'Thread',
            folder: 'thread',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await triggerForumTopicCreated({
        chat: { id: 100200300 },
        message: {
          message_thread_id: 10,
          forum_topic_created: { name: 'Stable Name' },
        },
      });

      // forum_topic_edited without name (e.g. only icon changed)
      await triggerForumTopicEdited({
        chat: { id: 100200300 },
        message: {
          message_thread_id: 10,
          forum_topic_edited: { name: undefined },
        },
      });

      const ctx = createTextCtx({ text: 'Hi', threadId: 10 });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300:10',
        expect.any(String),
        'Stable Name', // unchanged
        'telegram',
        true,
      );
    });
  });

  // --- Thread-aware commands ---

  describe('/chatid in threads', () => {
    it('shows thread JID and base JID when called inside a thread', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('chatid')!;
      const ctx = {
        chat: { id: 100200300, type: 'supergroup' as const },
        from: { first_name: 'Alice' },
        message: { message_thread_id: 456 },
        reply: vi.fn(),
      };

      await handler(ctx);

      const reply: string = ctx.reply.mock.calls[0][0];
      expect(reply).toContain('tg:100200300:456');
      expect(reply).toContain('tg:100200300');
      expect(reply).toContain('register to isolate this thread');
    });

    it('includes cached topic name in thread line', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await triggerForumTopicCreated({
        chat: { id: 100200300 },
        message: {
          message_thread_id: 456,
          forum_topic_created: { name: 'Bug Reports' },
        },
      });

      const handler = currentBot().commandHandlers.get('chatid')!;
      const ctx = {
        chat: { id: 100200300, type: 'supergroup' as const },
        from: { first_name: 'Alice' },
        message: { message_thread_id: 456 },
        reply: vi.fn(),
      };

      await handler(ctx);

      const reply: string = ctx.reply.mock.calls[0][0];
      expect(reply).toContain('Bug Reports');
    });

    it('omits topic name when not cached', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('chatid')!;
      const ctx = {
        chat: { id: 100200300, type: 'supergroup' as const },
        from: { first_name: 'Alice' },
        message: { message_thread_id: 456 },
        reply: vi.fn(),
      };

      await handler(ctx);

      const reply: string = ctx.reply.mock.calls[0][0];
      // Thread JID present but no " — TopicName" suffix
      expect(reply).toMatch(/`tg:100200300:456`\s*_\(register/);
    });
  });

  describe('/ping in threads', () => {
    it('replies with message_thread_id when called inside a thread', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('ping')!;
      const ctx = {
        message: { message_thread_id: 456 },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Andy is online.', {
        message_thread_id: 456,
      });
    });

    it('replies without extra options outside a thread', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('ping')!;
      const ctx = { reply: vi.fn() };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Andy is online.');
    });
  });

  // --- Thread-aware sendMessage and setTyping ---

  describe('sendMessage with thread JID', () => {
    it('passes message_thread_id for thread-scoped JIDs', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:100200300:456', 'Thread reply');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        'Thread reply',
        { parse_mode: 'Markdown', message_thread_id: 456 },
      );
    });

    it('passes message_thread_id when splitting long messages', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const longText = 'x'.repeat(5000);
      await channel.sendMessage('tg:100200300:456', longText);

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(2);
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        1,
        '100200300',
        'x'.repeat(4096),
        { parse_mode: 'Markdown', message_thread_id: 456 },
      );
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        2,
        '100200300',
        'x'.repeat(904),
        { parse_mode: 'Markdown', message_thread_id: 456 },
      );
    });
  });

  describe('setTyping with thread JID', () => {
    it('passes message_thread_id for thread-scoped JIDs', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.setTyping('tg:100200300:456', true);

      expect(currentBot().api.sendChatAction).toHaveBeenCalledWith(
        '100200300',
        'typing',
        { message_thread_id: 456 },
      );
    });
  });
});
