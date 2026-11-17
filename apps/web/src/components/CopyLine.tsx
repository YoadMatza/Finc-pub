import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';

/** A command or address to copy: left-to-right whatever the page direction, selectable, with Copy where the browser allows it. */
export function CopyLine({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);
  // the clipboard API needs a secure context; over plain http the text stays selectable
  const canCopy = typeof navigator !== 'undefined' && !!navigator.clipboard;
  return (
    <div className="flex items-center gap-2">
      <code className="num flex-1 min-w-0 break-all select-all rounded-lg border border-border px-2 py-1 text-xs text-start" dir="ltr">
        {text}
      </code>
      {canCopy && (
        <button
          className="btn btn-sm shrink-0"
          onClick={() => {
            navigator.clipboard.writeText(text).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? t('mcp_copied') : t('mcp_copy')}
        </button>
      )}
    </div>
  );
}
