import { toDocument, toTiptap } from '@/lib/rich-text-mapper';
import type { RichTextDocument } from '@cw/domain';
import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useRef } from 'react';
import type { Pickers } from './EntryForm.js';
import { RichTextPickersContext } from './rich-text/EmbedNodeView.js';
import { Toolbar } from './rich-text/Toolbar.js';
import { buildExtensions } from './rich-text/extensions.js';

/**
 * Rich-text editor backed by Tiptap (MIT core). The stored document format is
 * unchanged — `@/lib/rich-text-mapper` converts to/from ProseMirror JSON, so
 * embeds keep registering `data.target` links in the reference graph.
 */
export function RichTextEditor(props: {
  id?: string;
  value: unknown;
  pickers: Pickers;
  onChange: (value: RichTextDocument | undefined) => void;
}) {
  // The last document we emitted (seeded with the mounted value); used to tell
  // external value changes apart from the echo of our own onChange (avoids a
  // setContent feedback loop).
  const lastEmitted = useRef(props.value as RichTextDocument | undefined);

  const editor = useEditor({
    extensions: buildExtensions(),
    content: toTiptap(props.value),
    editorProps: {
      attributes: {
        class: 'rich-text-editor min-h-32 px-3 py-2 text-sm focus:outline-none',
        role: 'textbox',
        'aria-multiline': 'true',
      },
    },
    onUpdate: ({ editor: e }) => {
      const doc = toDocument(e.getJSON());
      lastEmitted.current = doc;
      props.onChange(doc);
    },
  });

  useEffect(() => {
    if (!editor) return;
    if (props.value === lastEmitted.current) return;
    if (JSON.stringify(props.value) === JSON.stringify(lastEmitted.current)) return;
    editor.commands.setContent(toTiptap(props.value), { emitUpdate: false });
    lastEmitted.current = props.value as RichTextDocument | undefined;
  }, [editor, props.value]);

  return (
    <RichTextPickersContext.Provider value={props.pickers}>
      <div className="rounded-lg border bg-card" id={props.id}>
        {editor && <Toolbar editor={editor} />}
        <EditorContent editor={editor} />
      </div>
    </RichTextPickersContext.Provider>
  );
}
