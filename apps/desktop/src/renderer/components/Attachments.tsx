import { Paperclip, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import { Button } from './ui/button.tsx';

export interface Attached {
  file: File;
  /** An object URL, for images: shown as a thumbnail. */
  preview?: string;
}

/** Upload a file to the core; it keeps it under attachments/ and returns where. */
export async function uploadAttachment(file: File): Promise<string> {
  const r = await api<{ path: string }>(`/api/attachments?name=${encodeURIComponent(file.name || 'pasted.png')}`, { raw: file });
  return r.path;
}

/**
 * Files added to a message: pasted (screenshots) or picked. Render `button` next to the send button and `list` above
 * the box, and pass `paste` to the textarea's onPaste.
 */
export function useAttachments() {
  const [items, setItems] = useState<Attached[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const add = (files: File[]) =>
    setItems((xs) => [...xs, ...files.map((file) => ({ file, preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined }))]);
  const remove = (i: number) =>
    setItems((xs) => {
      if (xs[i]?.preview) URL.revokeObjectURL(xs[i]!.preview!);
      return xs.filter((_, k) => k !== i);
    });
  const clear = () =>
    setItems((xs) => {
      for (const x of xs) if (x.preview) URL.revokeObjectURL(x.preview);
      return [];
    });
  const paste = (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.items].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f): f is File => !!f);
    if (!files.length) return;
    e.preventDefault();
    add(files);
  };
  const button = (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          add([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
      <Button size="icon" variant="ghost" type="button" title="Attach Files" onClick={() => input.current?.click()}>
        <Paperclip />
      </Button>
    </>
  );
  const list = items.length ? (
    <div className="flex flex-wrap gap-1.5">
      {items.map((x, i) => (
        <div key={i} className="group relative">
          {x.preview ? (
            <img src={x.preview} alt={x.file.name} className="h-14 rounded-md border border-line" />
          ) : (
            <div className="flex h-14 max-w-48 items-center gap-1.5 rounded-md border border-line bg-hover/40 px-2 text-xs">
              <Paperclip className="size-3.5 shrink-0 text-muted" />
              <span className="truncate">{x.file.name}</span>
            </div>
          )}
          <button
            type="button"
            title="Remove"
            onClick={() => remove(i)}
            className="absolute -top-1.5 -right-1.5 flex size-4 cursor-pointer items-center justify-center rounded-full bg-ink text-panel opacity-0 group-hover:opacity-100"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  ) : null;
  return { items, clear, paste, button, list };
}
