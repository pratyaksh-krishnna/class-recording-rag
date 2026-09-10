import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import type { Source } from '../../../packages/shared/src/contracts';
import {
  EvidenceEntry,
  isSourceOpenKey,
} from '../../../apps/web/src/components/EvidenceEntry';
import { fullChunkText, SourceViewer } from '../../../apps/web/src/components/SourceViewer';

const requireFromWeb = createRequire(new URL('../../../apps/web/package.json', import.meta.url));
const { createElement } = requireFromWeb('react');
const { renderToStaticMarkup } = requireFromWeb('react-dom/server');

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'SOURCE_1',
    chunkId: 'chunk-1',
    transcriptId: 'transcript-1',
    moduleId: 'module-1',
    moduleName: 'Mobile Foundations',
    classId: 'class-1',
    className: 'Understanding mobile development',
    startTime: '12:31',
    endTime: '13:08',
    startMs: 751_000,
    endMs: 788_000,
    excerpt: 'Short card excerpt',
    content: 'The complete retrieved transcript chunk, including text beyond the card excerpt.',
    ...overrides,
  };
}

describe('recording source viewer', () => {
  test('source cards advertise their dialog action and remain citation-targetable', () => {
    const markup = renderToStaticMarkup(
      createElement(EvidenceEntry, {
        turnId: 'answer-1',
        source: makeSource(),
        onOpen: () => {},
      }),
    );

    expect(markup).toContain('id="evidence-answer-1-SOURCE_1"');
    expect(markup).toContain('role="button"');
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('Open full chunk');
    expect(isSourceOpenKey('Enter')).toBe(true);
    expect(isSourceOpenKey(' ')).toBe(true);
    expect(isSourceOpenKey('Escape')).toBe(false);
  });

  test('dialog shows full content and exposes accessible dialog semantics', () => {
    const markup = renderToStaticMarkup(
      createElement(SourceViewer, {
        turnId: 'answer-1',
        source: makeSource(),
        onClose: () => {},
      }),
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('Close full chunk');
    expect(markup).toContain('The complete retrieved transcript chunk');
  });

  test('older sources without content fall back to their excerpt', () => {
    const source = makeSource({ content: undefined, excerpt: 'Fallback excerpt' });
    expect(fullChunkText(source)).toBe('Fallback excerpt');
  });
});
