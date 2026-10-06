import { ExternalLink, Paperclip } from 'lucide-react';
import { useState } from 'react';
import { Tabs } from '@/components/ui/tabs';

export type PreviewEmail = {
  from: string;
  to: string[];
  subject: string;
  date: string;
  text: string;
  html: string;
  links: string[];
  attachments: { filename: string; contentType: string; size: number }[];
};

/**
 * An email with HTML / text / links tabs. HTML is shown in a fully sandboxed iframe (no scripts, no same-origin
 * access, no forms), so an email cannot run code inside StepForge.
 */
export function EmailPreview({ email, height = 360 }: { email: PreviewEmail; height?: number }) {
  const [tab, setTab] = useState<'html' | 'text' | 'links'>(email.html ? 'html' : 'text');
  return (
    <div className="space-y-2" data-testid="email-preview">
      <div className="space-y-0.5 text-sm">
        <p className="font-medium">{email.subject || '(no subject)'}</p>
        <p className="text-xs text-muted">
          From <span className="text-fg">{email.from}</span> to {email.to.join(', ')} ·{' '}
          {new Date(email.date).toLocaleString()}
        </p>
        {email.attachments.length > 0 && (
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <Paperclip className="h-3 w-3" />
            {email.attachments.map((a) => `${a.filename} (${Math.ceil(a.size / 1024)} KB)`).join(' · ')}
          </p>
        )}
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ...(email.html ? [{ value: 'html' as const, label: 'HTML' }] : []),
          { value: 'text', label: 'Text' },
          { value: 'links', label: 'Links', count: email.links.length },
        ]}
      />
      {tab === 'html' && (
        <iframe
          title={`Email: ${email.subject}`}
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={`<style>body{font-family:system-ui,sans-serif;font-size:14px;color:#111;background:#fff;margin:12px}</style>${email.html}`}
          className="w-full rounded-lg border border-border bg-white"
          style={{ height }}
        />
      )}
      {tab === 'text' && (
        <pre
          className="overflow-auto rounded-lg border border-border bg-bg p-3 font-mono text-xs whitespace-pre-wrap"
          style={{ maxHeight: height }}
        >
          {email.text || '(no text part)'}
        </pre>
      )}
      {tab === 'links' && (
        <ul className="space-y-1 text-xs">
          {email.links.map((l) => (
            <li key={l} className="flex items-center gap-1.5 font-mono break-all">
              <ExternalLink className="h-3 w-3 shrink-0 text-muted" />
              {l}
            </li>
          ))}
          {email.links.length === 0 && <li className="text-muted">No links.</li>}
        </ul>
      )}
    </div>
  );
}
