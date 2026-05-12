// Discord bridge for the Ollama Agent Harness.
//
// Connects a Discord bot to the existing /api/chat SSE endpoint so you
// can talk to the harness from any Discord channel. The bot forwards
// messages to the harness server, streams the response, and sends it
// back to Discord.
//
// Setup:
//   1. Go to https://discord.com/developers/applications
//   2. Create a new application → Bot → copy the bot token
//   3. Enable Message Content Intent under Privileged Gateway Intents
//   4. Invite the bot to your server with the OAuth2 URL generator
//      (scopes: bot; permissions: Send Messages, Read Message History)
//   5. Set the token in Harness Settings → Discord Bot Token
//      (or set HARNESS_DISCORD_BOT_TOKEN env var)
//
// The bridge starts automatically when the server boots if a token is configured.

import { logger } from '../core/logger';

const MAX_DISCORD_MESSAGE_LENGTH = 2000;

interface DiscordBotHandle {
  stop: () => void;
  isRunning: () => boolean;
}

let activeBot: DiscordBotHandle | null = null;

/**
 * Start the Discord bot and bridge messages to the harness chat API.
 */
export function startDiscordBot(
  token: string,
  harnessBaseUrl: string,
  allowedChannelIds?: string[],
): DiscordBotHandle | null {
  if (activeBot?.isRunning()) {
    logger.info('Discord', 'Bot already running, skipping start');
    return activeBot;
  }

  let running = false;
  let stopped = false;
  let client: import('discord.js').Client | null = null;

  const handle: DiscordBotHandle = {
    stop: () => {
      stopped = true;
      running = false;
      client?.destroy();
      client = null;
      logger.info('Discord', 'Bot stopped');
    },
    isRunning: () => running,
  };

  // Dynamic import so discord.js is optional
  import('discord.js').then(async (discord) => {
    if (stopped) return;
    const { Client, GatewayIntentBits, Partials } = discord;

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });

    client.on('ready', () => {
      if (stopped) return;
      running = true;
      logger.info('Discord', `Bot logged in as ${client?.user?.tag ?? 'unknown'}`);
    });

    client.on('messageCreate', async (message) => {
      // Ignore own messages and other bots
      if (message.author.bot) return;

      // Channel filter
      if (allowedChannelIds && allowedChannelIds.length > 0) {
        if (!allowedChannelIds.includes(message.channelId)) return;
      }

      const userMessage = message.content.trim();
      if (!userMessage) return;

      try {
        // Show typing indicator
        await message.channel.sendTyping();

        // Forward to harness chat API
        const response = await fetch(`${harnessBaseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: userMessage,
            history: [],
          }),
        });

        if (!response.ok || !response.body) {
          await message.reply(`Error: ${response.status} ${response.statusText}`);
          return;
        }

        // Parse SSE stream and collect the assistant response
        const text = await response.text();
        const assistantReply = extractAssistantReply(text);

        if (!assistantReply) {
          await message.reply('(no response from model)');
          return;
        }

        // Split long messages to fit Discord's limit
        const chunks = splitMessage(assistantReply, MAX_DISCORD_MESSAGE_LENGTH);
        for (const chunk of chunks) {
          await message.reply(chunk);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn('Discord', 'Failed to process message', { error: msg });
        await message.reply(`Error: ${msg}`).catch(() => {});
      }
    });

    if (!stopped) await client.login(token);
  }).catch((error) => {
    if (stopped) return;
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn('Discord', `Failed to start bot: ${msg}`);
  });

  activeBot = handle;
  return handle;
}

/**
 * Stop the Discord bot if running.
 */
export function stopDiscordBot(): void {
  activeBot?.stop();
  activeBot = null;
}

/**
 * Check if the Discord bot is currently running.
 */
export function isDiscordBotRunning(): boolean {
  return activeBot?.isRunning() ?? false;
}

/**
 * Extract the assistant's final text reply from an SSE chat response.
 */
function extractAssistantReply(sseText: string): string {
  let reply = '';
  for (const line of sseText.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6);
    if (data === '[DONE]') break;
    try {
      const parsed = JSON.parse(data);
      if (parsed.type === 'content' && typeof parsed.content === 'string') {
        reply += parsed.content;
      } else if (parsed.type === 'done' && typeof parsed.fullResponse === 'string') {
        return parsed.fullResponse;
      }
    } catch {
      // Skip unparseable lines
    }
  }
  return reply;
}

/**
 * Split a message into chunks that fit Discord's character limit.
 */
function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    // Try to break at a newline
    let breakAt = remaining.lastIndexOf('\n', maxLength);
    if (breakAt < maxLength * 0.5) breakAt = maxLength;
    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt);
  }
  return chunks;
}
