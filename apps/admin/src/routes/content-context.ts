import type { ContentType } from '@cw/domain';
import { useOutletContext } from 'react-router-dom';

/** Shared data the Content layout provides to its nested entry routes. */
export interface ContentOutlet {
  readonly types: ContentType[];
  readonly locales: readonly string[];
  readonly defaultLocale: string;
  readonly fallbacks?: Readonly<Record<string, string | null>>;
  reload(): void;
}

export function useContentOutlet(): ContentOutlet {
  return useOutletContext<ContentOutlet>();
}
