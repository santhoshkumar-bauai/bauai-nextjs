import type { Locale } from "@/i18n/config";

const copy = {
  en: {
    subject: "Reset your BAU AI password",
    eyebrow: "Password reset",
    title: "Choose a new password",
    body: "We received a request to reset the password for your BAU AI account. Pick a new password to get back into your workspace.",
    button: "Reset password",
    expiry:
      "This reset link expires in one hour and can be used once. If you didn't request a reset, you can safely ignore this email — your password stays unchanged.",
  },
  de: {
    subject: "Setzen Sie Ihr BAU AI Passwort zurück",
    eyebrow: "Passwort zurücksetzen",
    title: "Neues Passwort wählen",
    body: "Wir haben eine Anfrage erhalten, das Passwort für Ihr BAU AI Konto zurückzusetzen. Wählen Sie ein neues Passwort, um wieder auf Ihren Workspace zuzugreifen.",
    button: "Passwort zurücksetzen",
    expiry:
      "Dieser Link läuft in einer Stunde ab und kann nur einmal verwendet werden. Falls Sie kein neues Passwort angefordert haben, können Sie diese E-Mail ignorieren — Ihr Passwort bleibt unverändert.",
  },
} as const;

function escapeHtml(value: string) {
  return value.replace(
    /[&<>'"]/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&#39;",
        '"': "&quot;",
      })[character]!,
  );
}

export function resetPasswordEmail({
  locale,
  name,
  resetUrl,
}: {
  locale: Locale;
  name: string;
  resetUrl: string;
}) {
  const message = copy[locale];
  const safeName = escapeHtml(name);
  const safeUrl = escapeHtml(resetUrl);

  return {
    subject: message.subject,
    text: `${message.title}\n\n${message.body}\n\n${message.button}: ${resetUrl}\n\n${message.expiry}`,
    html: `<!doctype html>
      <html><body style="margin:0;background:#f5f3f7;font-family:Inter,Arial,sans-serif;color:#191724">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="padding:40px 16px;background:#f5f3f7"><tr><td align="center">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:560px;background:#ffffff;border:1px solid #e8e1ed;border-radius:18px;overflow:hidden">
            <tr><td style="height:8px;background:linear-gradient(90deg,#5000a8,#8d22ea)"></td></tr>
            <tr><td style="padding:40px">
              <div style="font-size:20px;font-weight:800;color:#5000a8;letter-spacing:-.04em">BAU AI</div>
              <p style="margin:36px 0 8px;color:#7d3bc0;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase">${message.eyebrow}</p>
              <h1 style="margin:0 0 16px;font-size:28px;line-height:1.2;letter-spacing:-.04em">${message.title}</h1>
              <p style="margin:0 0 12px;font-size:15px;line-height:1.7">${safeName},</p>
              <p style="margin:0 0 28px;color:#615b69;font-size:15px;line-height:1.7">${message.body}</p>
              <a href="${safeUrl}" style="display:inline-block;padding:14px 24px;background:#5000a8;color:#ffffff;text-decoration:none;border-radius:10px;font-size:14px;font-weight:700">${message.button}</a>
              <p style="margin:30px 0 0;color:#918b98;font-size:12px;line-height:1.6">${message.expiry}</p>
            </td></tr>
          </table>
        </td></tr></table>
      </body></html>`,
  };
}
