const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { queryLoop } = require('../../dist/core/queryLoop');
const { SessionStorage } = require('../../dist/persistence/sessionStorage');
const { resumeSession } = require('../../dist/persistence/resume');

const [mode, boundary] = process.argv.slice(2);
const workspace = process.cwd();
const session = new SessionStorage(workspace, 'offline-resume-fixture', 'interrupted');
const ledgerPath = path.join(workspace, 'ledger.txt');
const call = (name, id) => ({ role: 'assistant', content: '', tool_calls: [{ id, function: { name, arguments: {} } }] });

async function holdForInterruption() {
  process.send({ type: 'interruptible', boundary });
  await new Promise(() => {});
}

async function main() {
  let messages;
  if (mode === 'start') {
    await session.initialize();
    messages = [{ role: 'user', content: 'Record exactly one entry in the ledger, then verify it.' }];
    await session.append('user_message', { kind: 'message', message: messages[0] });
  } else {
    assert.equal(mode, 'resume');
    messages = (await resumeSession(workspace, 'interrupted', 'offline-resume-fixture')).messages;
    await fs.writeFile('resumed-messages.json', JSON.stringify(messages));
  }
  let turn = 0;
  const permissionChecks = [];
  const client = {
    chat: async () => {
      turn += 1;
      if (mode === 'start') {
        if (turn === 1) return { message: call('append_entry', 'append-original') };
        await holdForInterruption();
      }
      if (turn === 1) return { message: call('append_entry', 'append-replay') };
      if (turn === 2) return { message: call('read_ledger', 'read-reconcile') };
      return { message: { role: 'assistant', content: 'Ledger reconciled.' } };
    },
  };
  const tools = [
    {
      name: 'append_entry', description: 'Append one ledger entry', isReadOnly: false,
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        await fs.appendFile(ledgerPath, 'entry\n');
        if (mode === 'start' && boundary === 'before-result') await holdForInterruption();
        return { success: true, output: 'One entry recorded.' };
      },
    },
    {
      name: 'read_ledger', description: 'Read the ledger', isReadOnly: true,
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ success: true, output: await fs.readFile(ledgerPath, 'utf8') }),
    },
  ];
  const events = [];
  for await (const event of queryLoop({
    model: 'offline-resume-fixture', systemPrompt: 'Reconcile existing work before any further changes.',
    maxTurns: 4, context: { enabled: false },
  }, {
    client, tools, session,
    permissionCheck: async toolCall => {
      const allowed = mode === 'start' || toolCall.name === 'read_ledger';
      permissionChecks.push({ name: toolCall.name, allowed });
      return { allowed, reason: 'Resumed fixture permits read-only reconciliation; prior write permission is not restored.' };
    },
  }, messages)) events.push(event);
  await fs.writeFile('resume-result.json', JSON.stringify({ events, permissionChecks, meta: await session.getMeta() }));
}

process.on('message', () => {});
main().then(() => process.disconnect?.()).catch(error => {
  console.error(error);
  process.exitCode = 1;
  process.disconnect?.();
});