/**
 * Guest ↔ reception chat. One conversation per guest device (a random key the
 * guest app keeps in localStorage). Requests made from that device post
 * system messages into the same conversation, so reception and guest see one
 * timeline: "new request", "confirmed", staff notes and free chat.
 *
 *   Guest:  GET  /api/h/:slug/chat?key=&after=     POST /api/h/:slug/chat { key, room, name, body, requestId }
 *   Staff:  GET  /api/staff/chats                   GET  /api/staff/chats/:key?after=
 *           POST /api/staff/chats/:key { body, requestId }
 */
const KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_BODY = 1000;

export function createChat({ db }) {
  const upsertConv = db.prepare(`INSERT INTO conversations (key, hotel_id, room, guest_name, stay_id, lang) VALUES (?,?,?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET room = COALESCE(NULLIF(excluded.room,''), room), guest_name = COALESCE(NULLIF(excluded.guest_name,''), guest_name),
      stay_id = COALESCE(excluded.stay_id, stay_id), lang = excluded.lang`);
  const getConv = db.prepare('SELECT * FROM conversations WHERE key = ? AND hotel_id = ?');
  const insertMsg = db.prepare('INSERT INTO messages (conv_key, hotel_id, author, user_id, request_id, body) VALUES (?,?,?,?,?,?)');
  const touch = {
    guest: db.prepare(`UPDATE conversations SET last_at = datetime('now'), unread_staff = unread_staff + 1 WHERE key = ?`),
    staff: db.prepare(`UPDATE conversations SET last_at = datetime('now'), unread_guest = unread_guest + 1 WHERE key = ?`),
    system: db.prepare(`UPDATE conversations SET last_at = datetime('now'), unread_guest = unread_guest + 1 WHERE key = ?`),
  };
  const recent = new Map(); // key -> timestamps (anti-flood)

  const validKey = (k) => KEY_RE.test(String(k || ''));

  function ensure({ key, hotelId, room = '', name = '', stayId = null, lang = 'es' }) {
    if (!validKey(key)) return null;
    const existing = db.prepare('SELECT hotel_id FROM conversations WHERE key = ?').get(key);
    if (existing && existing.hotel_id !== hotelId) return null; // keys never cross hotels
    upsertConv.run(key, hotelId, String(room).slice(0, 12), String(name).slice(0, 80), stayId, lang);
    return getConv.get(key, hotelId);
  }

  function post({ key, hotelId, author, userId = null, requestId = null, body }) {
    const text = String(body ?? '').trim().slice(0, MAX_BODY);
    if (!text) return null;
    const info = insertMsg.run(key, hotelId, author, userId, requestId, text);
    touch[author].run(key);
    return info.lastInsertRowid;
  }

  function allowed(key) {
    const now = Date.now();
    const list = (recent.get(key) || []).filter((t) => now - t < 60_000);
    if (list.length >= 20) return false;
    list.push(now);
    recent.set(key, list);
    return true;
  }

  function messagesFor(key, after = 0) {
    return db
      .prepare(`SELECT m.*, u.name AS user_name FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.conv_key = ? AND m.id > ? ORDER BY m.id LIMIT 300`)
      .all(key, Number(after) || 0)
      .map((m) => ({ id: m.id, author: m.author, staffName: m.author === 'staff' ? m.user_name || '' : '', requestId: m.request_id, body: m.body, at: m.created_at }));
  }

  /** Mount routes. `hotelBySlug`, `staff` middleware and helpers come from the main API. */
  function mount(app, { hotelBySlug, staff }) {
    app.get('/h/:slug/chat', (req, res) => {
      const h = hotelBySlug.get(req.params.slug);
      if (!h) return res.status(404).json({ error: 'hotel not found' });
      const key = String(req.query.key || '');
      if (!validKey(key)) return res.status(400).json({ error: 'invalid key' });
      const conv = getConv.get(key, h.id);
      if (!conv) return res.json({ messages: [], unread: 0 });
      const messages = messagesFor(key, req.query.after);
      const unread = conv.unread_guest;
      if (req.query.read === '1' && unread) db.prepare('UPDATE conversations SET unread_guest = 0 WHERE key = ?').run(key);
      res.json({ messages, unread });
    });

    app.post('/h/:slug/chat', (req, res) => {
      const h = hotelBySlug.get(req.params.slug);
      if (!h) return res.status(404).json({ error: 'hotel not found' });
      const b = req.body || {};
      if (!allowed(b.key)) return res.status(429).json({ error: 'too many messages' });
      const conv = ensure({ key: b.key, hotelId: h.id, room: b.room, name: b.name, lang: b.lang });
      if (!conv) return res.status(400).json({ error: 'invalid key' });
      const requestId = b.requestId ? db.prepare('SELECT id FROM requests WHERE id = ? AND guest_key = ?').get(String(b.requestId), b.key)?.id || null : null;
      const id = post({ key: b.key, hotelId: h.id, author: 'guest', requestId, body: b.body });
      if (!id) return res.status(400).json({ error: 'empty message' });
      res.status(201).json({ messages: messagesFor(b.key, Number(id) - 1) });
    });

    app.get('/staff/chats', staff, (req, res) => {
      const rows = db
        .prepare(
          `SELECT c.*, (SELECT body FROM messages m WHERE m.conv_key = c.key ORDER BY m.id DESC LIMIT 1) AS last_body,
                  (SELECT author FROM messages m WHERE m.conv_key = c.key ORDER BY m.id DESC LIMIT 1) AS last_author
           FROM conversations c WHERE c.hotel_id = ? AND EXISTS (SELECT 1 FROM messages m WHERE m.conv_key = c.key)
           ORDER BY c.last_at DESC LIMIT 200`,
        )
        .all(req.hotelId);
      const unread = rows.reduce((n, c) => n + (c.unread_staff ? 1 : 0), 0);
      res.json({
        unread,
        chats: rows.map((c) => ({ key: c.key, room: c.room, guestName: c.guest_name, lang: c.lang, unread: c.unread_staff, lastAt: c.last_at, lastBody: c.last_body, lastAuthor: c.last_author })),
      });
    });

    app.get('/staff/chats/:key', staff, (req, res) => {
      const conv = getConv.get(req.params.key, req.hotelId);
      if (!conv) return res.status(404).json({ error: 'not found' });
      if (conv.unread_staff) db.prepare('UPDATE conversations SET unread_staff = 0 WHERE key = ?').run(conv.key);
      const requests = db.prepare('SELECT id, type, status, when_at, details FROM requests WHERE guest_key = ? ORDER BY created_at DESC LIMIT 20').all(conv.key);
      res.json({
        chat: { key: conv.key, room: conv.room, guestName: conv.guest_name, lang: conv.lang },
        messages: messagesFor(conv.key, req.query.after),
        requests: requests.map((r) => ({ id: r.id, type: r.type, status: r.status, when: r.when_at, details: r.details })),
      });
    });

    app.post('/staff/chats/:key', staff, (req, res) => {
      const conv = getConv.get(req.params.key, req.hotelId);
      if (!conv) return res.status(404).json({ error: 'not found' });
      const requestId = req.body?.requestId ? db.prepare('SELECT id FROM requests WHERE id = ? AND hotel_id = ?').get(String(req.body.requestId), req.hotelId)?.id || null : null;
      const id = post({ key: conv.key, hotelId: req.hotelId, author: 'staff', userId: req.user.id, requestId, body: req.body?.body });
      if (!id) return res.status(400).json({ error: 'empty message' });
      markFirstResponse(requestId);
      res.status(201).json({ messages: messagesFor(conv.key, Number(id) - 1) });
    });
  }

  function markFirstResponse(requestId) {
    if (requestId) db.prepare(`UPDATE requests SET first_response_at = COALESCE(first_response_at, datetime('now')) WHERE id = ?`).run(requestId);
  }

  return { mount, ensure, post, validKey, markFirstResponse };
}
