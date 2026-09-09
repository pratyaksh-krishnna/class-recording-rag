import { test, expect, describe } from 'bun:test';
import {
  slugify,
  parseLeadingPosition,
  buildManifest,
  type ManifestEntry,
} from '../../../apps/api/src/ingestion/manifest';

describe('slugify', () => {
  test('lowercases and turns spaces into dashes', () => {
    expect(slugify('What Is Mobile Development')).toBe('what-is-mobile-development');
  });

  test('turns underscores and dots into dashes', () => {
    expect(slugify('react_native.vs.expo')).toBe('react-native-vs-expo');
  });

  test('strips parentheses', () => {
    expect(slugify('core components (view , text , image)')).toBe(
      'core-components-view-text-image',
    );
  });

  test('strips a bare ampersand', () => {
    expect(slugify('list & data')).toBe('list-data');
  });

  test('handles an ampersand-laden real directory name', () => {
    expect(slugify('04_list-&-data-display-components_epm')).toBe(
      '04-list-data-display-components-epm',
    );
  });

  test('strips unicode characters not in [a-z0-9-]', () => {
    expect(slugify('Café Résumé')).toBe('caf-rsum');
  });

  test('collapses repeated separators', () => {
    expect(slugify('foo___bar   baz--qux')).toBe('foo-bar-baz-qux');
  });

  test('trims leading and trailing dashes', () => {
    expect(slugify('--hello world--')).toBe('hello-world');
  });

  test('throws on empty input', () => {
    expect(() => slugify('')).toThrow(/empty/);
  });

  test('throws on input that is empty after stripping', () => {
    expect(() => slugify('!!!')).toThrow(/empty/);
  });

  test('never emits a colon', () => {
    const inputs = [
      'module: 7',
      'a:b:c',
      '04_list-&-data-display-components_epm',
      'Café: Résumé',
      'foo___bar   baz--qux',
    ];
    for (const input of inputs) {
      expect(slugify(input)).not.toContain(':');
    }
  });
});

describe('parseLeadingPosition', () => {
  test('parses a "01_" style prefix', () => {
    expect(parseLeadingPosition('01_what-is-mobile-development_epm')).toEqual({
      position: 1,
      rest: 'what-is-mobile-development_epm',
    });
  });

  test('parses a "2. " style prefix', () => {
    expect(parseLeadingPosition('2. Setting Up React Navigation in Expo_epm')).toEqual({
      position: 2,
      rest: 'Setting Up React Navigation in Expo_epm',
    });
  });

  test('parses a trailing "module 10" style number', () => {
    expect(parseLeadingPosition('module 10')).toEqual({ position: 10, rest: 'module' });
  });

  test('parses a trailing "module 9" style number', () => {
    expect(parseLeadingPosition('module 9')).toEqual({ position: 9, rest: 'module' });
  });

  test('returns null position for a name with no numeric prefix', () => {
    expect(parseLeadingPosition('Something personal for Mobile development_epm')).toEqual({
      position: null,
      rest: 'Something personal for Mobile development_epm',
    });
  });

  test('returns null position when a trailing word follows the number ("module 1 hc")', () => {
    expect(parseLeadingPosition('module 1 hc')).toEqual({ position: null, rest: 'module 1 hc' });
  });
});

function entry(
  modulePath: string,
  classPath: string,
  format: 'srt' | 'vtt' = 'srt',
): ManifestEntry {
  return {
    modulePath,
    classPath,
    format,
    sourceUri: `recordings/class-subtitle/${modulePath}/${classPath}/${classPath}.${format}`,
  };
}

const cohort = { slug: 'mobile-dev-cohort', name: 'mobile dev cohort' };

describe('buildManifest', () => {
  test('orders modules numerically, not lexicographically (module 10 after module 9)', () => {
    const manifest = buildManifest({
      cohort,
      entries: [
        entry('module 10', '01_foo_epm'),
        entry('module 9', '01_bar_epm'),
        entry('module 2', '01_baz_epm'),
      ],
    });
    expect(manifest.modules.map((m) => m.slug)).toEqual(['module-2', 'module-9', 'module-10']);
    expect(manifest.modules.map((m) => m.position)).toEqual([1, 2, 3]);
  });

  test('puts a numberless module ("module 1 hc") last', () => {
    const manifest = buildManifest({
      cohort,
      entries: [
        entry('module 1 hc', 'Something personal_epm'),
        entry('module 2', '01_baz_epm'),
        entry('module 1', '01_foo_epm'),
      ],
    });
    expect(manifest.modules.map((m) => m.slug)).toEqual(['module-1', 'module-2', 'module-1-hc']);
    expect(manifest.modules.map((m) => m.position)).toEqual([1, 2, 3]);
  });

  test('orders classes within a module numerically and assigns dense 1-based positions', () => {
    const manifest = buildManifest({
      cohort,
      entries: [
        entry('module 1', '03_third_epm'),
        entry('module 1', '01_first_epm'),
        entry('module 1', '02_second_epm'),
      ],
    });
    const classes = manifest.modules[0]!.classes;
    expect(classes.map((c) => c.name)).toEqual(['first', 'second', 'third']);
    expect(classes.map((c) => c.position)).toEqual([1, 2, 3]);
  });

  test('puts numberless classes after numbered ones, ordered by name', () => {
    const manifest = buildManifest({
      cohort,
      entries: [
        entry('module 3', 'mini-project-2-backend_epm'),
        entry('module 3', '01_intro_epm'),
        entry('module 3', 'mini-project-1-init_epm'),
      ],
    });
    const classes = manifest.modules[0]!.classes;
    expect(classes.map((c) => c.slug)).toEqual([
      '01-intro',
      'mini-project-1-init',
      'mini-project-2-backend',
    ]);
    expect(classes.map((c) => c.position)).toEqual([1, 2, 3]);
  });

  test('derives a human name stripping the numeric prefix and trailing _epm', () => {
    const manifest = buildManifest({
      cohort,
      entries: [entry('module 2', '01_native-components-vs-core-components_epm')],
    });
    expect(manifest.modules[0]!.classes[0]!.name).toBe('native components vs core components');
  });

  test('throws a clear error on two distinct class dirs that slugify to the same slug', () => {
    // "01_foo_epm" and "01-foo_epm" are different directories but collide after
    // slugify's underscore/dash normalization — a genuine naming conflict,
    // unlike the same class appearing as both .srt and .vtt (deduped below).
    expect(() =>
      buildManifest({
        cohort,
        entries: [entry('module 1', '01_foo_epm'), entry('module 1', '01-foo_epm')],
      }),
    ).toThrow(/duplicate/i);
  });

  test('a class present as both srt and vtt appears exactly once, preferring srt', () => {
    const manifest = buildManifest({
      cohort,
      entries: [
        entry('module 1', '01_foo_epm', 'vtt'),
        entry('module 1', '01_foo_epm', 'srt'),
      ],
    });
    const classes = manifest.modules[0]!.classes;
    expect(classes).toHaveLength(1);
    expect(classes[0]!.format).toBe('srt');
  });

  test('falling back to vtt when only vtt is present', () => {
    const manifest = buildManifest({
      cohort,
      entries: [entry('module 1', '01_foo_epm', 'vtt')],
    });
    expect(manifest.modules[0]!.classes[0]!.format).toBe('vtt');
  });

  test('carries the cohort through unchanged', () => {
    const manifest = buildManifest({ cohort, entries: [entry('module 1', '01_foo_epm')] });
    expect(manifest.cohort).toEqual(cohort);
  });
});
