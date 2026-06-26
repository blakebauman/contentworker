import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { RichTextDocument, RichTextNode } from '@cw/domain';
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import type { PickOption } from './EntryForm.js';

// Sentinel for an unset embed reference (Radix Select forbids empty values).
const NONE = '__none__';

/** Block kinds the structured editor exposes (a pragmatic subset of the model). */
const TEXT_BLOCKS = [
  { nodeType: 'paragraph', label: 'Paragraph' },
  { nodeType: 'heading-1', label: 'Heading 1' },
  { nodeType: 'heading-2', label: 'Heading 2' },
  { nodeType: 'heading-3', label: 'Heading 3' },
  { nodeType: 'blockquote', label: 'Quote' },
] as const;

const REFERENCE_BLOCKS = ['embedded-entry-block', 'embedded-asset-block'] as const;

type TextBlock = { kind: 'text'; nodeType: string; text: string };
type EmbedBlock = { kind: 'embed'; nodeType: (typeof REFERENCE_BLOCKS)[number]; id: string };
type Block = TextBlock | EmbedBlock;

function nodeText(node: RichTextNode): string {
  return (node.content ?? []).map((c) => c.value ?? '').join('');
}

/** Parses a stored document (or anything) into the editor's block list. */
function toBlocks(value: unknown): Block[] {
  const doc = value as RichTextDocument | undefined;
  if (!doc || doc.nodeType !== 'document' || !Array.isArray(doc.content)) return [];
  return doc.content.map((node): Block => {
    if (node.nodeType === 'embedded-entry-block' || node.nodeType === 'embedded-asset-block') {
      return { kind: 'embed', nodeType: node.nodeType, id: node.data?.target?.id ?? '' };
    }
    return { kind: 'text', nodeType: node.nodeType, text: nodeText(node) };
  });
}

/** Serializes the block list back into a rich-text document (or undefined if empty). */
function toDocument(blocks: Block[]): RichTextDocument | undefined {
  const content: RichTextNode[] = blocks
    .map((b): RichTextNode | null => {
      if (b.kind === 'embed') {
        if (!b.id) return null;
        const linkType = b.nodeType === 'embedded-asset-block' ? 'Asset' : 'Entry';
        return { nodeType: b.nodeType, data: { target: { id: b.id, linkType } }, content: [] };
      }
      return { nodeType: b.nodeType, content: [{ nodeType: 'text', value: b.text, marks: [] }] };
    })
    .filter((n): n is RichTextNode => n !== null);
  if (content.length === 0) return undefined;
  return { nodeType: 'document', content };
}

/**
 * A structured rich-text editor: an ordered list of blocks (paragraphs,
 * headings, quotes) plus embedded entry/asset references. Embeds register in the
 * reference graph exactly like Link fields, so "what links here" stays accurate.
 */
export function RichTextEditor(props: {
  id?: string;
  value: unknown;
  pickers: { entries: PickOption[]; assets: PickOption[] };
  onChange: (value: RichTextDocument | undefined) => void;
}) {
  const blocks = toBlocks(props.value);

  const commit = (next: Block[]) => props.onChange(toDocument(next));
  const patch = (i: number, b: Partial<Block>) =>
    commit(blocks.map((blk, j) => (j === i ? ({ ...blk, ...b } as Block) : blk)));
  const removeAt = (i: number) => commit(blocks.filter((_, j) => j !== i));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= blocks.length) return;
    const next = [...blocks];
    const [a, b] = [next[i], next[j]] as [Block, Block];
    next[i] = b;
    next[j] = a;
    commit(next);
  };
  const addText = () => commit([...blocks, { kind: 'text', nodeType: 'paragraph', text: '' }]);
  const addEmbed = (nodeType: EmbedBlock['nodeType']) =>
    commit([...blocks, { kind: 'embed', nodeType, id: '' }]);

  return (
    <div className="space-y-2 rounded-lg border bg-card p-3" id={props.id}>
      {blocks.length === 0 && (
        <p className="text-muted-foreground text-sm">Empty document. Add a block to begin.</p>
      )}

      {blocks.map((block, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional
        <div key={i} className="flex items-start gap-2">
          <div className="flex flex-col">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label="Move up"
              disabled={i === 0}
              onClick={() => move(i, -1)}
            >
              <ChevronUp className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label="Move down"
              disabled={i === blocks.length - 1}
              onClick={() => move(i, 1)}
            >
              <ChevronDown className="size-4" />
            </Button>
          </div>

          <div className="flex-1 space-y-1.5">
            {block.kind === 'text' ? (
              <>
                <Select value={block.nodeType} onValueChange={(v) => patch(i, { nodeType: v })}>
                  <SelectTrigger className="h-8 w-[160px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TEXT_BLOCKS.map((t) => (
                      <SelectItem key={t.nodeType} value={t.nodeType}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Textarea
                  rows={block.nodeType.startsWith('heading') ? 1 : 3}
                  value={block.text}
                  placeholder="Write…"
                  onChange={(e) => patch(i, { text: e.target.value })}
                />
              </>
            ) : (
              <EmbedPicker
                block={block}
                options={
                  block.nodeType === 'embedded-asset-block'
                    ? props.pickers.assets
                    : props.pickers.entries
                }
                onChange={(id) => patch(i, { id })}
              />
            )}
          </div>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Remove block"
            onClick={() => removeAt(i)}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}

      <div className="flex flex-wrap gap-2 border-t pt-2">
        <Button type="button" variant="outline" size="sm" onClick={addText}>
          <Plus className="size-4" />
          Text block
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => addEmbed('embedded-entry-block')}
        >
          <Plus className="size-4" />
          Embed entry
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => addEmbed('embedded-asset-block')}
        >
          <Plus className="size-4" />
          Embed asset
        </Button>
      </div>
    </div>
  );
}

function EmbedPicker(props: {
  block: EmbedBlock;
  options: PickOption[];
  onChange: (id: string) => void;
}) {
  const label = props.block.nodeType === 'embedded-asset-block' ? 'asset' : 'entry';
  return (
    <div className="space-y-1.5">
      <span className="text-muted-foreground text-xs">Embedded {label}</span>
      <Select
        value={props.block.id || NONE}
        onValueChange={(v) => props.onChange(v === NONE ? '' : v)}
      >
        <SelectTrigger>
          <SelectValue placeholder={`Pick an ${label}…`} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>— none —</SelectItem>
          {props.options.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
