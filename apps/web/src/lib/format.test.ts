import { formatDuration, initials, providerName, timeAgo, titleCase, truncate } from './format';

describe('format', () => {
  it('formats durations compactly', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(420)).toBe('420ms');
    expect(formatDuration(4_200)).toBe('4.2s');
    expect(formatDuration(75_000)).toBe('1m 15s');
    expect(formatDuration(3_900_000)).toBe('1h 5m');
  });

  it('formats relative time', () => {
    const now = Date.parse('2026-01-01T12:00:00Z');
    expect(timeAgo('2026-01-01T11:59:55Z', now)).toBe('just now');
    expect(timeAgo('2026-01-01T11:55:00Z', now)).toBe('5 minutes ago');
    expect(timeAgo('2025-12-31T12:00:00Z', now)).toBe('yesterday');
    expect(timeAgo(null)).toBe('—');
  });

  it('uses real product names', () => {
    expect(providerName('GITHUB')).toBe('GitHub');
    expect(providerName('github_actions')).toBe('GitHub Actions');
    expect(providerName('CUSTOM_DEVOPS')).toBe('Custom DevOps');
    expect(providerName('SOMETHING_ELSE')).toBe('Something Else');
  });

  it('builds initials, titles and truncations', () => {
    expect(initials('Lee Release-Lead')).toBe('LR');
    expect(initials('Eli')).toBe('E');
    expect(titleCase('WAITING_APPROVAL')).toBe('Waiting Approval');
    expect(truncate('abcdef', 4)).toBe('abc…');
  });
});
