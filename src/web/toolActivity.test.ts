import * as path from 'path';

const toolActivity = require(path.join(process.cwd(), 'ui', 'toolActivity.js')) as {
  summaryText: (count: number, errorCount: number) => string;
  updateToolActivitySummary: (toolBox: { closest: (selector: string) => unknown }, isError: boolean) => void;
};

describe('ui tool activity disclosure', () => {
  it('summarizes tool events without exposing raw details by default', () => {
    expect(toolActivity.summaryText(3, 0)).toBe('Tool activity: 3 event(s)');
  });

  it('calls attention to failed tool events', () => {
    expect(toolActivity.summaryText(5, 2)).toBe('Tool activity: 5 event(s), 2 need attention');
  });

  it('opens and marks the disclosure when an error is appended', () => {
    const summary = { textContent: '' };
    const shell = {
      dataset: { toolCount: '1', errorCount: '0' },
      open: false,
      classList: { add: jest.fn() },
      querySelector: jest.fn(() => summary),
    };
    const toolBox = { closest: jest.fn(() => shell) };

    toolActivity.updateToolActivitySummary(toolBox, true);

    expect(shell.dataset).toMatchObject({ toolCount: '2', errorCount: '1' });
    expect(shell.open).toBe(true);
    expect(shell.classList.add).toHaveBeenCalledWith('has-error');
    expect(summary.textContent).toBe('Tool activity: 2 event(s), 1 need attention');
  });
});