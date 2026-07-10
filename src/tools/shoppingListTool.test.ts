import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createShoppingListTool } from './shoppingListTool';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'harness-shopping-'));
}

describe('shopping_list tool', () => {
  it('returns "empty" when the list file does not exist yet', async () => {
    const dir = await tmpDir();
    const tool = createShoppingListTool(dir);
    const result = await tool.execute({ op: 'list' });
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/empty/i);
  });

  it('add creates the storage file under .harness/shopping/', async () => {
    const dir = await tmpDir();
    const tool = createShoppingListTool(dir);
    await tool.execute({ op: 'add', name: 'milk' });
    const stat = await fs.stat(path.join(dir, '.harness', 'shopping', 'list.json'));
    expect(stat.isFile()).toBe(true);
  });

  it('add then list round-trips', async () => {
    const dir = await tmpDir();
    const tool = createShoppingListTool(dir);
    await tool.execute({ op: 'add', name: 'milk' });
    await tool.execute({ op: 'add', name: 'bread', note: 'sourdough' });
    const result = await tool.execute({ op: 'list' });
    expect(result.output).toMatch(/milk/);
    expect(result.output).toMatch(/bread/);
    expect(result.output).toMatch(/sourdough/);
  });

  it('add of an existing item with no quantity bumps the count', async () => {
    const dir = await tmpDir();
    const tool = createShoppingListTool(dir);
    await tool.execute({ op: 'add', name: 'milk' });
    await tool.execute({ op: 'add', name: 'milk' });
    await tool.execute({ op: 'add', name: 'milk' });
    const result = await tool.execute({ op: 'list' });
    expect(result.output).toMatch(/milk \(x3\)/);
  });

  it('add of an existing item with explicit quantity replaces the count', async () => {
    const dir = await tmpDir();
    const tool = createShoppingListTool(dir);
    await tool.execute({ op: 'add', name: 'milk', quantity: 2 });
    await tool.execute({ op: 'add', name: 'milk', quantity: 5 });
    const result = await tool.execute({ op: 'list' });
    expect(result.output).toMatch(/milk \(x5\)/);
  });

  it('dedup is case-insensitive and whitespace-tolerant; display name keeps original casing', async () => {
    const dir = await tmpDir();
    const tool = createShoppingListTool(dir);
    await tool.execute({ op: 'add', name: 'Milk' });
    await tool.execute({ op: 'add', name: '  milk  ' });
    const result = await tool.execute({ op: 'list' });
    expect(result.output).toMatch(/Milk \(x2\)/); // displayName preserved
    // Only one row, not two.
    const lines = result.output.split('\n').filter((l) => /^\d+\. /.test(l));
    expect(lines.length).toBe(1);
  });

  it('add appends notes for an existing item rather than overwriting', async () => {
    const dir = await tmpDir();
    const tool = createShoppingListTool(dir);
    await tool.execute({ op: 'add', name: 'milk', note: 'organic' });
    await tool.execute({ op: 'add', name: 'milk', note: 'oat if no dairy' });
    const result = await tool.execute({ op: 'list' });
    expect(result.output).toMatch(/organic; oat if no dairy/);
  });

  it('remove by name deletes the matching item', async () => {
    const dir = await tmpDir();
    const tool = createShoppingListTool(dir);
    await tool.execute({ op: 'add', name: 'milk' });
    await tool.execute({ op: 'add', name: 'bread' });
    const removed = await tool.execute({ op: 'remove', name: 'milk' });
    expect(removed.success).toBe(true);
    const list = await tool.execute({ op: 'list' });
    expect(list.output).not.toMatch(/milk/);
    expect(list.output).toMatch(/bread/);
  });

  it('remove by 1-based index deletes the right item', async () => {
    const dir = await tmpDir();
    const tool = createShoppingListTool(dir);
    await tool.execute({ op: 'add', name: 'milk' });
    await tool.execute({ op: 'add', name: 'bread' });
    await tool.execute({ op: 'add', name: 'apples' });
    const removed = await tool.execute({ op: 'remove', index: 2 });
    expect(removed.success).toBe(true);
    expect(removed.output).toMatch(/bread/);
    const list = await tool.execute({ op: 'list' });
    expect(list.output).toMatch(/milk/);
    expect(list.output).toMatch(/apples/);
    expect(list.output).not.toMatch(/bread/);
  });

  it('remove of a missing item fails cleanly without corrupting the list', async () => {
    const dir = await tmpDir();
    const tool = createShoppingListTool(dir);
    await tool.execute({ op: 'add', name: 'milk' });
    const missing = await tool.execute({ op: 'remove', name: 'nope' });
    expect(missing.success).toBe(false);
    const list = await tool.execute({ op: 'list' });
    expect(list.output).toMatch(/milk/);
  });

  it('clear removes everything', async () => {
    const dir = await tmpDir();
    const tool = createShoppingListTool(dir);
    await tool.execute({ op: 'add', name: 'milk' });
    await tool.execute({ op: 'add', name: 'bread' });
    await tool.execute({ op: 'clear' });
    const result = await tool.execute({ op: 'list' });
    expect(result.output).toMatch(/empty/i);
  });

  it('mark_bought removes from the active list and appends to history.jsonl', async () => {
    const dir = await tmpDir();
    const tool = createShoppingListTool(dir);
    await tool.execute({ op: 'add', name: 'milk', quantity: 2 });
    await tool.execute({ op: 'add', name: 'bread' });
    await tool.execute({ op: 'mark_bought', name: 'milk' });

    const list = await tool.execute({ op: 'list' });
    expect(list.output).not.toMatch(/milk/);
    expect(list.output).toMatch(/bread/);

    const historyRaw = await fs.readFile(path.join(dir, '.harness', 'shopping', 'history.jsonl'), 'utf8');
    const lines = historyRaw.trim().split('\n');
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.name).toBe('milk');
    expect(entry.quantity).toBe(2);
    expect(typeof entry.boughtAt).toBe('string');
  });

  it('corrupt JSON is recovered to an empty list rather than crashing', async () => {
    const dir = await tmpDir();
    const target = path.join(dir, '.harness', 'shopping', 'list.json');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, '{not valid json', 'utf8');
    const tool = createShoppingListTool(dir);
    const result = await tool.execute({ op: 'list' });
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/empty/i);
    // And we should still be able to add after recovery.
    const added = await tool.execute({ op: 'add', name: 'milk' });
    expect(added.success).toBe(true);
  });

  it('concurrent adds to the same projectDir do not lose items', async () => {
    const dir = await tmpDir();
    const tool = createShoppingListTool(dir);
    const names = ['milk', 'bread', 'apples', 'eggs', 'butter', 'cheese', 'salt', 'pepper'];
    await Promise.all(names.map((n) => tool.execute({ op: 'add', name: n })));
    const result = await tool.execute({ op: 'list' });
    for (const n of names) {
      expect(result.output).toMatch(new RegExp(n));
    }
  });

  it('unknown op returns a failure with valid-ops hint', async () => {
    const dir = await tmpDir();
    const tool = createShoppingListTool(dir);
    const result = await tool.execute({ op: 'frobnicate' });
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/unknown op/i);
    expect(result.output).toMatch(/add, list, remove, clear, mark_bought/);
  });
});
