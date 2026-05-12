// Inbound message triage.
//
// Read-side counterpart to the outbound integrations under `src/integrations/`
// (slack.ts / discord.ts / telegram.ts / whatsapp.ts). This module:
//
//   1. Defines a normalized InboundMessage shape across channels.
//   2. Classifies each inbound message into one of five buckets:
//        urgent       — surface immediately, ring the bell
//        reply_now    — draft a reply and surface for one-click send
//        draft        — draft a reply, save to inbox, no notification
//        digest       — roll into the next daily brief
//        ignore       — log only
//   3. Produces draft replies via a callable model invoke.
//   4. NEVER sends. The reply only goes out after a human approves through
//      the existing send-tool with its capability grant.
//
// Channel-specific pollers (Slack RTM, Telegram getUpdates long-poll, IMAP
// IDLE, WhatsApp webhook) ship as opt-in cookbook recipes. They feed
// InboundMessage records into `triageInboundMessage` here.

export type InboundChannel = 'slack' | 'discord' | 'telegram' | 'whatsapp' | 'email' | 'webhook';

export type TriageBucket = 'urgent' | 'reply_now' | 'draft' | 'digest' | 'ignore';

export interface InboundMessage {
  id: string;
  channel: InboundChannel;
  from: string;
  to?: string;
  subject?: string;
  body: string;
  receivedAt: string;
  threadId?: string;
  metadata?: Record<string, unknown>;
}

export interface TriageRule {
  /** Lowercased substring tested against body + subject + from. */
  match: string;
  bucket: TriageBucket;
  reason: string;
}

export interface TriageResult {
  message: InboundMessage;
  bucket: TriageBucket;
  reason: string;
  matchedRule?: TriageRule;
  suggestedReply?: string;
}

const DEFAULT_RULES: TriageRule[] = [
  { match: 'urgent', bucket: 'urgent', reason: 'word "urgent" present' },
  { match: 'asap', bucket: 'urgent', reason: 'word "asap" present' },
  { match: 'production down', bucket: 'urgent', reason: 'phrase "production down" present' },
  { match: 'p0', bucket: 'urgent', reason: 'severity tag p0 present' },
  { match: 'p1', bucket: 'urgent', reason: 'severity tag p1 present' },
  { match: 'when do you', bucket: 'reply_now', reason: 'direct question to user' },
  { match: 'can you', bucket: 'reply_now', reason: 'direct question to user' },
  { match: 'unsubscribe', bucket: 'ignore', reason: 'newsletter footer pattern' },
  { match: 'no-reply', bucket: 'digest', reason: 'no-reply sender pattern' },
];

export interface TriageOptions {
  rules?: TriageRule[];
  /** Optional draft-reply generator. Skipped if not provided. */
  draftReply?: (message: InboundMessage, bucket: TriageBucket) => Promise<string | undefined>;
}

export async function triageInboundMessage(message: InboundMessage, options: TriageOptions = {}): Promise<TriageResult> {
  const rules = options.rules ?? DEFAULT_RULES;
  const haystack = `${message.subject ?? ''} ${message.body} ${message.from}`.toLowerCase();
  const matched = rules.find((r) => haystack.includes(r.match.toLowerCase()));
  const bucket: TriageBucket = matched?.bucket ?? 'digest';
  const reason = matched?.reason ?? 'no rule matched, defaulting to digest';

  let suggestedReply: string | undefined;
  if (options.draftReply && (bucket === 'urgent' || bucket === 'reply_now')) {
    try {
      suggestedReply = await options.draftReply(message, bucket);
    } catch {
      suggestedReply = undefined;
    }
  }

  return { message, bucket, reason, matchedRule: matched, suggestedReply };
}

export interface TriageBatch {
  results: TriageResult[];
  counts: Record<TriageBucket, number>;
}

export async function triageBatch(messages: InboundMessage[], options: TriageOptions = {}): Promise<TriageBatch> {
  const results = await Promise.all(messages.map((m) => triageInboundMessage(m, options)));
  const counts: Record<TriageBucket, number> = { urgent: 0, reply_now: 0, draft: 0, digest: 0, ignore: 0 };
  for (const r of results) counts[r.bucket]++;
  return { results, counts };
}

export interface InboundTriageStatus {
  pollersInstalled: string[];
  /** How many channels have a poller registered. Zero means feature is interface-only. */
  ready: boolean;
}

const installedPollers = new Set<InboundChannel>();

export function registerInboundPoller(channel: InboundChannel): void {
  installedPollers.add(channel);
}

export function getInboundTriageStatus(): InboundTriageStatus {
  return { pollersInstalled: Array.from(installedPollers), ready: installedPollers.size > 0 };
}
