import type { ReactNode } from 'react';

/** Consistent page heading: title + optional description, with actions on the right. */
export function PageHeader(props: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{props.title}</h1>
        {props.description && (
          <p className="mt-1 text-sm text-muted-foreground">{props.description}</p>
        )}
      </div>
      {props.children && <div className="flex items-center gap-2">{props.children}</div>}
    </div>
  );
}
