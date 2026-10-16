// patcheri.onrender.com-ის Node/Express სერვერზე: ატვირთვის მარშრუტამდე ჩასვი ეს middleware.
// Render > Environment: TICKET_SECRET = იგივე, რაც Cloudflare worker-ზე.
const crypto = require('crypto');

function verifyTicket(req, res, next) {
  const ticket = (req.body && req.body.ticket) || req.query.ticket || '';   // multer-ის შემდეგ req.body.ticket
  const [p, sig] = String(ticket).split('.');
  if (!p || !sig) return res.status(401).json({ error: 'ticket_required' });
  const want = crypto.createHmac('sha256', process.env.TICKET_SECRET).update(p).digest('hex');
  const a = Buffer.from(want), b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'bad_ticket' });
  const t = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  if (t.exp < Date.now()) return res.status(401).json({ error: 'ticket_expired' });
  req.ticket = t;   // { uid, jid, preset, maxH, maxFps } -> ffmpeg-ში გამოიყენე maxH/maxFps-ზე მეტის გარეშე
  next();
}
// გამოყენება:  app.post('/api/optimize', upload.single('file'), verifyTicket, handler)
//  - დაიცავი preset: render მხოლოდ req.ticket.maxH / req.ticket.maxFps-მდე
//  - ერთი ბილეთი = ერთი job (შეინახე t.jid გამოყენებულებში, რომ ხელახლა ვერ გამოიყენონ)
module.exports = { verifyTicket };
