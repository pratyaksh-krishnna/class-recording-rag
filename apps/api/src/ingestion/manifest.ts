/**
 * Pure core of the seed-manifest builder (spec §4, §7.3). No filesystem, no
 * argv — every function here is a deterministic function of its arguments so
 * it can be unit-tested against the real corpus's directory-naming quirks
 * without touching disk. `apps/api/scripts/build-manifest.ts` is the only
 * caller that talks to the filesystem.
 */

export interface ManifestClass {
  slug: string;
  name: string;
  position: number;
  sourceUri: string;
  format: 'srt' | 'vtt';
}

export interface ManifestModule {
  slug: string;
  name: string;
  position: number;
  classes: ManifestClass[];
}

export interface SeedManifest {
  cohort: { slug: string; name: string };
  modules: ManifestModule[];
}

export interface ManifestEntry {
  modulePath: string;
  classPath: string;
  sourceUri: string;
  format: 'srt' | 'vtt';
}

const SEPARATOR_RUN = /[\s._-]+/;

/**
 * Slugs land in `chunk_key` (chunkKey.ts forbids ":" in any component and
 * treats identical bytes as identity), so this must be a pure, stable
 * function of the input string forever — never locale- or clock-dependent.
 */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[\s_.]+/g, '-') // spaces/underscores/dots are word separators, not noise
    .replace(/[^a-z0-9-]/g, '') // drop everything else (this is what guarantees no ':')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (slug.length === 0) {
    throw new Error(`slugify: input ${JSON.stringify(input)} produced an empty slug`);
  }
  return slug;
}

/**
 * Extracts the ordering number from a directory name, checking a LEADING
 * digit run first ("01_foo", "2. foo") and, only if that fails, a TRAILING
 * one ("module 10"). The trailing check is what lets "module 10" sort after
 * "module 9" numerically while "module 1 hc" — whose last token is a word,
 * not a number — correctly reports no position and falls back to name order.
 * `rest` is whatever's left after the matched number and its adjacent
 * separators are removed; callers needing a display name still decide for
 * themselves whether that stripped number was noise (a class's ordering
 * prefix) or identity (a module's number), since this function can't know.
 */
export function parseLeadingPosition(name: string): { position: number | null; rest: string } {
  const leading = name.match(/^(\d+)[\s._-]*/);
  if (leading?.[1] !== undefined) {
    return { position: Number(leading[1]), rest: name.slice(leading[0].length).trim() };
  }

  const trailing = name.match(/[\s._-]+(\d+)$/);
  if (trailing?.[1] !== undefined && trailing.index !== undefined) {
    return { position: Number(trailing[1]), rest: name.slice(0, trailing.index).trim() };
  }

  return { position: null, rest: name };
}

/**
 * Human name derivation. Only a genuine LEADING numeric prefix is stripped —
 * that's ordering noise ("01_", "2. "). A number found elsewhere (a module
 * called "module 10") is part of the name's identity and stays, which is why
 * this re-checks the leading pattern itself rather than reusing
 * parseLeadingPosition's `rest` (that would also strip trailing numbers).
 */
function deriveName(rawName: string, stripEpmSuffix: boolean): string {
  let base = rawName.replace(/^\d+[\s._-]*/, '');
  if (base.length === 0) {
    base = rawName; // guard: an all-digits name must not become an empty name
  }
  if (stripEpmSuffix) {
    base = base.replace(/_epm$/i, '');
  }
  base = base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return base.length > 0 ? base : rawName.trim();
}

function stripEpm(name: string): string {
  return name.replace(/_epm$/i, '');
}

interface Positioned {
  position: number | null;
  name: string;
}

/**
 * Orders items with a known position ascending, then unplaced items last,
 * ordered stably by name (spec-required for "module 1 hc" and any class with
 * no numeric prefix), then hands back the same items with position replaced
 * by a dense 1-based rank — so a manifest never has gaps even though the raw
 * directory numbering does (e.g. module 1 hc's raw "position" is always null).
 */
function orderAndAssignPositions<T extends Positioned>(items: T[]): Array<Omit<T, 'position'> & { position: number }> {
  const sorted = [...items].sort((a, b) => {
    if (a.position !== null && b.position !== null) return a.position - b.position;
    if (a.position !== null) return -1;
    if (b.position !== null) return 1;
    return a.name.localeCompare(b.name);
  });
  return sorted.map((item, index) => ({ ...item, position: index + 1 }));
}

export function buildManifest(input: {
  cohort: { slug: string; name: string };
  entries: ManifestEntry[];
}): SeedManifest {
  // Prefer .srt when a class exists as both — never emit the same class twice
  // (spec decision row 6 grants the CLI leeway on which format is preferred;
  // this task's real corpus fixes it as srt-over-vtt).
  const byClassKey = new Map<string, ManifestEntry>();
  for (const entry of input.entries) {
    const key = `${entry.modulePath}\u0000${entry.classPath}`;
    const existing = byClassKey.get(key);
    if (existing === undefined || (existing.format === 'vtt' && entry.format === 'srt')) {
      byClassKey.set(key, entry);
    }
  }

  const moduleGroups = new Map<string, ManifestEntry[]>();
  for (const entry of byClassKey.values()) {
    const list = moduleGroups.get(entry.modulePath);
    if (list) {
      list.push(entry);
    } else {
      moduleGroups.set(entry.modulePath, [entry]);
    }
  }

  const rawModules = Array.from(moduleGroups.entries()).map(([modulePath, classEntries]) => {
    const { position } = parseLeadingPosition(modulePath);

    const rawClasses = classEntries.map((entry) => {
      const { position: classPosition } = parseLeadingPosition(entry.classPath);
      return {
        slug: slugify(stripEpm(entry.classPath)),
        name: deriveName(entry.classPath, true),
        position: classPosition,
        sourceUri: entry.sourceUri,
        format: entry.format,
      };
    });

    const classes = orderAndAssignPositions(rawClasses);

    const seenSlugs = new Set<string>();
    for (const klass of classes) {
      if (seenSlugs.has(klass.slug)) {
        throw new Error(
          `buildManifest: duplicate class slug "${klass.slug}" in module "${modulePath}"`,
        );
      }
      seenSlugs.add(klass.slug);
    }

    return {
      slug: slugify(modulePath),
      name: deriveName(modulePath, false),
      position,
      classes,
    };
  });

  const modules = orderAndAssignPositions(rawModules);

  return { cohort: input.cohort, modules };
}
