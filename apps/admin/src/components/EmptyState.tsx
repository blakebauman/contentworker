import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/** Consistent empty state: an icon medallion, title, description, and optional action. */
export function EmptyState(props: {
  icon: LucideIcon;
  title: string;
  description?: string;
  children?: ReactNode;
  className?: string;
}) {
  const { icon: Icon } = props;
  return (
    <Empty className={props.className}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{props.title}</EmptyTitle>
        {props.description && <EmptyDescription>{props.description}</EmptyDescription>}
      </EmptyHeader>
      {props.children && <EmptyContent>{props.children}</EmptyContent>}
    </Empty>
  );
}
