import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { NodeViewProps } from '@tiptap/react';
import { NodeViewWrapper } from '@tiptap/react';
import { FileText, Image } from 'lucide-react';
import { createContext, useContext } from 'react';
import type { Pickers } from '../EntryForm.js';

// Radix Select forbids an empty-string item value; use a sentinel for "unset".
const NONE = '__none__';

/** Picker options reach embed NodeViews through context (they render in portals). */
export const RichTextPickersContext = createContext<Pickers>({ entries: [], assets: [] });

/** Card for an embedded entry/asset atom: icon, label, and a target picker. */
export function EmbedNodeView(props: NodeViewProps) {
  const pickers = useContext(RichTextPickersContext);
  const isAsset = props.node.type.name === 'embeddedAssetBlock';
  const options = isAsset ? pickers.assets : pickers.entries;
  const targetId = (props.node.attrs.targetId as string) ?? '';
  const label = isAsset ? 'asset' : 'entry';

  return (
    <NodeViewWrapper data-testid={`embed-${label}`} className="my-2">
      <div
        data-drag-handle
        className="flex items-center gap-2 rounded-md border bg-muted/40 p-2"
        contentEditable={false}
      >
        {isAsset ? (
          <Image className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <FileText className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="text-muted-foreground text-xs">Embedded {label}</span>
        <Select
          value={targetId || NONE}
          onValueChange={(v) => props.updateAttributes({ targetId: v === NONE ? '' : v })}
        >
          <SelectTrigger className="h-8 flex-1">
            <SelectValue placeholder={`Pick an ${label}…`} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>— none —</SelectItem>
            {options.map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </NodeViewWrapper>
  );
}

/** Muted chip for a stored node the editor doesn't model (kept losslessly). */
export function UnknownNodeView(props: NodeViewProps) {
  const raw = props.node.attrs.raw as { nodeType?: string } | null;
  const inline = props.node.isInline;
  return (
    <NodeViewWrapper
      as={inline ? 'span' : 'div'}
      className={inline ? 'inline' : 'my-2'}
      contentEditable={false}
    >
      <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
        Unsupported {inline ? 'content' : 'block'}: {raw?.nodeType ?? 'unknown'}
      </span>
    </NodeViewWrapper>
  );
}
