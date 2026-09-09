import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/theme.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found.');
}

/**
 * Renders a configuration failure as readable text instead of a blank page.
 *
 * `env.ts` throws at module evaluation when a required PUBLIC_* variable is
 * missing (plan §B.5), which is the behaviour we want — an unset cohort id
 * must not reach the API as `undefined`. But because that throw happens while
 * the import graph is being evaluated, nothing downstream of the import can
 * catch it, and the reader gets a white screen with a console trace they were
 * never told to look at. Importing App dynamically moves the failure inside a
 * catch without weakening the check itself.
 */
function renderConfigurationError(message: string): void {
  const wrapper = document.createElement('div');
  wrapper.setAttribute('role', 'alert');
  wrapper.className = 'mx-auto max-w-[66ch] px-6 py-16 font-ui text-ink';

  const heading = document.createElement('h1');
  heading.className = 'text-2xl font-semibold';
  heading.textContent = 'The app is not configured yet.';

  const detail = document.createElement('p');
  detail.className = 'mt-4 text-graphite';
  detail.textContent = message;

  const fix = document.createElement('p');
  fix.className = 'mt-4 text-graphite';
  fix.textContent =
    'Copy .env.example to .env and fill in the missing value, then restart the dev server.';

  wrapper.append(heading, detail, fix);
  rootElement!.replaceChildren(wrapper);
}

try {
  const { App } = await import('./App');
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
} catch (error) {
  renderConfigurationError(error instanceof Error ? error.message : String(error));
}
