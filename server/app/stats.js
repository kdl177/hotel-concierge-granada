/**
 * Usage statistics. The guest app sends anonymous events (no personal data:
 * no room, no name, no device id) in small batches; the admin panel reads
 * aggregates together with request metrics.
 *
 *   POST /api/h/:slug/events  { events: [{ kind, ref }], lang }
 *   GET  /api/admin/stats?days=30
 */
const KINDS = new Set(['open', 'view_poi', 'route', 'guide', 'search', 'action', 'service', 'chat_open']);

export function createStats({ db }) {
  const ins = db.prepare('INSERT INTO events (hotel_id, kind, ref, lang) VALUES (?,?,?,?)');
  const perIp = new Map();

  function mount(app, { hotelBySlug, admin }) {
    app.post('/h/:slug/events', (req, res) => {
      const h = hotelBySlug.get(req.params.slug);
      if (!h) return res.status(404).end();
      const ip = req.ip || 'x';
      const now = Date.now();
      const slot = perIp.get(ip) || { t: now, n: 0 };
      if (now - slot.t > 60_000) Object.assign(slot, { t: now, n: 0 });
      const list = Array.isArray(req.body?.events) ? req.body.events.slice(0, 50) : [];
      slot.n += list.length;
      perIp.set(ip, slot);
      if (slot.n > 300) return res.status(429).end();
      const lang = ['es', 'en', 'fr', 'de'].includes(req.body?.lang) ? req.body.lang : '';
      for (const e of list) if (KINDS.has(e?.kind)) ins.run(h.id, e.kind, String(e.ref ?? '').slice(0, 60), lang);
      res.status(204).end();
    });

    app.get('/admin/stats', admin, (req, res) => {
      const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
      const since = `-${days} days`;
      const H = req.hotelId;
      const one = (sql, ...a) => db.prepare(sql).get(H, since, ...a);
      const all = (sql, ...a) => db.prepare(sql).all(H, since, ...a);

      const opens = one(`SELECT COUNT(*) n FROM events WHERE hotel_id = ? AND at >= datetime('now', ?) AND kind = 'open'`).n;
      const req_ = one(`SELECT COUNT(*) n,
          SUM(status = 'confirmed' OR status = 'done') ok,
          SUM(status = 'rejected') ko,
          SUM(status = 'pending') pend
        FROM requests WHERE hotel_id = ? AND created_at >= datetime('now', ?)`);
      // Response time = first staff action (status change, note or chat reply).
      const resp = all(`SELECT (julianday(COALESCE(r.first_response_at,
            (SELECT MIN(e.at) FROM request_events e WHERE e.request_id = r.id AND e.event IN ('status','note')))) - julianday(r.created_at)) * 1440 AS mins
          FROM requests r WHERE r.hotel_id = ? AND r.created_at >= datetime('now', ?)`)
        .map((r) => r.mins)
        .filter((m) => Number.isFinite(m) && m >= 0)
        .sort((a, b) => a - b);
      const median = resp.length ? resp[Math.floor(resp.length / 2)] : null;

      const byType = all(`SELECT type k, COUNT(*) n FROM requests WHERE hotel_id = ? AND created_at >= datetime('now', ?) GROUP BY type ORDER BY n DESC`);
      // Hours in the hotel's local time are approximated with the server's localtime modifier.
      const byHour = all(`SELECT CAST(strftime('%H', created_at, 'localtime') AS INTEGER) k, COUNT(*) n FROM requests WHERE hotel_id = ? AND created_at >= datetime('now', ?) GROUP BY k`);
      const byDay = all(`SELECT date(created_at, 'localtime') k, COUNT(*) n FROM requests WHERE hotel_id = ? AND created_at >= datetime('now', ?) GROUP BY k ORDER BY k`);
      const opensByDay = all(`SELECT date(at, 'localtime') k, COUNT(*) n FROM events WHERE hotel_id = ? AND at >= datetime('now', ?) AND kind = 'open' GROUP BY k ORDER BY k`);
      const topPois = all(`SELECT ref k, COUNT(*) n FROM events WHERE hotel_id = ? AND at >= datetime('now', ?) AND kind = 'view_poi' GROUP BY ref ORDER BY n DESC LIMIT 10`);
      const routeModes = all(`SELECT ref k, COUNT(*) n FROM events WHERE hotel_id = ? AND at >= datetime('now', ?) AND kind = 'route' GROUP BY ref ORDER BY n DESC`);
      const langs = all(`SELECT lang k, COUNT(*) n FROM events WHERE hotel_id = ? AND at >= datetime('now', ?) AND kind = 'open' AND lang != '' GROUP BY lang ORDER BY n DESC`);
      const searches = all(`SELECT lower(ref) k, COUNT(*) n FROM events WHERE hotel_id = ? AND at >= datetime('now', ?) AND kind = 'search' GROUP BY lower(ref) ORDER BY n DESC LIMIT 10`);
      const chats = one(`SELECT COUNT(DISTINCT conv_key) n FROM messages WHERE hotel_id = ? AND created_at >= datetime('now', ?) AND author = 'guest'`).n;

      const hours = Array.from({ length: 24 }, (_, i) => ({ k: i, n: byHour.find((x) => x.k === i)?.n || 0 }));
      res.json({
        days,
        kpis: { opens, requests: req_.n || 0, confirmed: req_.ok || 0, rejected: req_.ko || 0, pending: req_.pend || 0, medianResponseMin: median, chats },
        byType,
        byHour: hours,
        byDay,
        opensByDay,
        topPois,
        routeModes,
        langs,
        searches,
      });
    });
  }
  return { mount };
}
