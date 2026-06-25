import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Fragment } from 'react';
import { Link, useLocation } from 'react-router-dom';

// Friendly labels for the static top-level segments; dynamic segments
// (a content-type apiId, an entry id) fall back to the raw value, and the
// "new" editor segment reads as a sentence.
const LABELS: Record<string, string> = {
  dashboard: 'Dashboard',
  content: 'Content',
  media: 'Media',
  settings: 'Settings',
  new: 'New entry',
};

const labelFor = (seg: string) => LABELS[seg] ?? seg;

/** Breadcrumb trail derived from the URL path, e.g. Content / article / new. */
export function Breadcrumbs() {
  const segments = useLocation().pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {segments.map((seg, i) => {
          const href = `/${segments.slice(0, i + 1).join('/')}`;
          const isLast = i === segments.length - 1;
          return (
            <Fragment key={href}>
              <BreadcrumbItem>
                {isLast ? (
                  <BreadcrumbPage>{labelFor(seg)}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link to={href}>{labelFor(seg)}</Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {!isLast && <BreadcrumbSeparator />}
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
