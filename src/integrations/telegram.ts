// Telegram bridge for the Ollama Agent Harness.
//
// Connects a Telegram bot to the existing /api/chat SSE endpoint so you
// can talk to Oracle from your phone. The bot forwards messages to the
// harness server, streams the response, and sends it back to Telegram.
//
// Setup:
//   1. Talk to @BotFather on Telegram and create a bot → copy the token
//   2. Set the token in Harness Settings → Telegram Bot Token
//      (or set HARNESS_TELEGRAM_BOT_TOKEN env var)
//   3. Optionally restrict to your chat ID with HARNESS_TELEGRAM_ALLOWED_CHAT_IDS
//
// The bridge starts automatically when the server boots if a token is configured.

import TelegramBot from 'node-telegram-bot-api';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../core/logger';

const MAX_TELEGRAM_MESSAGE_LENGTH = 4096;

let activeBotInstance: TelegramBot | null = null;
let activeBotToken = '';
let activeServerUrl = '';
/** Chat IDs that have sent at least one message — used for broadcast notifications. */
const knownChatIds = new Set<string>();

export function startTelegramBot(token: string, serverUrl: string, allowedChatIds?: string[]): TelegramBot | null {
  const trimmedToken = token.trim();
  if (!trimmedToken) return null;

  // Don't restart if already running with the same token.
  if (activeBotInstance && activeBotToken === trimmedToken) return activeBotInstance;

  // Stop previous instance if token changed.
  stopTelegramBot();

  const allowedIds = new Set(
    (allowedChatIds ?? (process.env.HARNESS_TELEGRAM_ALLOWED_CHAT_IDS ?? '').split(','))
      .map((id) => id.trim())
      .filter(Boolean),
  );

  try {
    const bot = new TelegramBot(trimmedToken, { polling: true });
    activeBotInstance = bot;
    activeBotToken = trimmedToken;
    activeServerUrl = serverUrl;

    bot.on('message', async (msg) => {
      const chatId = String(msg.chat.id);

      // Security: restrict to allowed chat IDs if configured.
      if (allowedIds.size > 0 && !allowedIds.has(chatId)) {
        logger.warn('Telegram', 'Rejected message from unauthorized chat', { chatId });
        return;
      }

      // Track chat ID for notifications (persisted across restarts).
      trackChatId(chatId, process.cwd());

      // Handle photo messages — download, upload to harness, then send to chat.
      if (msg.photo && msg.photo.length > 0) {
        await handlePhotoMessage(bot, msg, chatId, serverUrl);
        return;
      }

      // Handle document messages — download, upload to harness, then send to chat.
      if (msg.document) {
        await handleDocumentMessage(bot, msg, chatId, serverUrl);
        return;
      }

      // Handle voice/audio messages — download, upload, transcribe.
      if (msg.voice || msg.audio) {
        await handleVoiceMessage(bot, msg, chatId, serverUrl);
        return;
      }

      const text = msg.text?.trim();
      if (!text) return;

      // Handle /start command.
      if (text === '/start') {
        await bot.sendMessage(chatId, '🤖 *Oracle is ready.* Send me any message and I\'ll process it through the harness.\n\nYour chat ID: `' + chatId + '`\n\n*Commands:*\n/task _description_ — add an autonomy task\n/schedule every 6h _prompt_ — create a recurring job\n/status — check server readiness\n\n*Media:*\n📷 Send a photo — Oracle will analyze it\n📎 Send a file — Oracle will read and process it\n🎤 Send a voice note — Oracle will transcribe and respond\n\n*Email:* Just say "send me an email reminder about X at 9am" and Oracle will use email\\_send if SMTP is configured.', { parse_mode: 'Markdown' });
        return;
      }

      // Handle /status command.
      if (text === '/status') {
        try {
          const res = await fetch(`${serverUrl}/api/readiness`);
          const data = await res.json() as { model?: string; permissionMode?: string; sections?: Array<{ id: string; score: number; status: string }> };
          const sections = (data.sections ?? []).map((s) => `${s.status === 'ready' ? '✅' : s.status === 'warn' ? '⚠️' : '❌'} ${s.id}: ${s.score}%`).join('\n');
          await bot.sendMessage(chatId, `🤖 *Oracle Status*\nModel: ${data.model ?? 'none'}\nMode: ${data.permissionMode ?? 'default'}\n\n${sections}`, { parse_mode: 'Markdown' });
        } catch (err) {
          await bot.sendMessage(chatId, '❌ Could not reach the harness server.');
        }
        return;
      }

      // Handle /task command.
      if (text.startsWith('/task ')) {
        const taskText = text.slice(6).trim();
        if (!taskText) { await bot.sendMessage(chatId, 'Usage: /task _description_'); return; }
        try {
          const res = await fetch(`${serverUrl}/api/autonomy/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: taskText, description: taskText }),
          });
          const data = await res.json() as { ok?: boolean; id?: string; pending?: number; error?: string };
          if (data.ok) {
            await bot.sendMessage(chatId, `✅ Task added: *${taskText}*\nID: \`${data.id}\` · ${data.pending} pending`, { parse_mode: 'Markdown' });
          } else {
            await bot.sendMessage(chatId, `❌ ${data.error || 'Failed to add task'}`);
          }
        } catch {
          await bot.sendMessage(chatId, '❌ Could not reach the harness server.');
        }
        return;
      }

      // Handle /schedule command — create an automation job.
      if (text.startsWith('/schedule ')) {
        const scheduleText = text.slice(10).trim();
        if (!scheduleText) { await bot.sendMessage(chatId, 'Usage: /schedule every 6h Check hotel prices'); return; }
        try {
          const intervalMatch = scheduleText.match(/^every\s+(\d+)\s*(h|hr|hrs|hours?|m|min|mins|minutes?)\s+/i);
          let minutes = 1440;
          let prompt = scheduleText;
          let intervalLabel = 'every 24 hours';
          if (intervalMatch) {
            const value = parseInt(intervalMatch[1], 10);
            const unit = intervalMatch[2].charAt(0).toLowerCase();
            minutes = unit === 'h' ? value * 60 : value;
            minutes = Math.max(1, minutes);
            intervalLabel = unit === 'h' ? `every ${value} hour(s)` : `every ${value} minute(s)`;
            prompt = scheduleText.slice(intervalMatch[0].length).trim();
          }
          const name = prompt.slice(0, 50).replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'Telegram job';
          const res = await fetch(`${serverUrl}/api/automations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, prompt, schedule: `${minutes} minutes` }),
          });
          const data = await res.json() as { error?: string };
          if (data.error) throw new Error(data.error);
          await bot.sendMessage(chatId, `✅ Scheduled: *${name}*\nInterval: ${intervalLabel}\n\nThe job runs automatically while the server is up.`, { parse_mode: 'Markdown' });
        } catch (err) {
          await bot.sendMessage(chatId, '❌ ' + (err instanceof Error ? err.message : String(err)));
        }
        return;
      }

      // Forward to chat API as SSE and collect the response.
      logger.info('Telegram', 'Message received', { chatId, length: text.length });
      await bot.sendChatAction(chatId, 'typing');

      try {
        await relayChatAndRespond(bot, chatId, text, serverUrl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('Telegram', 'Chat relay failed', { chatId, error: msg });
        await bot.sendMessage(chatId, '❌ Error: ' + msg.slice(0, 200));
      }
    });

    bot.on('polling_error', (err) => {
      logger.warn('Telegram', 'Polling error', { error: err.message });
    });

    logger.info('Telegram', 'Bot started', { allowedChatIds: allowedIds.size || 'any' });
    return bot;
  } catch (err) {
    logger.warn('Telegram', 'Failed to start bot', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// ─── Photo handling ─────────────────────────────────────────────────

async function handlePhotoMessage(bot: TelegramBot, msg: TelegramBot.Message, chatId: string, serverUrl: string): Promise<void> {
  try {
    await bot.sendChatAction(chatId, 'typing');
    // Get the highest resolution photo.
    const photo = msg.photo![msg.photo!.length - 1];
    const fileLink = await bot.getFileLink(photo.file_id);
    const caption = msg.caption?.trim() || 'Analyze this image in detail.';

    // Download the image.
    const imageRes = await fetch(fileLink);
    if (!imageRes.ok) throw new Error('Failed to download image from Telegram');
    const imageBuffer = Buffer.from(await imageRes.arrayBuffer());
    const ext = fileLink.includes('.jpg') || fileLink.includes('.jpeg') ? 'jpg' : 'png';
    const filename = `telegram-photo-${Date.now()}.${ext}`;

    // Upload to harness.
    const uploadRes = await fetch(`${serverUrl}/api/upload`, {
      method: 'POST',
      headers: { 'Content-Type': `image/${ext === 'jpg' ? 'jpeg' : 'png'}`, 'x-filename': filename },
      body: imageBuffer,
    });
    const uploadData = await uploadRes.json() as { path?: string; error?: string };
    if (uploadData.error || !uploadData.path) {
      await bot.sendMessage(chatId, '❌ Failed to upload image: ' + (uploadData.error || 'unknown error'));
      return;
    }

    // Send chat message with attachment reference.
    const message = `${caption}\n\n[Attached files]\n- image: name="${filename}" path="${uploadData.path}"\n\nIMPORTANT: Use image_analyze with the path "${uploadData.path}" to analyze this image.`;
    await relayChatAndRespond(bot, chatId, message, serverUrl);

    logger.info('Telegram', 'Photo processed', { chatId, filename });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn('Telegram', 'Photo handling failed', { chatId, error: errMsg });
    await bot.sendMessage(chatId, '❌ Could not process the photo: ' + errMsg.slice(0, 200));
  }
}

// ─── Document handling ──────────────────────────────────────────────

async function handleDocumentMessage(bot: TelegramBot, msg: TelegramBot.Message, chatId: string, serverUrl: string): Promise<void> {
  try {
    await bot.sendChatAction(chatId, 'typing');
    const doc = msg.document!;
    const fileLink = await bot.getFileLink(doc.file_id);
    const filename = doc.file_name || `telegram-file-${Date.now()}`;
    const caption = msg.caption?.trim() || `Analyze this file: ${filename}`;
    const mimeType = doc.mime_type || 'application/octet-stream';

    // Download the file.
    const fileRes = await fetch(fileLink);
    if (!fileRes.ok) throw new Error('Failed to download file from Telegram');
    const fileBuffer = Buffer.from(await fileRes.arrayBuffer());

    // Upload to harness.
    const uploadRes = await fetch(`${serverUrl}/api/upload`, {
      method: 'POST',
      headers: { 'Content-Type': mimeType, 'x-filename': filename },
      body: fileBuffer,
    });
    const uploadData = await uploadRes.json() as { path?: string; error?: string };
    if (uploadData.error || !uploadData.path) {
      await bot.sendMessage(chatId, '❌ Failed to upload file: ' + (uploadData.error || 'unknown error'));
      return;
    }

    // Determine the right tool based on file type.
    const isPdf = filename.toLowerCase().endsWith('.pdf');
    const isImage = /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(filename);
    const isAudio = /\.(mp3|wav|m4a|ogg|flac)$/i.test(filename);
    const toolHint = isPdf ? 'pdf_read' : isImage ? 'image_analyze' : isAudio ? 'audio_transcribe' : 'file_read';
    const mediaKind = isPdf ? 'pdf' : isImage ? 'image' : isAudio ? 'audio' : 'data';

    const message = `${caption}\n\n[Attached files]\n- ${mediaKind}: name="${filename}" path="${uploadData.path}"\n\nIMPORTANT: Use ${toolHint} with the path "${uploadData.path}" to process this file.`;
    await relayChatAndRespond(bot, chatId, message, serverUrl);

    logger.info('Telegram', 'Document processed', { chatId, filename, mimeType });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn('Telegram', 'Document handling failed', { chatId, error: errMsg });
    await bot.sendMessage(chatId, '❌ Could not process the file: ' + errMsg.slice(0, 200));
  }
}

// ─── Voice/audio handling ───────────────────────────────────────────

async function handleVoiceMessage(bot: TelegramBot, msg: TelegramBot.Message, chatId: string, serverUrl: string): Promise<void> {
  try {
    await bot.sendChatAction(chatId, 'typing');
    const voice = msg.voice ?? msg.audio;
    if (!voice) return;
    const fileLink = await bot.getFileLink(voice.file_id);
    const caption = msg.caption?.trim() || 'Transcribe this audio and respond to what was said.';

    // Download the audio file.
    const audioRes = await fetch(fileLink);
    if (!audioRes.ok) throw new Error('Failed to download audio from Telegram');
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
    const ext = msg.voice ? 'ogg' : (fileLink.split('.').pop() ?? 'mp3');
    const filename = `telegram-voice-${Date.now()}.${ext}`;
    const mimeType = msg.voice ? 'audio/ogg' : (msg.audio?.mime_type ?? 'audio/mpeg');

    // Upload to harness.
    const uploadRes = await fetch(`${serverUrl}/api/upload`, {
      method: 'POST',
      headers: { 'Content-Type': mimeType, 'x-filename': filename },
      body: audioBuffer,
    });
    const uploadData = await uploadRes.json() as { path?: string; error?: string };
    if (uploadData.error || !uploadData.path) {
      await bot.sendMessage(chatId, '❌ Failed to upload audio: ' + (uploadData.error || 'unknown error'));
      return;
    }

    const message = `${caption}\n\n[Attached files]\n- audio: name="${filename}" path="${uploadData.path}"\n\nIMPORTANT: Use audio_transcribe with the path "${uploadData.path}" to transcribe this audio, then respond to the content.`;
    await relayChatWithProgress(bot, chatId, message, serverUrl);

    logger.info('Telegram', 'Voice processed', { chatId, filename });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn('Telegram', 'Voice handling failed', { chatId, error: errMsg });
    await bot.sendMessage(chatId, '❌ Could not process the voice message: ' + errMsg.slice(0, 200));
  }
}

// ─── Shared chat relay ──────────────────────────────────────────────

async function relayChatAndRespond(bot: TelegramBot, chatId: string, message: string, serverUrl: string): Promise<void> {
  return relayChatWithProgress(bot, chatId, message, serverUrl);
}

/**
 * Relay a message to the chat API and show inline progress by editing
 * a placeholder message as tool calls happen during streaming.
 */
async function relayChatWithProgress(bot: TelegramBot, chatId: string, message: string, serverUrl: string): Promise<void> {
  const response = await fetch(`${serverUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });

  if (!response.ok || !response.body) {
    await bot.sendMessage(chatId, '❌ Harness returned an error.');
    return;
  }

  // Send a placeholder message that we'll edit with progress.
  const progressMsg = await bot.sendMessage(chatId, '⏳ Processing...');
  const progressMsgId = progressMsg.message_id;
  let lastProgressUpdate = 0;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let assistantText = '';
  let toolCalls = 0;
  const toolNames: string[] = [];
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') continue;
      try {
        const event = JSON.parse(payload) as { type: string; content?: string; call?: { name?: string } };
        if (event.type === 'text' && event.content) assistantText += event.content;
        if (event.type === 'tool_call' && event.call?.name) {
          toolCalls++;
          if (!toolNames.includes(event.call.name)) toolNames.push(event.call.name);
        }
      } catch { /* skip */ }
    }

    // Update progress message every 2 seconds.
    const now = Date.now();
    if (now - lastProgressUpdate > 2000 && toolCalls > 0) {
      lastProgressUpdate = now;
      const progressText = `⏳ Working... (${toolCalls} tool call${toolCalls > 1 ? 's' : ''}: ${toolNames.slice(-3).join(', ')})`;
      await bot.editMessageText(progressText, { chat_id: chatId, message_id: progressMsgId }).catch(() => {});
    }
  }

  // Delete the progress message.
  await bot.deleteMessage(chatId, progressMsgId).catch(() => {});

  if (!assistantText.trim()) {
    assistantText = toolCalls > 0
      ? `✅ Used ${toolCalls} tool call(s): ${toolNames.join(', ')}\n\n(No text response from the model.)`
      : '(No response from the model.)';
  }

  const chunks = splitMessage(assistantText);
  for (const chunk of chunks) {
    try {
      await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
    } catch {
      await bot.sendMessage(chatId, chunk);
    }
  }
}

// ─── Notifications ──────────────────────────────────────────────────

/**
 * Send a notification to all known Telegram chat IDs.
 * Used by the automation scheduler and autonomy runner.
 */
export async function sendTelegramNotification(title: string, body: string): Promise<number> {
  if (!activeBotInstance || knownChatIds.size === 0) return 0;
  let sent = 0;
  const text = `🔔 *${title}*\n\n${body}`;
  for (const chatId of knownChatIds) {
    try {
      await activeBotInstance.sendMessage(chatId, text, { parse_mode: 'Markdown' });
      sent++;
    } catch (err) {
      logger.warn('Telegram', 'Notification delivery failed', { chatId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return sent;
}

export function getKnownTelegramChatIds(): string[] {
  return Array.from(knownChatIds);
}

const CHAT_IDS_FILENAME = '.harness/telegram-chat-ids.json';

async function persistChatIds(projectDir: string): Promise<void> {
  try {
    const filePath = path.join(projectDir, CHAT_IDS_FILENAME);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(Array.from(knownChatIds)), 'utf-8');
  } catch { /* best effort */ }
}

export async function loadPersistedChatIds(projectDir: string): Promise<void> {
  try {
    const raw = await fs.readFile(path.join(projectDir, CHAT_IDS_FILENAME), 'utf-8');
    const ids = JSON.parse(raw) as string[];
    for (const id of ids) if (id) knownChatIds.add(String(id));
  } catch { /* missing file is fine */ }
}

/**
 * Register a chat ID and persist to disk. Called when a message is received.
 */
function trackChatId(chatId: string, projectDir: string): void {
  if (knownChatIds.has(chatId)) return;
  knownChatIds.add(chatId);
  persistChatIds(projectDir).catch(() => {});
}

export function stopTelegramBot(): void {
  if (activeBotInstance) {
    activeBotInstance.stopPolling();
    activeBotInstance = null;
    activeBotToken = '';
    logger.info('Telegram', 'Bot stopped');
  }
}

export function isTelegramBotRunning(): boolean {
  return activeBotInstance !== null;
}

function splitMessage(text: string): string[] {
  if (text.length <= MAX_TELEGRAM_MESSAGE_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_TELEGRAM_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a paragraph or line break.
    let splitIdx = remaining.lastIndexOf('\n\n', MAX_TELEGRAM_MESSAGE_LENGTH);
    if (splitIdx < MAX_TELEGRAM_MESSAGE_LENGTH / 2) splitIdx = remaining.lastIndexOf('\n', MAX_TELEGRAM_MESSAGE_LENGTH);
    if (splitIdx < MAX_TELEGRAM_MESSAGE_LENGTH / 2) splitIdx = MAX_TELEGRAM_MESSAGE_LENGTH;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }
  return chunks;
}
