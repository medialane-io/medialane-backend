export interface EmailLayoutInput {
  content: string;
  footer: string;
}

export function emailLayout({ content, footer }: EmailLayoutInput): string {
  return `
    <div style="max-width:480px;margin:0 auto;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111827;">
      <div style="text-align:center;padding-bottom:28px;">
        <img src="https://medialane.io/medialane-light-logo.png" alt="Medialane" height="28" style="height:28px;" />
      </div>
      ${content}
      <p style="text-align:center;color:#9ca3af;font-size:12px;margin-top:28px;">
        ${footer}
      </p>
    </div>
  `;
}

export const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
