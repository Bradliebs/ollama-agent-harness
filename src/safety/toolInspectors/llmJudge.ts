import type { IChatClient } from '../../core/chatClient';
import type { Message } from 'ollama';
import type { AdversaryJudge } from './adversaryInspector';

/**
 * Build an LLM-backed AdversaryJudge from an existing chat client.
 *
 * Kept in this folder (not in queryLoop) so callers can wire a different
 * client (e.g. a stronger safety model) than the one driving the loop.
 * Module is provider-free — it only depends on the `IChatClient` interface.
 *
 * Output contract: judge resolves with `{ block, reason }`. Anything that
 * isn't a clear BLOCK is treated as ALLOW — the inspector already only
 * runs when `adversary.md` exists, so an over-cautious model would flood
 * the user with approvals. If the chat call throws, the dispatcher's
 * inspector chain catches it and fails open (matches goose CLI).
 */
export function createLlmAdversaryJudge(client: IChatClient): AdversaryJudge {
  return async ({ command, rules, toolName }) => {
    const messages: Message[] = [
      {
        role: 'system',
        content:
          'You are a safety judge. Respond with the single word BLOCK or ALLOW followed by a short reason on the same line. No other output.',
      },
      {
        role: 'user',
        content:
          `Rules:\n---\n${rules}\n---\n` +
          `A '${toolName}' tool wants to run this command:\n---\n${command}\n---\n` +
          `Reply BLOCK <reason> or ALLOW <reason>.`,
      },
    ];
    const res = await client.chatOnce(messages);
    const text = String(res.message.content ?? '').trim();
    const firstToken = text.split(/\s+/, 1)[0]?.toUpperCase() ?? '';
    const reason = text.replace(/^\s*\S+\s*/, '').trim() || 'no reason provided';
    if (firstToken === 'BLOCK') return { block: true, reason };
    return { block: false, reason };
  };
}
