import * as childProcess from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: jest.fn(),
}));

import { PdfRenderPageTool } from './pdfTool';

describe('PdfRenderPageTool', () => {
  const originalCommand = process.env.HARNESS_PDF_RENDER_COMMAND;
  const fixturePath = path.join('.harness', 'pdf-renders', 'fixture.pdf');

  beforeAll(async () => {
    await fs.mkdir(path.dirname(fixturePath), { recursive: true });
    await fs.writeFile(fixturePath, Buffer.from('%PDF-1.4\n%fixture\n'));
  });

  afterAll(async () => {
    await fs.rm(path.join('.harness', 'pdf-renders'), { recursive: true, force: true });
  });

  afterEach(() => {
    if (originalCommand === undefined) delete process.env.HARNESS_PDF_RENDER_COMMAND;
    else process.env.HARNESS_PDF_RENDER_COMMAND = originalCommand;
    (childProcess.execFile as unknown as jest.Mock).mockReset();
  });

  it('errors when HARNESS_PDF_RENDER_COMMAND is not set', async () => {
    delete process.env.HARNESS_PDF_RENDER_COMMAND;
    const result = await PdfRenderPageTool.execute({ path: fixturePath, page: 1 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/render command not configured/);
  });

  it('rejects paths outside the project', async () => {
    process.env.HARNESS_PDF_RENDER_COMMAND = 'noop {input} {page} {output}';
    const result = await PdfRenderPageTool.execute({ path: '../outside.pdf', page: 1 });
    expect(result.success).toBe(false);
  });

  it('rejects non-pdf extensions', async () => {
    process.env.HARNESS_PDF_RENDER_COMMAND = 'noop {input} {page} {output}';
    const result = await PdfRenderPageTool.execute({ path: 'package.json', page: 1 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not a pdf/);
  });

  it('substitutes {input}, {page}, {output} and writes the rendered file', async () => {
    process.env.HARNESS_PDF_RENDER_COMMAND = 'mockrender {input} {page} {output}';
    (childProcess.execFile as unknown as jest.Mock).mockImplementation((_cmd, args, _opts, cb) => {
      // The third positional argument is the {output} path -> create a file there.
      const outArg = args[2];
      fs.writeFile(outArg, Buffer.from([0x89, 0x50, 0x4e, 0x47])).then(() => cb(null, { stdout: '', stderr: '' }));
    });
    const result = await PdfRenderPageTool.execute({ path: fixturePath, page: 3 });
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/Rendered page 3/);
    const call = (childProcess.execFile as unknown as jest.Mock).mock.calls[0];
    expect(call[0]).toBe('mockrender');
    expect(call[1][1]).toBe('3');
    expect(call[1][2]).toContain('fixture-p3.png');
  });
});
