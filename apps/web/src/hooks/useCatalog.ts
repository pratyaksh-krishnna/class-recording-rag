import { useEffect, useState } from 'react';
import { getCatalog } from '../api/client';
import { cohortId } from '../env';

const FALLBACK_COHORT_LABEL = 'Recordings';

export interface UseCatalogResult {
  cohortName: string;
  loading: boolean;
}

/**
 * Fetches the cohort catalog once for the masthead label. Failure degrades
 * silently — the masthead is not worth blocking the app for.
 */
export function useCatalog(): UseCatalogResult {
  const [cohortName, setCohortName] = useState<string>(FALLBACK_COHORT_LABEL);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    void (async (): Promise<void> => {
      try {
        const catalog = await getCatalog(cohortId);
        if (cancelled) {
          return;
        }
        setCohortName(catalog.cohortName);
      } catch {
        if (!cancelled) {
          setCohortName(FALLBACK_COHORT_LABEL);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return { cohortName, loading };
}
