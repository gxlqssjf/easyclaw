import { stripReasoningTagsFromText } from "@openclaw/reasoning-tags";

export type ChatImage = { data: string; mimeType: string };

export type ChatMessage = {
  role: "user" | "assistant" | "tool-event";
  text: string;
  timestamp: number;
  images?: ChatImage[];
  toolName?: string;
  /** Gateway-assigned idempotency key — present on user messages loaded from history. */
  idempotencyKey?: string;
  /** True for user messages from external channels (Telegram, Chrome, etc.), not typed in the panel. */
  isExternal?: boolean;
  /** Source channel for external messages (e.g. "telegram", "wechat"). */
  channel?: string;
};

export type PendingImage = { dataUrl: string; base64: string; mimeType: string };

/** Metadata for a session tab, sourced from gateway `sessions.list`. */
export type SessionTabInfo = {
  key: string;
  displayName?: string;
  derivedTitle?: string;
  channel?: string;
  updatedAt?: number;
  kind?: string;
  pinned?: boolean;
  /** True for panel-created sessions not yet materialized on the gateway. */
  isLocal?: boolean;
};

/** Per-session cached state for tab switching. */
export type SessionChatState = {
  messages: ChatMessage[];
  trackerSnapshot: import("../../lib/run-tracker.js").RunTrackerSnapshot | null;
  draft: string;
  pendingImages: PendingImage[];
  visibleCount: number;
  allFetched: boolean;
  lastAccessed: number;
};

/** Response from gateway `sessions.list` RPC. */
export type SessionsListResult = {
  ts: number;
  count: number;
  sessions: Array<{
    key: string;
    kind?: string;
    displayName?: string;
    derivedTitle?: string;
    lastMessagePreview?: string;
    channel?: string;
    lastChannel?: string;
    updatedAt?: number;
    spawnedBy?: string;
    totalTokens?: number;
    chatType?: string;
  }>;
};

export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
export const COMPRESS_MAX_DIMENSION = 1280; // resize longest side to this
export const COMPRESS_TARGET_BYTES = 300 * 1024; // target base64 size after compression
export const COMPRESS_INITIAL_QUALITY = 0.85;
export const COMPRESS_MIN_QUALITY = 0.4;

export const DEFAULT_SESSION_KEY = "agent:main:main";
export const INITIAL_VISIBLE = 50;
export const PAGE_SIZE = 20;
export const FETCH_BATCH = 200;

/** Static marker inserted by cleanMessageText for media attachments.
 *  Replaced with i18n text at render time. */
export const IMAGE_PLACEHOLDER = "\u200B[__IMAGE__]\u200B";

/**
 * Clean up raw gateway message text:
 * - Strip "Conversation info (untrusted metadata):" blocks
 * - Format audio transcript messages nicely
 */
export function cleanMessageText(text: string): string {
  // Remove "Conversation info (untrusted metadata):" and its JSON block
  let cleaned = text.replace(/Conversation info \(untrusted metadata\):\s*```json\s*\{[\s\S]*?\}\s*```\s*/g, "").trim();
  // Fallback: also strip the variant without code fences
  cleaned = cleaned.replace(/Conversation info \(untrusted metadata\):\s*\{[\s\S]*?\}\s*/g, "").trim();

  // Strip reasoning/thinking tags (<think>, <thinking>, <thought>, <antthinking>, <final>)
  // using OpenClaw's battle-tested implementation that respects code blocks
  cleaned = stripReasoningTagsFromText(cleaned, { mode: "preserve", trim: "start" });

  // Strip "NO_REPLY" directive — the agent outputs this after using the message tool
  // to indicate it already sent the reply via the outbound system.
  cleaned = cleaned.replace(/\bNO_REPLY\b/g, "").trim();

  // Strip agent framework tool-result summaries (e.g. "System: [2026-02-24 16:16:41 PST] Exec completed ...")
  cleaned = cleaned.replace(/^System: \[\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})? [A-Z]{2,5}\].*$/gm, "").trim();

  // Strip EasyClaw prependContext blocks (runtime env, policy, guards)
  // These are injected by plugins for the agent but not meant for the user.
  cleaned = cleaned.replace(/---\s+EasyClaw[\s\S]*?---\s+End\s+\w[\w\s]*---/g, "").trim();

  // Strip queue-collected message wrapper produced by OpenClaw's drain.ts
  // when messages arrive while the agent is busy processing another run.
  // Format: "[Queued messages while agent was busy]\n\n---\nQueued #1\n\n<actual message>"
  cleaned = cleaned.replace(/^\[Queued messages while agent was busy\]\s*/, "");
  cleaned = cleaned.replace(/---\s*Queued #\d+\s*/g, "").trim();

  // Strip channel envelope prefix — rendered separately above the bubble.
  // Matches both bare timestamps like [Thu 2026-03-05 23:26 PST]
  // and full envelopes like [Mobile UUID +1s Thu 2026-03-05 23:26 PST].
  cleaned = cleaned.replace(/^\[[^\]]*\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})? [A-Z]{2,5}\]\s*/, "");

  // Strip gateway [System Message] blocks (cron delivery, system events).
  // The entire message is internal scaffolding — the agent's response follows separately.
  // Must come AFTER timestamp stripping, as gateway may prepend an inline timestamp.
  cleaned = cleaned.replace(/^\[System Message\][\s\S]*$/, "").trim();

  // Strip Feishu/Lark sender open_id prefix (e.g. "ou_04119179e9551e91a9f8af9a09de50e8: Hi")
  // The gateway prepends `{senderName ?? senderOpenId}: ` to messages; when the
  // display name isn't resolved, the raw ou_xxx id leaks into the chat bubble.
  cleaned = cleaned.replace(/^ou_[a-f0-9]+:\s*/, "");

  // Replace [media attached: <path> (<mime>) | <path>] blocks.
  // Audio attachments are stripped silently (the transcript or [Voice Ns] label is enough).
  // Non-audio attachments get an image placeholder since the panel can't display file paths.
  cleaned = cleaned.replace(/\[media attached:\s*[^\]]+\]/g, (match) =>
    /\(audio\//.test(match) ? "" : IMAGE_PLACEHOLDER,
  ).trim();

  // Strip agent instruction about sending images back (injected by gateway for media messages)
  cleaned = cleaned.replace(/To send an image back,[\s\S]*?Keep caption in the text body\.\s*/g, "").trim();

  // Strip raw channel-specific image metadata (e.g. Feishu image_key JSON)
  cleaned = cleaned.replace(/\{"image_key"\s*:\s*"[^"]*"\}/g, "").trim();

  // Strip cron/heartbeat system event wrapper — extract only the reminder content.
  // Variants: "has been triggered" (with content) / "was triggered" (no-content fallback)
  // Endings:  "Please relay…" (deliverToUser) / "Handle this…" (!deliverToUser)
  const cronMatch = cleaned.match(/^A scheduled (?:reminder|cron event) (?:has been|was) triggered\.\s*(?:The reminder content is:\s*\n\n([\s\S]*?)\n\n(?:Please relay|Handle this)|.*$)/);
  if (cronMatch) {
    cleaned = (cronMatch[1] ?? "").trim();
  }
  // Strip exec completion event wrapper
  cleaned = cleaned.replace(/^An async command you ran earlier has completed\.\s*The result is shown in the system messages above\.\s*(?:Please relay|Handle)[\s\S]*$/, "").trim();
  // Strip trailing "Current time: ..." line appended by heartbeat runner
  cleaned = cleaned.replace(/\nCurrent time: .+$/, "").trim();

  // Detect audio transcript pattern from media-understanding module.
  // Formats vary by channel:
  //   Telegram: [Audio] User text: [Telegram ...] <media:audio>\nTranscript: text
  //   Mobile:   [Audio]\nUser text:\n[Mobile ...] [Voice 3s]\nTranscript:\ntext
  // Generalized: [Audio] ... Transcript: <actual text>
  const audioMatch = cleaned.match(/\[Audio\][\s\S]*?Transcript:\s*([\s\S]*)/);
  if (audioMatch) {
    cleaned = `🔊 ${audioMatch[1].trim()}`;
  }

  return cleaned;
}

export function formatTimestamp(ts: number, locale: string): string {
  const d = new Date(ts);
  if (locale.startsWith("zh")) {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Extract plain text from gateway message content blocks.
 */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: { type?: string }) => b.type === "text")
    .map((b: { text?: string }) => b.text ?? "")
    .join("");
}

export function extractImages(content: unknown): ChatImage[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b: { type?: string }) => b.type === "image")
    .map((b: { data?: string; mimeType?: string }) => ({
      data: b.data ?? "",
      mimeType: b.mimeType ?? "image/jpeg",
    }))
    .filter((img) => img.data);
}

/**
 * Detect heartbeat/cron system-event user messages injected by the gateway.
 * These are NOT typed by the user — they're system-generated prompts for the agent.
 */
const CRON_EVENT_RE = /^A scheduled (?:reminder|cron event) (?:has been|was) triggered/;
const EXEC_EVENT_RE = /^An async command you ran earlier has completed/;
const HEARTBEAT_PROMPT_RE = /^(?:Current time:|HEARTBEAT_OK$)/;
const SYSTEM_MSG_RE = /^\[System Message\]/;
export function isSystemEventMessage(text: string): boolean {
  // Strip optional inline timestamp prefix before matching.
  const trimmed = text.trim().replace(/^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})? [A-Z]{2,5}\]\s*/, "");
  return CRON_EVENT_RE.test(trimmed) || EXEC_EVENT_RE.test(trimmed) || HEARTBEAT_PROMPT_RE.test(trimmed) || SYSTEM_MSG_RE.test(trimmed);
}

export const NO_PROVIDER_RE = /no\s+(llm\s+)?provider|no\s+api\s*key|provider\s+not\s+configured|key\s+not\s+(found|configured)/i;

/**
 * Map OpenClaw English error messages to i18n keys.
 * Pattern order matters — first match wins.
 */
const ERROR_I18N_MAP: Array<{ pattern: RegExp; key: string }> = [
  { pattern: NO_PROVIDER_RE, key: "chat.noProviderError" },
  { pattern: /temporarily overloaded|rate.?limit/i, key: "chat.errorRateLimit" },
  { pattern: /billing error|run out of credits|insufficient balance/i, key: "chat.errorBilling" },
  { pattern: /timed?\s*out/i, key: "chat.errorTimeout" },
  { pattern: /context overflow|prompt too large|context length exceeded/i, key: "chat.errorContextOverflow" },
  { pattern: /unauthorized|invalid.*(?:key|token)|authentication/i, key: "chat.errorAuth" },
];

export function localizeError(raw: string, t: (key: string) => string): string {
  for (const { pattern, key } of ERROR_I18N_MAP) {
    if (pattern.test(raw)) return t(key);
  }
  return raw;
}

/**
 * Content block types that represent tool calls across different API formats:
 * - tool_use / tooluse: Anthropic format
 * - tool_call / toolcall: generic format
 * - function_call / functioncall: OpenAI Responses format
 * - toolCall / toolUse / functionCall: camelCase variants used by Pi agent
 * Normalized to lowercase for matching.
 */
const TOOL_CALL_BLOCK_TYPES = new Set([
  "tool_use", "tooluse", "tool_call", "toolcall", "function_call", "functioncall",
]);

function isToolCallBlock(block: Record<string, unknown>): boolean {
  const raw = block.type;
  if (typeof raw !== "string") return false;
  return TOOL_CALL_BLOCK_TYPES.has(raw.trim().toLowerCase());
}

/**
 * Parse raw gateway messages into ChatMessage[].
 * Always extracts tool call blocks as inline "tool-event" entries;
 * visibility is controlled at render time via the preserveToolEvents setting.
 */
export function parseRawMessages(
  raw?: Array<{ role?: string; content?: unknown; timestamp?: number; idempotencyKey?: string }>,
): ChatMessage[] {
  if (!raw) return [];
  const parsed: ChatMessage[] = [];
  for (const msg of raw) {
    if (msg.role === "user" || msg.role === "assistant") {
      // Extract text + images first, then tool call names.
      // Text is generated BEFORE tool calls in the LLM turn,
      // so the text bubble should appear above tool-event markers.
      const text = extractText(msg.content);
      const images = extractImages(msg.content);
      if (text.trim() || images.length > 0) {
        const entry: ChatMessage = { role: msg.role, text, timestamp: msg.timestamp ?? 0, images: images.length > 0 ? images : undefined };
        if (msg.idempotencyKey) entry.idempotencyKey = msg.idempotencyKey;
        // Mark system-generated user messages (cron events, heartbeat prompts)
        // as external so they render on the left/agent side.
        if (msg.role === "user" && isSystemEventMessage(text)) {
          entry.isExternal = true;
          entry.channel = "cron";
        }
        parsed.push(entry);
      }
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          const b = block as Record<string, unknown>;
          if (isToolCallBlock(b) && typeof b.name === "string") {
            parsed.push({ role: "tool-event", text: b.name, toolName: b.name, timestamp: msg.timestamp ?? 0 });
          }
        }
      }
    }
  }
  return parsed;
}
