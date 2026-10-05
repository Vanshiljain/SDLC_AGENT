import { render, screen } from '@testing-library/react';
import { highlightJson, JsonView } from './content';

describe('JSON viewer', () => {
  it('escapes HTML so tool output can never inject markup', () => {
    const html = highlightJson(JSON.stringify({ evil: '<img src=x onerror=alert(1)>' }));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('renders values as text', () => {
    const { container } = render(<JsonView value={{ a: '<script>x</script>', n: 1, ok: true, none: null }} />);
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText(/script/)).toBeInTheDocument();
  });
});
