/**
 * Outbound notifications for guest requests: per-hotel webhook (n8n, Make,
 * Slack…), global webhook (CONCIERGE_WEBHOOK_URL) and optional e-mail
 * (SMTP_URL + hotel notify_email). Fire-and-forget; failures are logged.
 */
export function createNotifier({ fetchImpl = (...a) => fetch(...a), env = process.env } = {}) {
  let mailer = null;
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

  async function post(url, payload) {
    try {
      await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    } catch (error) {
      console.warn('[concierge] webhook failed:', url, error?.message || error);
    }
  }

  const TYPE_LABEL = { spa: 'Spa / masaje', table: 'Mesa', breakfast: 'Desayuno', taxi: 'Taxi', latecheckout: 'Late check-out', housekeeping: 'Limpieza', parking: 'Parking', flamenco: 'Flamenco', tickets: 'Entradas', reception: 'Recepción', other: 'Otro' };

  function send({ event, hotel, hotelRow, request }) {
    const payload = { event, hotel: { id: hotel.id, slug: hotel.slug, name: hotel.name }, request };
    if (hotelRow?.webhook_url) post(hotelRow.webhook_url, payload);
    if (env.CONCIERGE_WEBHOOK_URL) post(env.CONCIERGE_WEBHOOK_URL, payload);
    if (event === 'created' && hotelRow?.notify_email && env.SMTP_URL) {
      getMailer().then((m) => {
        if (!m) return;
        m.sendMail({
          from: env.SMTP_FROM || 'concierge@hotel.local',
          to: hotelRow.notify_email,
          subject: `[${hotel.name}] Nueva solicitud · hab. ${request.room} · ${TYPE_LABEL[request.type] || request.type}`,
          text: `Habitación ${request.room}${request.name ? ` (${request.name})` : ''}\nTipo: ${TYPE_LABEL[request.type] || request.type}\nCuándo: ${request.when || '-'}\nDetalles: ${request.details || '-'}\n\nGestiónala en la pantalla de recepción.`,
        }).catch((e) => console.warn('[concierge] mail failed:', e?.message));
      });
    }
  }
  return { send };
}
