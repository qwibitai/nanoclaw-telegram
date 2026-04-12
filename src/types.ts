export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  thread_id?: string;
  reply_to_message_id?: string;
  reply_to_message_content?: string;
  reply_to_sender_name?: string;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  script?: string | null;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

/**
 * A single button in an inline keyboard row.
 * Either `data` (callback) or `url` must be set.
 *
 * Bot API 9.4 (February 2026): `style` sets native button color in Telegram UI.
 * Always include an emoji prefix in `text` as well — it works on older clients.
 */
export interface InlineButton {
  /** Displayed label — always include an emoji prefix for visual meaning */
  text: string;
  /** Callback data (≤ 64 bytes). Delivered as `[Callback: <data>] on message <id>`. */
  data?: string;
  /** URL to open when button is tapped (alternative to callback). */
  url?: string;
  /**
   * Bot API 9.4 — native button color in Telegram.
   * "success" = green (confirm/yes/create)
   * "danger"  = red   (cancel/delete/no)
   * "primary" = blue  (main action, neutral primary choice)
   * Omit for default grey (secondary/skip/info buttons).
   */
  style?: 'success' | 'danger' | 'primary';
  /**
   * Bot API 9.4 — custom emoji icon shown before button text.
   * Use the emoji's custom_emoji_id from Telegram sticker set.
   * Optional enhancement; not required.
   */
  icon_custom_emoji_id?: string;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
  // Optional: send an emoji reaction to a specific message. Used by the
  // `react_to_message` MCP tool so the agent can signal status or command
  // acknowledgments without a full text reply. See the telegram-reactions
  // skill doc in the relevant group for usage semantics.
  reactToMessage?(jid: string, messageId: string, emoji: string): Promise<void>;
  // Optional: send a message with an inline keyboard. Callback presses are
  // delivered as synthetic `[Callback: <data>] on message <id>` messages.
  // See the inline-buttons skill doc for usage semantics and emoji color guide.
  sendMessageWithButtons?(
    jid: string,
    text: string,
    buttons: InlineButton[][],
  ): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
