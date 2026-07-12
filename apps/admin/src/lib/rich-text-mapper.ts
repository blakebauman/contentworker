/**
 * Bidirectional mapping between the stored rich-text document tree
 * (`RichTextDocument`, `nodeType`/`value`/`marks`) and Tiptap/ProseMirror JSON
 * (`type`/`text`/`marks` with attrs).
 *
 * Round-trip safety rules:
 * - Unmapped block nodes ride through an `unknownBlock` atom whose `raw` attr
 *   holds the stored node verbatim; unmapped inline nodes (e.g. entry-hyperlink,
 *   embedded-entry-inline) use `unknownInline` the same way. Serializing emits
 *   `raw` back unchanged, so foreign/API-authored documents are never corrupted.
 * - Stored `hyperlink` nodes flatten to text runs carrying a `link` mark
 *   (ProseMirror models links as marks); serializing groups maximal runs of
 *   consecutive text nodes with an identical href back into one hyperlink node.
 * - Unknown mark types are dropped on edit (text nodes can't carry raw data).
 *   The `code` mark is exclusive in ProseMirror: combined with other marks it
 *   wins, except inside a hyperlink where the link mark wins.
 * - Inline (text) children directly under block containers such as blockquote
 *   are wrapped in a paragraph, as ProseMirror requires block content there.
 */

import type { RichTextDocument, RichTextNode } from '@cw/domain';
import { isRichTextDocument } from '@cw/domain';

/** Minimal ProseMirror JSON shape (matches @tiptap/core's JSONContent). */
export interface PmNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PmNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

const HEADING = /^heading-([1-6])$/;

/** Stored block containers whose children are themselves blocks. */
const BLOCK_CONTAINERS: Record<string, string> = {
  blockquote: 'blockquote',
  'unordered-list': 'bulletList',
  'ordered-list': 'orderedList',
  'list-item': 'listItem',
};
const PM_CONTAINERS: Record<string, string> = {
  blockquote: 'blockquote',
  bulletList: 'unordered-list',
  orderedList: 'ordered-list',
  listItem: 'list-item',
};

const EMBED_TO_PM: Record<string, string> = {
  'embedded-entry-block': 'embeddedEntryBlock',
  'embedded-asset-block': 'embeddedAssetBlock',
};
const PM_TO_EMBED: Record<string, { nodeType: string; linkType: 'Entry' | 'Asset' }> = {
  embeddedEntryBlock: { nodeType: 'embedded-entry-block', linkType: 'Entry' },
  embeddedAssetBlock: { nodeType: 'embedded-asset-block', linkType: 'Asset' },
};

const MARK_TO_PM: Record<string, string> = {
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
  code: 'code',
  strikethrough: 'strike',
};
const PM_TO_MARK: Record<string, string> = {
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
  code: 'code',
  strike: 'strikethrough',
};

// ---------------------------------------------------------------------------
// Stored → Tiptap
// ---------------------------------------------------------------------------

/** Converts a stored rich-text value into a ProseMirror doc for the editor. */
export function toTiptap(value: unknown): PmNode {
  if (!isRichTextDocument(value)) return { type: 'doc', content: [{ type: 'paragraph' }] };
  const content = blockChildrenToPm(value.content);
  return { type: 'doc', content: content.length > 0 ? content : [{ type: 'paragraph' }] };
}

/**
 * Maps block-level children, wrapping stray inline runs in a paragraph.
 * ProseMirror content expressions are strict, so API-authored shapes are
 * normalized to stay schema-legal: inside a list, non-list-item children are
 * wrapped in a listItem; outside one, an orphan listItem gets a bulletList.
 */
function blockChildrenToPm(nodes: readonly RichTextNode[], parent?: 'list'): PmNode[] {
  const out: PmNode[] = [];
  const push = (pm: PmNode) => {
    if (parent === 'list' && pm.type !== 'listItem') {
      out.push({ type: 'listItem', content: [pm] });
    } else if (parent !== 'list' && pm.type === 'listItem') {
      out.push({ type: 'bulletList', content: [pm] });
    } else {
      out.push(pm);
    }
  };
  let inlineRun: PmNode[] = [];
  const flush = () => {
    if (inlineRun.length > 0) push({ type: 'paragraph', content: inlineRun });
    inlineRun = [];
  };
  for (const node of nodes) {
    if (isInlineStored(node)) {
      inlineRun.push(...inlineToPm(node));
    } else {
      flush();
      push(blockToPm(node));
    }
  }
  flush();
  return out;
}

function isInlineStored(node: RichTextNode): boolean {
  return (
    node.nodeType === 'text' ||
    node.nodeType === 'hard-break' ||
    node.nodeType === 'hyperlink' ||
    node.nodeType === 'entry-hyperlink' ||
    node.nodeType === 'asset-hyperlink' ||
    node.nodeType === 'embedded-entry-inline'
  );
}

function blockToPm(node: RichTextNode): PmNode {
  const heading = HEADING.exec(node.nodeType);
  if (heading) {
    return {
      type: 'heading',
      attrs: { level: Number(heading[1]) },
      content: inlineChildrenToPm(node.content ?? []),
    };
  }
  switch (node.nodeType) {
    case 'paragraph':
      return { type: 'paragraph', content: inlineChildrenToPm(node.content ?? []) };
    case 'code-block': {
      const text = (node.content ?? []).map((c) => c.value ?? '').join('');
      return {
        type: 'codeBlock',
        attrs: { language: (node.data?.language as string | null) ?? null },
        content: text ? [{ type: 'text', text }] : [],
      };
    }
    case 'hr':
      return { type: 'horizontalRule' };
    default: {
      const container = BLOCK_CONTAINERS[node.nodeType];
      if (container) {
        const isList = container === 'bulletList' || container === 'orderedList';
        return {
          type: container,
          content: blockChildrenToPm(node.content ?? [], isList ? 'list' : undefined),
        };
      }
      const embed = EMBED_TO_PM[node.nodeType];
      if (embed) return { type: embed, attrs: { targetId: node.data?.target?.id ?? '' } };
      return { type: 'unknownBlock', attrs: { raw: node } };
    }
  }
}

function inlineChildrenToPm(nodes: readonly RichTextNode[]): PmNode[] {
  return nodes.flatMap(inlineToPm);
}

function inlineToPm(node: RichTextNode): PmNode[] {
  switch (node.nodeType) {
    case 'text': {
      if (!node.value) return [];
      let marks = (node.marks ?? [])
        .map((m) => MARK_TO_PM[m.type])
        .filter((t): t is string => t !== undefined)
        .map((type) => ({ type }));
      // ProseMirror's code mark excludes all others; keep code, drop the rest.
      if (marks.length > 1 && marks.some((m) => m.type === 'code')) {
        marks = [{ type: 'code' }];
      }
      return [{ type: 'text', text: node.value, ...(marks.length > 0 ? { marks } : {}) }];
    }
    case 'hard-break':
      return [{ type: 'hardBreak' }];
    case 'hyperlink': {
      const href = typeof node.data?.uri === 'string' ? node.data.uri : '';
      // hardBreak carries the link mark too so the node stays one run on the
      // way back (only atoms like unknownInline are left unmarked). The code
      // mark excludes link, so it yields (losing the URI would be worse).
      return (node.content ?? []).flatMap((child) =>
        inlineToPm(child).map((pm) =>
          pm.type === 'text' || pm.type === 'hardBreak'
            ? {
                ...pm,
                marks: [
                  ...(pm.marks ?? []).filter((m) => m.type !== 'code'),
                  { type: 'link', attrs: { href } },
                ],
              }
            : pm,
        ),
      );
    }
    default:
      return [{ type: 'unknownInline', attrs: { raw: node } }];
  }
}

// ---------------------------------------------------------------------------
// Tiptap → Stored
// ---------------------------------------------------------------------------

/**
 * Converts the editor's ProseMirror doc back into a stored rich-text document,
 * or `undefined` when it holds no content (matches the form's empty-value drop).
 */
export function toDocument(json: PmNode): RichTextDocument | undefined {
  const content = (json.content ?? []).flatMap(pmToBlock);
  const isEmpty = content.every(
    (n) => n.nodeType === 'paragraph' && (n.content?.length ?? 0) === 0,
  );
  if (content.length === 0 || isEmpty) return undefined;
  return { nodeType: 'document', content };
}

function pmToBlock(node: PmNode): RichTextNode[] {
  switch (node.type) {
    case 'paragraph':
      return [{ nodeType: 'paragraph', content: pmInlineChildren(node.content ?? []) }];
    case 'heading': {
      const level = typeof node.attrs?.level === 'number' ? node.attrs.level : 1;
      return [{ nodeType: `heading-${level}`, content: pmInlineChildren(node.content ?? []) }];
    }
    case 'codeBlock': {
      const text = (node.content ?? []).map((c) => c.text ?? '').join('');
      const language = node.attrs?.language;
      return [
        {
          nodeType: 'code-block',
          content: [{ nodeType: 'text', value: text, marks: [] }],
          ...(typeof language === 'string' && language ? { data: { language } } : {}),
        },
      ];
    }
    case 'horizontalRule':
      return [{ nodeType: 'hr', content: [] }];
    case 'unknownBlock':
      return node.attrs?.raw ? [node.attrs.raw as RichTextNode] : [];
    default: {
      const container = PM_CONTAINERS[node.type];
      if (container) {
        return [{ nodeType: container, content: (node.content ?? []).flatMap(pmToBlock) }];
      }
      const embed = PM_TO_EMBED[node.type];
      if (embed) {
        const id = typeof node.attrs?.targetId === 'string' ? node.attrs.targetId : '';
        if (!id) return [];
        return [
          {
            nodeType: embed.nodeType,
            data: { target: { id, linkType: embed.linkType } },
            content: [],
          },
        ];
      }
      // Unrecognized editor node: preserve nothing rather than invent structure.
      return [];
    }
  }
}

/** Maps inline content, grouping same-href link runs back into hyperlink nodes. */
function pmInlineChildren(nodes: PmNode[]): RichTextNode[] {
  const out: RichTextNode[] = [];
  let run: RichTextNode[] = [];
  let runHref: string | undefined;
  const flushRun = () => {
    if (runHref !== undefined && run.length > 0) {
      out.push({ nodeType: 'hyperlink', data: { uri: runHref }, content: run });
    }
    run = [];
    runHref = undefined;
  };
  for (const node of nodes) {
    const link = node.marks?.find((m) => m.type === 'link');
    const href = link && typeof link.attrs?.href === 'string' ? link.attrs.href : undefined;
    const mapped = pmToInline(node, href !== undefined);
    if (href !== undefined) {
      if (href !== runHref) flushRun();
      runHref = href;
      run.push(...mapped);
    } else {
      flushRun();
      out.push(...mapped);
    }
  }
  flushRun();
  return out;
}

function pmToInline(node: PmNode, stripLink: boolean): RichTextNode[] {
  switch (node.type) {
    case 'text': {
      if (!node.text) return [];
      const marks = (node.marks ?? [])
        .filter((m) => !(stripLink && m.type === 'link'))
        .map((m) => PM_TO_MARK[m.type])
        .filter((t): t is string => t !== undefined)
        .map((type) => ({ type }));
      return [{ nodeType: 'text', value: node.text, marks }];
    }
    case 'hardBreak':
      return [{ nodeType: 'hard-break' }];
    case 'unknownInline':
      return node.attrs?.raw ? [node.attrs.raw as RichTextNode] : [];
    default:
      return [];
  }
}
