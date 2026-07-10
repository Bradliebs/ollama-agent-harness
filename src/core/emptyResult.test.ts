import { detectEmptyResult } from './queryLoop';

describe('detectEmptyResult', () => {
  it('returns null for normal output', () => {
    expect(detectEmptyResult('Found 5 matching stocks')).toBeNull();
  });

  it('detects "passing: 0"', () => {
    expect(detectEmptyResult('PASSING: 0/76\nFAIL only on trend efficiency')).toBe('passing: 0');
  });

  it('detects "0 results found"', () => {
    expect(detectEmptyResult('0 results found in the scan')).toBe('zero results found');
  });

  it('detects "no results available"', () => {
    expect(detectEmptyResult('No results available for this query')).toBe('no results available');
  });

  it('detects "no matches found"', () => {
    expect(detectEmptyResult('No matches found in the dataset')).toBe('no results available');
  });

  it('detects empty JSON array', () => {
    expect(detectEmptyResult('[]')).toBe('empty JSON array');
  });

  it('detects empty JSON object', () => {
    expect(detectEmptyResult('{}')).toBe('empty JSON object');
  });

  it('detects header-only table', () => {
    expect(detectEmptyResult('Ticker,Price,ADX,Status')).toBe('header-only table (no data rows)');
  });

  it('returns null for short/empty input', () => {
    expect(detectEmptyResult('')).toBeNull();
    expect(detectEmptyResult('hi')).toBeNull();
  });

  it('detects "nothing found"', () => {
    expect(detectEmptyResult('Nothing found to display')).toBe('nothing found');
  });
});
