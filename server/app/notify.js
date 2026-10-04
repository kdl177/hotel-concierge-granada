/**
 * Outbound notifications: per-hotel webhook (n8n, Make, Slack…), global
 * webhook (CONCIERGE_WEBHOOK_URL) and e-mail (SMTP_URL) for new requests and
 * password-recovery links. Fire-and-forget; failures are logged.
 * Webhook targets are re-checked right before each call (SSRF / DNS rebinding).
 */
import { checkWebhookUrl } from './security.js';

export function createNotifier({ fetchImpl = (...a) => fetch(...a), env = process.env, mailer: injected } = {}) {
  let mailer = injected ?? null;
  const production = env.NODE_ENV === 'production';
  async function getMailer() {
    if (mailer !== null || !env.SMTP_URL) return mailer;
    try {
      const nodemailer = await import('nodemailer');
      mailer = nodemailer.default.createTransport(env.SMTP_URL);
    } catch (error) {
      console.warn('[concierge] nodemailer unavailable:', error?.message);
      mailer = false;
    }
    return mailer;
  }
  const canMail = () => !!(injected || env.SMTP_URL);

  async function post(url, payload, { trusted = false } = {}) {
    try {
      if (!trusted) {
        const check = await checkWebhookUrl(url, { production });
        if (!check.ok) return console.warn('[concierge] webhook refused:', check.error);
      }
      await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(8000) });
    } catch (error) {
      console.warn('[concierge] webhook failed:', error?.message || error);
    }
  }

  function mail({ to, subject, text }) {
    return getMailer().then((m) => {
      if (!m) return false;
      return m.sendMail({ from: env.SMTP_FROM || 'concierge@hotel.local', to, subject, text }).then(
        () => true,
        (e) => (console.warn('[concierge] mail failed:', e?.message), false),
      );
    });
  }

  const TYPE_LABEL = { spa: 'Spa / masaje', table: 'Mesa', breakfast: 'Desayuno', taxi: 'Taxi', latecheckout: 'Late check-out', housekeeping: 'Limpieza', parking: 'Parking', flamenco: 'Flamenco', tickets: 'Entradas', reception: 'Recepción', wakeup: 'Despertador', other: 'Otro' };

  function send({ event, hotel, hotelRow, request }) {
    const payload = { event, hotel: { id: hotel.id, slug: hotel.slug, name: hotel.name }, request };
    if (hotelRow?.webhook_url) post(hotelRow.webhook_url, payload);
    // The global webhook is set by the operator in .env, so it is trusted (may be on the LAN).
    if (env.CONCIERGE_WEBHOOK_URL) post(env.CONCIERGE_WEBHOOK_URL, payload, { trusted: true });
    if (event === 'created' && hotelRow?.notify_email && canMail()) {
      mail({
        to: hotelRow.notify_email,
        subject: `[${hotel.name}] Nueva solicitud · hab. ${request.room} · ${TYPE_LABEL[request.type] || request.type}`,
        text: `Habitación ${request.room}${request.name ? ` (${request.name})` : ''}\nTipo: ${TYPE_LABEL[request.type] || request.type}\nCuándo: ${request.when || '-'}\nDetalles: ${request.details || '-'}\n\nGestiónala en la pantalla de recepción.`,
      });
    }
  }
  return { send, mail, canMail };
}
