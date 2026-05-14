const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');

// Prevent silent crashes that would wipe the in-memory session store.
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});

const app = express();
const CANONICAL_HOST = 'hummatch.me';
const PORT = process.env.PORT || 3000;
const BUILD_VERSION = process.env.BUILD_VERSION || '2.0.0';
const ADMIN_KEY = process.env.ADMIN_API_KEY || (() => {
  console.warn('WARNING: ADMIN_API_KEY not set. Admin endpoints will be inaccessible.');
  return require('crypto').randomUUID();
})();
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripe = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;

// ---------------------------------------------------------------------------
// Email (ZeptoMail SMTP for campaigns, Zoho Mail SMTP as fallback)
// ---------------------------------------------------------------------------
const ZEPTO_USER = process.env.ZEPTOMAIL_USER || 'emailapikey';
const ZEPTO_PASS = process.env.ZEPTOMAIL_PASS || '';
const EMAIL_USER = process.env.HUMMATCH_EMAIL_USER || '';
const EMAIL_PASS = process.env.HUMMATCH_EMAIL_PASS || '';
const EMAIL_FROM = process.env.HUMMATCH_EMAIL_FROM || 'joe@hummatch.me';
const { scoreResultsById: scoreRideResultsForEmail } = require('./src/sessionManager');

const emailTransporter = ZEPTO_PASS
  ? nodemailer.createTransport({
      host: 'smtp.zeptomail.com',
      port: 465,
      secure: true,
      auth: { user: ZEPTO_USER, pass: ZEPTO_PASS }
    })
  : (EMAIL_USER && EMAIL_PASS
    ? nodemailer.createTransport({
        host: 'smtp.zoho.com',
        port: 465,
        secure: true,
        auth: { user: EMAIL_USER, pass: EMAIL_PASS }
      })
    : null);

async function sendEmail(to, subject, html) {
  if (!emailTransporter) {
    console.warn('Email not configured — skipping send to', to);
    return false;
  }
  try {
    await emailTransporter.sendMail({
      from: `"Joe from HumMatch" <${EMAIL_FROM}>`,
      to,
      subject,
      html
    });
    console.log(`Email sent: "${subject}" → ${to}`);
    return true;
  } catch (err) {
    console.error(`Email send failed (${to}):`, err.message);
    return false;
  }
}

// Guarded welcome email — only sends once per user, checks DB flag every time
function trySendWelcomeEmail(userId, email) {
  const row = db.prepare('SELECT welcome_email_sent FROM users WHERE id = ?').get(userId);
  if (row && row.welcome_email_sent) {
    console.log(`Welcome email already sent to ${email} (user ${userId}) — skipping`);
    return;
  }
  console.log(`Sending welcome email to ${email} (user ${userId})`);
  db.prepare('UPDATE users SET welcome_email_sent = 1 WHERE id = ?').run(userId);
  sendEmail(email, 'Welcome to HumMatch!', emailWelcome(email));
}

// ---------------------------------------------------------------------------
// Email Templates
// ---------------------------------------------------------------------------
const EMAIL_FOOTER = `
  <div style="margin-top:32px;padding-top:20px;border-top:1px solid rgba(124,58,237,0.2);">
    <p style="margin:0;color:#e2e0f0;">Joe</p>
    <p style="margin:4px 0 0;color:rgba(255,255,255,0.5);font-size:13px;">HumMatch &mdash; Find songs you can actually nail</p>
    <p style="margin:8px 0 0;"><a href="https://hummatch.me" style="color:#A855F7;text-decoration:none;font-size:13px;">hummatch.me</a></p>
  </div>
`;

function emailWrapper(content) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0d0b1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:32px 24px;">
    <div style="text-align:center;margin-bottom:28px;">
      <span style="font-size:28px;font-weight:700;background:linear-gradient(135deg,#A855F7,#EC4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">HumMatch</span>
    </div>
    <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(124,58,237,0.12);border-radius:14px;padding:28px 24px;color:#e2e0f0;font-size:15px;line-height:1.6;">
      ${content}
      ${EMAIL_FOOTER}
    </div>
    <p style="text-align:center;color:rgba(255,255,255,0.3);font-size:11px;margin-top:20px;">
      &copy; ${new Date().getFullYear()} HumMatch. You received this because you signed up at hummatch.me.
    </p>
  </div>
</body></html>`;
}

function emailPlaylistSaved(songs, shareUrl) {
  const songRows = songs.slice(0, 20).map((s, i) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid rgba(124,58,237,0.08);color:rgba(255,255,255,0.4);font-size:13px;">${i + 1}</td>
      <td style="padding:8px 12px;border-bottom:1px solid rgba(124,58,237,0.08);">
        <strong style="color:#e2e0f0;">${s.song_title}</strong><br>
        <span style="color:rgba(255,255,255,0.5);font-size:13px;">${s.artist}</span>
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid rgba(124,58,237,0.08);text-align:right;">
        <span style="background:${s.confidence >= 80 ? 'rgba(34,197,94,0.15);color:#22c55e' : s.confidence >= 60 ? 'rgba(234,179,8,0.15);color:#eab308' : 'rgba(239,68,68,0.15);color:#ef4444'};padding:3px 10px;border-radius:20px;font-size:13px;font-weight:600;">${s.confidence}%</span>
      </td>
    </tr>
  `).join('');

  return emailWrapper(`
    <h2 style="margin:0 0 8px;color:#e2e0f0;font-size:20px;">Your HumMatch Playlist is Ready! 🎤</h2>
    <p style="color:rgba(255,255,255,0.6);margin:0 0 20px;">Here are your top matched songs based on your voice:</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
      <thead>
        <tr style="border-bottom:2px solid rgba(124,58,237,0.2);">
          <th style="padding:8px 12px;text-align:left;color:rgba(255,255,255,0.4);font-size:12px;text-transform:uppercase;">#</th>
          <th style="padding:8px 12px;text-align:left;color:rgba(255,255,255,0.4);font-size:12px;text-transform:uppercase;">Song</th>
          <th style="padding:8px 12px;text-align:right;color:rgba(255,255,255,0.4);font-size:12px;text-transform:uppercase;">Match</th>
        </tr>
      </thead>
      <tbody>${songRows}</tbody>
    </table>
    ${songs.length > 20 ? `<p style="color:rgba(255,255,255,0.4);font-size:13px;text-align:center;">+ ${songs.length - 20} more songs in your full playlist</p>` : ''}
    <div style="text-align:center;margin:24px 0 16px;">
      <a href="${shareUrl}" style="display:inline-block;padding:12px 32px;background:linear-gradient(135deg,#A855F7,#EC4899);color:#fff;text-decoration:none;border-radius:12px;font-weight:600;font-size:15px;">View Full Playlist</a>
    </div>
    <p style="color:rgba(255,255,255,0.4);font-size:13px;text-align:center;">Share this link with friends: <a href="${shareUrl}" style="color:#A855F7;">${shareUrl}</a></p>
  `);
}

function emailWelcome(email) {
  return emailWrapper(`
    <h2 style="margin:0 0 8px;color:#e2e0f0;font-size:20px;">Welcome to HumMatch!</h2>
    <p style="color:rgba(255,255,255,0.6);margin:0 0 20px;">Hey there! You're all set to find songs that match your voice.</p>
    <h3 style="color:#A855F7;font-size:15px;margin:0 0 12px;">How to get started:</h3>
    <ol style="color:#e2e0f0;padding-left:20px;margin:0 0 20px;">
      <li style="margin-bottom:8px;">Hit the <strong>Start Humming</strong> button on the main page</li>
      <li style="margin-bottom:8px;">Tap to start, hum for 3 seconds, tap to stop. Repeat 3 times (different pitches work best!)</li>
      <li style="margin-bottom:8px;">We'll match your voice to songs you'll actually sound great singing</li>
      <li style="margin-bottom:8px;">Save your favorites to your playlist</li>
    </ol>
    <h3 style="color:#A855F7;font-size:15px;margin:0 0 12px;">Pro tips:</h3>
    <ul style="color:rgba(255,255,255,0.6);padding-left:20px;margin:0 0 20px;">
      <li style="margin-bottom:6px;">Hum in a quiet room for best results</li>
      <li style="margin-bottom:6px;">Try different pitches &mdash; you might be surprised!</li>
      <li style="margin-bottom:6px;">Use headphones to avoid mic feedback</li>
    </ul>
    <div style="text-align:center;margin:24px 0 16px;">
      <a href="https://hummatch.me/dashboard" style="display:inline-block;padding:12px 32px;background:linear-gradient(135deg,#A855F7,#EC4899);color:#fff;text-decoration:none;border-radius:12px;font-weight:600;font-size:15px;">Go to Your Dashboard</a>
    </div>
  `);
}

function emailSquadLeader(email) {
  return emailWrapper(`
    <h2 style="margin:0 0 8px;color:#e2e0f0;font-size:20px;">Welcome to Squad Leader! 🎖️</h2>
    <p style="color:rgba(255,255,255,0.6);margin:0 0 20px;">You've just unlocked the full HumMatch experience. Here's what's new:</p>
    <div style="margin-bottom:20px;">
      <div style="display:flex;align-items:flex-start;margin-bottom:12px;">
        <span style="color:#A855F7;font-size:18px;margin-right:10px;">✦</span>
        <div><strong style="color:#e2e0f0;">Unlimited SquadMatch</strong><br><span style="color:rgba(255,255,255,0.5);font-size:13px;">No member limits &mdash; invite your whole crew</span></div>
      </div>
      <div style="display:flex;align-items:flex-start;margin-bottom:12px;">
        <span style="color:#A855F7;font-size:18px;margin-right:10px;">✦</span>
        <div><strong style="color:#e2e0f0;">Song Requests</strong><br><span style="color:rgba(255,255,255,0.5);font-size:13px;">Request any song to be added to our catalog</span></div>
      </div>
      <div style="display:flex;align-items:flex-start;margin-bottom:12px;">
        <span style="color:#A855F7;font-size:18px;margin-right:10px;">✦</span>
        <div><strong style="color:#e2e0f0;">Friend Codes</strong><br><span style="color:rgba(255,255,255,0.5);font-size:13px;">Share exclusive invite codes (5/month)</span></div>
      </div>
      <div style="display:flex;align-items:flex-start;margin-bottom:12px;">
        <span style="color:#A855F7;font-size:18px;margin-right:10px;">✦</span>
        <div><strong style="color:#e2e0f0;">Priority Support</strong><br><span style="color:rgba(255,255,255,0.5);font-size:13px;">Get help faster when you need it</span></div>
      </div>
    </div>
    <h3 style="color:#A855F7;font-size:15px;margin:0 0 12px;">Create your first SquadMatch:</h3>
    <ol style="color:#e2e0f0;padding-left:20px;margin:0 0 20px;">
      <li style="margin-bottom:8px;">Go to your Dashboard</li>
      <li style="margin-bottom:8px;">Click <strong>SquadMatch</strong> in the sidebar</li>
      <li style="margin-bottom:8px;">Create a new session and invite friends</li>
      <li style="margin-bottom:8px;">Everyone hums &mdash; find songs you can all sing together!</li>
    </ol>
    <div style="text-align:center;margin:24px 0 16px;">
      <a href="https://hummatch.me/dashboard" style="display:inline-block;padding:12px 32px;background:linear-gradient(135deg,#A855F7,#EC4899);color:#fff;text-decoration:none;border-radius:12px;font-weight:600;font-size:15px;">Go to Dashboard</a>
    </div>
  `);
}

function emailGroupMatchWaitlist(email) {
  return emailWrapper(`
    <h2 style="margin:0 0 8px;color:#e2e0f0;font-size:20px;">You're on the GroupMatch Waitlist!</h2>
    <p style="color:rgba(255,255,255,0.6);margin:0 0 20px;">Thanks for signing up &mdash; we're excited to have you.</p>
    <h3 style="color:#A855F7;font-size:15px;margin:0 0 12px;">What is GroupMatch?</h3>
    <p style="color:rgba(255,255,255,0.6);margin:0 0 20px;">
      GroupMatch connects you with other singers in your area for group karaoke sessions.
      We'll match you based on voice type, location, and music taste.
    </p>
    <h3 style="color:#A855F7;font-size:15px;margin:0 0 12px;">What to expect:</h3>
    <ul style="color:rgba(255,255,255,0.6);padding-left:20px;margin:0 0 20px;">
      <li style="margin-bottom:6px;">You'll be among the <strong style="color:#e2e0f0;">first to get access</strong> when we launch</li>
      <li style="margin-bottom:6px;">We'll email you with launch details and early access info</li>
      <li style="margin-bottom:6px;">In the meantime, keep humming to build your playlist!</li>
    </ul>
    <div style="text-align:center;margin:24px 0 16px;">
      <a href="https://hummatch.me" style="display:inline-block;padding:12px 32px;background:linear-gradient(135deg,#A855F7,#EC4899);color:#fff;text-decoration:none;border-radius:12px;font-weight:600;font-size:15px;">Back to HumMatch</a>
    </div>
  `);
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(cors());
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: false
}));
app.use(morgan('short'));

// Stripe webhook needs raw body — must be registered before express.json
app.post('/api/hummatch/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe) return res.status(501).json({ error: 'Stripe not configured' });
  let event;
  try {
    if (STRIPE_WEBHOOK_SECRET) {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
    } else {
      event = JSON.parse(req.body);
    }
  } catch (err) {
    console.error('Stripe webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = (session.customer_email || (session.customer_details && session.customer_details.email) || '').toLowerCase();
    if (email) {
      const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      let userId;
      if (user) {
        db.prepare("UPDATE users SET is_premium = 1, updated_at = datetime('now') WHERE id = ?").run(user.id);
        userId = user.id;
        console.log(`Stripe webhook: upgraded ${email} to premium`);
        sendEmail(email, 'Welcome to Squad Leader!', emailSquadLeader(email));
      } else {
        const newToken = uuidv4();
        const result = db.prepare('INSERT INTO users (email, token, is_premium, month_key) VALUES (?, ?, 1, ?)').run(email, newToken, monthKey());
        userId = result.lastInsertRowid;
        console.log(`Stripe webhook: created premium account for ${email}`);
        sendEmail(email, 'Welcome to Squad Leader!', emailSquadLeader(email));
      }
      
      // Track discount code usage if present
      if (session.metadata && session.metadata.discount_code) {
        const discountCode = db.prepare('SELECT id FROM discount_codes WHERE code = ?').get(session.metadata.discount_code);
        if (discountCode) {
          const amountCents = session.amount_total || 0;
          db.prepare('INSERT INTO discount_code_uses (code_id, user_id, stripe_session_id, amount_cents) VALUES (?, ?, ?, ?)').run(
            discountCode.id, userId, session.id, amountCents
          );
          db.prepare('UPDATE discount_codes SET uses_count = uses_count + 1 WHERE id = ?').run(discountCode.id);
          console.log(`Stripe webhook: tracked discount code ${session.metadata.discount_code} for ${email}`);
        }
      }

      // Stage 8: ride-originated conversion tracking
      if (session.metadata && session.metadata.ride_discount_code) {
        try {
          const rideCode = db.prepare('SELECT * FROM ride_discount_codes WHERE code = ?').get(session.metadata.ride_discount_code);
          if (rideCode) {
            db.prepare(`
              UPDATE ride_discount_codes
                 SET used_by_email = ?, used_at = datetime('now'), stripe_session_id = ?, is_active = 0
               WHERE code = ?
            `).run(email, session.id, rideCode.code);

            if (rideCode.affiliate_code) {
              try {
                db.prepare(
                  'INSERT INTO affiliate_conversions (affiliate_code, user_id, event_type, commission_amount) VALUES (?, ?, ?, 0)'
                ).run(rideCode.affiliate_code, userId || null, 'ride_originated_conversion');
              } catch (_) { /* non-fatal */ }
            }

            db.prepare(`
              UPDATE ride_sessions
                 SET commission_eligible = 1,
                     commission_basis_cents = ?,
                     conversion_completed_at = datetime('now')
               WHERE session_id = ?
            `).run(session.amount_total || 0, rideCode.ride_session_id);

            try {
              db.prepare(`
                UPDATE ride_reminders
                   SET conversion_completed_at = datetime('now')
                 WHERE discount_code = ?
              `).run(rideCode.code);
            } catch (_) { /* non-fatal */ }

            console.log('[ride-mode] ride-originated conversion recorded for session', rideCode.ride_session_id);
          }
        } catch (e) {
          console.error('[ride-mode] ride conversion webhook error:', e.message);
        }
      }
    }
  }
  res.json({ received: true });
});

app.use(express.json({ limit: '1mb' }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});
const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many submissions, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ---------------------------------------------------------------------------
// SQLite database (file-based, persists across restarts)
// ---------------------------------------------------------------------------
const DB_PATH = process.env.DB_PATH || path.join('/data', 'hummatch.db');

// Ensure database directory exists
const fs = require('fs');
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
  console.log(`[startup] Created database directory: ${dbDir}`);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL,
    lang TEXT DEFAULT 'en',
    data TEXT DEFAULT '{}',
    ip TEXT,
    user_agent TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    token TEXT UNIQUE NOT NULL,
    is_premium INTEGER DEFAULT 0,
    playlist TEXT DEFAULT '[]',
    hum_count INTEGER DEFAULT 0,
    export_count INTEGER DEFAULT 0,
    month_key TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    welcome_email_sent INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS geo (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lat REAL,
    lng REAL,
    city TEXT,
    country TEXT,
    cnt INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS contact_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT,
    message TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    song_title TEXT,
    artist TEXT,
    confidence INTEGER,
    genre TEXT,
    song_key TEXT,
    voice_type TEXT,
    language TEXT DEFAULT 'en',
    matched_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS hum_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    song_title TEXT,
    artist TEXT,
    confidence INTEGER,
    hummed_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS hums (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    low_note INTEGER,
    normal_note INTEGER,
    high_note INTEGER,
    voice_type TEXT,
    top_song TEXT,
    top_artist TEXT,
    match_score INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS squad_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER,
    squad_name TEXT DEFAULT 'My SquadMatch',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(owner_user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS squad_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    squad_id INTEGER,
    user_id INTEGER,
    display_name TEXT,
    voice_type TEXT,
    status TEXT DEFAULT 'pending',
    joined_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(squad_id) REFERENCES squad_matches(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS discount_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    squad_leader_id INTEGER NOT NULL,
    discount_percent INTEGER DEFAULT 20,
    max_uses INTEGER DEFAULT 999,
    uses_count INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    deactivated_at TEXT,
    FOREIGN KEY(squad_leader_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS discount_code_uses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code_id INTEGER NOT NULL,
    user_id INTEGER,
    stripe_session_id TEXT,
    amount_cents INTEGER,
    used_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(code_id) REFERENCES discount_codes(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS squad_leader_code_quota (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    month_key TEXT NOT NULL,
    codes_generated INTEGER DEFAULT 0,
    max_codes INTEGER DEFAULT 5,
    UNIQUE(user_id, month_key),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS song_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    song_title TEXT,
    artist TEXT,
    notes TEXT,
    status TEXT DEFAULT 'pending',
    admin_notes TEXT,
    requested_at TEXT DEFAULT (datetime('now')),
    reviewed_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS affiliates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    affiliate_code TEXT UNIQUE NOT NULL,
    venue_name TEXT,
    city TEXT,
    payout_method TEXT,
    total_scans INTEGER DEFAULT 0,
    total_signups INTEGER DEFAULT 0,
    total_hums INTEGER DEFAULT 0,
    total_premium_conversions INTEGER DEFAULT 0,
    lifetime_commission REAL DEFAULT 0,
    pending_payout REAL DEFAULT 0,
    last_payout_date TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    welcome_email_sent INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS affiliate_conversions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    affiliate_code TEXT NOT NULL,
    user_id INTEGER,
    event_type TEXT NOT NULL,
    commission_amount REAL DEFAULT 0,
    commission_paid INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(affiliate_code) REFERENCES affiliates(affiliate_code),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS friend_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    code TEXT UNIQUE NOT NULL,
    used_by_email TEXT,
    converted INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS friend_code_tracker (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE,
    codes_issued INTEGER DEFAULT 0,
    reset_date TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS groupmatch_waitlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    zip_code TEXT,
    voice_type TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS songs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    lo INTEGER NOT NULL,
    hi INTEGER NOT NULL,
    brightness INTEGER DEFAULT 50,
    year INTEGER,
    language TEXT DEFAULT 'en',
    slug TEXT UNIQUE NOT NULL,
    popularity INTEGER DEFAULT 0,
    hum_match_score INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
  CREATE INDEX IF NOT EXISTS idx_events_event ON events(event);
  CREATE INDEX IF NOT EXISTS idx_users_token ON users(token);
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_playlists_user ON user_playlists(user_id);
  CREATE INDEX IF NOT EXISTS idx_hum_history_user ON hum_history(user_id);
  CREATE INDEX IF NOT EXISTS idx_hums_user ON hums(user_id);
  CREATE INDEX IF NOT EXISTS idx_squad_owner ON squad_matches(owner_user_id);
  CREATE INDEX IF NOT EXISTS idx_squad_members_squad ON squad_members(squad_id);
  CREATE INDEX IF NOT EXISTS idx_song_requests_user ON song_requests(user_id);
  CREATE INDEX IF NOT EXISTS idx_friend_codes_user ON friend_codes(user_id);
  CREATE INDEX IF NOT EXISTS idx_friend_codes_code ON friend_codes(code);
  CREATE INDEX IF NOT EXISTS idx_groupmatch_waitlist_email ON groupmatch_waitlist(email);

  CREATE TABLE IF NOT EXISTS shared_playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email TEXT NOT NULL,
    songs TEXT DEFAULT '[]',
    share_token TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_shared_playlists_token ON shared_playlists(share_token);
`);

// Add zip_code column to users if missing (migration for existing DBs)
try {
  db.exec(`ALTER TABLE users ADD COLUMN zip_code TEXT`);
} catch (_) { /* column already exists */ }

// Add welcome_email_sent column to users if missing (migration for existing DBs)
try {
  db.exec(`ALTER TABLE users ADD COLUMN welcome_email_sent INTEGER DEFAULT 0`);
  console.log('[migration] Added welcome_email_sent column to users table');
} catch (_) {
  console.log('[migration] welcome_email_sent column already exists — OK');
}

// Add password_hash column to users if missing (migration for existing DBs)
try {
  db.exec(`ALTER TABLE users ADD COLUMN password_hash TEXT`);
  console.log('[migration] Added password_hash column to users table');
} catch (_) {
  console.log('[migration] password_hash column already exists — OK');
}

// Add username column to users (for public profiles)
try {
  db.exec(`ALTER TABLE users ADD COLUMN username TEXT UNIQUE`);
  console.log('[migration] Added username column to users table');
} catch (_) {
  console.log('[migration] username column already exists — OK');
}

// Create user_profiles table for public musical profiles
db.exec(`
  CREATE TABLE IF NOT EXISTS user_profiles (
    user_id INTEGER PRIMARY KEY,
    display_name TEXT,
    bio TEXT,
    profile_photo_url TEXT,
    voice_type TEXT,
    range_low INTEGER,
    range_high INTEGER,
    is_public INTEGER DEFAULT 1,
    profile_views INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// Create hum_friends table for musical social network
db.exec(`
  CREATE TABLE IF NOT EXISTS hum_friends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    friend_id INTEGER NOT NULL,
    status TEXT DEFAULT 'accepted',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, friend_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (friend_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_hum_friends_user ON hum_friends(user_id);
  CREATE INDEX IF NOT EXISTS idx_hum_friends_friend ON hum_friends(friend_id);
`);

console.log('[migration] Profile system tables ready');

// Add popularity columns to songs table
try {
  db.exec(`ALTER TABLE songs ADD COLUMN popularity INTEGER DEFAULT 0`);
  console.log('[migration] Added popularity column to songs table');
} catch (_) {
  console.log('[migration] popularity column already exists — OK');
}

try {
  db.exec(`ALTER TABLE songs ADD COLUMN hum_match_score INTEGER DEFAULT 0`);
  console.log('[migration] Added hum_match_score column to songs table');
} catch (_) {
  console.log('[migration] hum_match_score column already exists — OK');
}

// SquadMatch viral loop migrations
try { db.exec(`ALTER TABLE squad_matches ADD COLUMN invite_token TEXT`); } catch(_){}
try { db.exec(`ALTER TABLE squad_matches ADD COLUMN status TEXT DEFAULT 'active'`); } catch(_){}
try { db.exec(`ALTER TABLE squad_matches ADD COLUMN best_song TEXT`); } catch(_){}
try { db.exec(`ALTER TABLE squad_matches ADD COLUMN best_artist TEXT`); } catch(_){}
try { db.exec(`ALTER TABLE squad_matches ADD COLUMN shared_songs TEXT DEFAULT '[]'`); } catch(_){}
try { db.exec(`ALTER TABLE squad_matches ADD COLUMN voted_name TEXT`); } catch(_){}
try { db.exec(`ALTER TABLE squad_members ADD COLUMN songs_json TEXT DEFAULT '[]'`); } catch(_){}
try { db.exec(`ALTER TABLE squad_members ADD COLUMN hum_done INTEGER DEFAULT 0`); } catch(_){}
try { db.exec(`ALTER TABLE squad_members ADD COLUMN voice_low INTEGER`); } catch(_){}
try { db.exec(`ALTER TABLE squad_members ADD COLUMN voice_high INTEGER`); } catch(_){}
db.exec(`CREATE TABLE IF NOT EXISTS squad_name_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  squad_id INTEGER,
  member_id INTEGER,
  voted_name TEXT,
  voted_at TEXT DEFAULT (datetime('now')),
  UNIQUE(squad_id, member_id)
)`);
console.log('[migration] SquadMatch viral loop tables ready');

// Stage 7: ride_sessions DB event store — durable record of Ride Mode sessions
// for affiliate/venue reporting. In-memory sessionManager remains the source of
// truth for live session state; this table only records start/end events.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ride_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      driver_user_id INTEGER,
      affiliate_code TEXT,
      vibe_preset TEXT,
      expected_rider_count INTEGER,
      actual_rider_count INTEGER DEFAULT 0,
      hum_completed_count INTEGER DEFAULT 0,
      session_status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY(driver_user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_ride_sessions_driver ON ride_sessions(driver_user_id);
    CREATE INDEX IF NOT EXISTS idx_ride_sessions_affiliate ON ride_sessions(affiliate_code);
  `);
  console.log('[migration] ride_sessions table ready');
} catch (e) {
  console.log('[migration] ride_sessions table error (non-fatal):', e.message);
}

// Stage 8: extend ride_sessions with commission/conversion columns
try { db.exec(`ALTER TABLE ride_sessions ADD COLUMN commission_eligible INTEGER DEFAULT 0`); } catch(_){}
try { db.exec(`ALTER TABLE ride_sessions ADD COLUMN commission_basis_cents INTEGER DEFAULT 0`); } catch(_){}
try { db.exec(`ALTER TABLE ride_sessions ADD COLUMN conversion_completed_at TEXT`); } catch(_){}

// Stage 8: ride-originated discount codes and reminder tracking
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ride_discount_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      ride_session_id TEXT NOT NULL,
      driver_user_id INTEGER,
      affiliate_code TEXT,
      discount_percent INTEGER DEFAULT 10,
      expires_at TEXT NOT NULL,
      used_by_email TEXT,
      used_at TEXT,
      stripe_session_id TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ride_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ride_session_id TEXT NOT NULL,
      driver_user_id INTEGER,
      affiliate_code TEXT,
      discount_code TEXT,
      discount_expires_at TEXT,
      reminder_channel TEXT NOT NULL,
      reminder_destination TEXT NOT NULL,
      reminder_sent_at TEXT,
      conversion_completed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ride_discount_session ON ride_discount_codes(ride_session_id);
    CREATE INDEX IF NOT EXISTS idx_ride_reminders_session ON ride_reminders(ride_session_id);
  `);
  console.log('[migration] ride_discount_codes and ride_reminders tables ready');
} catch (e) {
  console.log('[migration] ride_discount tables error (non-fatal):', e.message);
}

/// Backfill: any squad missing an invite_token gets a permanent one generated now
(function backfillInviteTokens() {
  const missing = db.prepare("SELECT id FROM squad_matches WHERE invite_token IS NULL OR invite_token = ''").all();
  if (missing.length === 0) return;
  const update = db.prepare('UPDATE squad_matches SET invite_token = ? WHERE id = ?');
  const fill = db.transaction(() => {
    for (const s of missing) {
      const token = require('crypto').randomBytes(5).toString('hex'); // 10-char hex
      update.run(token, s.id);
    }
  });
  fill();
  console.log(`[migration] Backfilled invite tokens for ${missing.length} squad(s)`);
})();

// ---------------------------------------------------------------------------
// Auto-import analytics backup if events table is empty (for fresh deploys)
// ---------------------------------------------------------------------------
(function autoImportEvents() {
  const count = db.prepare('SELECT COUNT(*) AS cnt FROM events').get().cnt;
  if (count > 0) return;

  const backupPath = path.join(__dirname, 'hummatch-analytics-backup.json');
  const fs = require('fs');
  if (!fs.existsSync(backupPath)) return;

  try {
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    if (!backup.events || !backup.events.length) return;

    const insert = db.prepare(
      'INSERT INTO events (event, lang, data, ip, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const importAll = db.transaction((events) => {
      for (const e of events) {
        const ts = typeof e.created_at === 'number'
          ? new Date(e.created_at * 1000).toISOString().replace('T', ' ').slice(0, 19)
          : e.created_at;
        insert.run(e.event, e.lang || 'en', e.data || '{}', e.ip || null, e.ua || null, ts);
      }
    });
    importAll(backup.events);
    console.log(`Auto-imported ${backup.events.length} analytics events from backup`);
  } catch (err) {
    console.error('Failed to auto-import analytics backup:', err.message);
  }
})();

// ---------------------------------------------------------------------------
// Auto-populate geo table from event IPs if empty (for fresh deploys)
// Uses ip-api.com batch endpoint; runs in background so it doesn't block startup
// ---------------------------------------------------------------------------
(function autoPopulateGeo() {
  const geoCount = db.prepare('SELECT COUNT(*) AS cnt FROM geo').get().cnt;
  if (geoCount > 0) return;

  const ipRows = db.prepare(
    "SELECT ip, COUNT(*) as cnt FROM events WHERE ip IS NOT NULL AND ip != '' GROUP BY ip"
  ).all();
  if (ipRows.length === 0) return;

  console.log(`Geo table empty — geocoding ${ipRows.length} unique IPs in background…`);

  const ipCounts = {};
  for (const r of ipRows) ipCounts[r.ip] = r.cnt;
  const allIps = Object.keys(ipCounts);

  const BATCH_SIZE = 100;
  const RATE_LIMIT_MS = Math.ceil(60000 / 45); // 45 req/min free tier

  (async () => {
    const insertGeo = db.prepare(
      'INSERT INTO geo (lat, lng, city, country, cnt) VALUES (?, ?, ?, ?, ?)'
    );
    const insertAll = db.transaction((rows) => {
      for (const g of rows) insertGeo.run(g.lat, g.lng, g.city, g.country, g.cnt);
    });

    const perIpResults = [];
    let resolved = 0, failed = 0;

    for (let i = 0; i < allIps.length; i += BATCH_SIZE) {
      const batch = allIps.slice(i, i + BATCH_SIZE);
      try {
        const res = await fetch('http://ip-api.com/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(batch.map(ip => ({ query: ip, fields: 'status,lat,lon,city,country,query' }))),
        });
        const results = await res.json();
        for (const r of results) {
          if (r.status === 'success' && r.lat && r.lon) {
            perIpResults.push({ lat: r.lat, lng: r.lon, city: r.city || 'Unknown', country: r.country || 'Unknown', cnt: ipCounts[r.query] || 1 });
            resolved++;
          } else { failed++; }
        }
      } catch (err) {
        console.error(`  Geo batch failed:`, err.message);
        failed += batch.length;
      }
      if (i + BATCH_SIZE < allIps.length) await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
    }

    // Cluster by city+country to reduce map pins
    const cityMap = {};
    for (const r of perIpResults) {
      const key = `${r.city}|${r.country}`;
      if (!cityMap[key]) {
        cityMap[key] = { lat: r.lat, lng: r.lng, city: r.city, country: r.country, cnt: 0 };
      }
      cityMap[key].cnt += r.cnt;
    }
    const geoResults = Object.values(cityMap);

    if (geoResults.length > 0) insertAll(geoResults);
    console.log(`Auto-populated geo table: ${resolved} IPs resolved → ${geoResults.length} city clusters, ${failed} failed`);
  })().catch(err => console.error('Geo auto-populate failed:', err.message));
})();

// Prepared statements for performance
const stmts = {
  insertEvent: db.prepare(
    'INSERT INTO events (event, lang, data, ip, user_agent) VALUES (?, ?, ?, ?, ?)'
  ),
  insertUser: db.prepare(
    'INSERT INTO users (email, token, month_key, password_hash) VALUES (?, ?, ?, ?)'
  ),
  getUserByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  getUserByToken: db.prepare('SELECT * FROM users WHERE token = ?'),
  syncUser: db.prepare(
    `UPDATE users SET playlist = ?, hum_count = COALESCE(?, hum_count),
     export_count = COALESCE(?, export_count), updated_at = datetime('now') WHERE token = ?`
  ),
  insertContact: db.prepare(
    'INSERT INTO contact_messages (name, email, message) VALUES (?, ?, ?)'
  ),
  insertGeo: db.prepare(
    'INSERT INTO geo (lat, lng, city, country) VALUES (?, ?, ?, ?)'
  ),
  // Dashboard tables
  insertPlaylistSong: db.prepare(
    'INSERT INTO user_playlists (user_id, song_title, artist, confidence, genre, song_key, voice_type, language) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ),
  getPlaylist: db.prepare(
    'SELECT * FROM user_playlists WHERE user_id = ? ORDER BY matched_at DESC'
  ),
  deletePlaylistSong: db.prepare(
    'DELETE FROM user_playlists WHERE id = ? AND user_id = ?'
  ),
  insertHumHistory: db.prepare(
    'INSERT INTO hum_history (user_id, song_title, artist, confidence) VALUES (?, ?, ?, ?)'
  ),
  getHumHistory: db.prepare(
    'SELECT * FROM hum_history WHERE user_id = ? ORDER BY hummed_at DESC LIMIT 10'
  ),
  getHumCount: db.prepare(
    'SELECT COUNT(*) as cnt FROM hum_history WHERE user_id = ?'
  ),
  getWeekHumCount: db.prepare(
    `SELECT COUNT(*) as cnt FROM hum_history WHERE user_id = ? AND hummed_at >= datetime('now', '-7 days')`
  ),
  getBestMatch: db.prepare(
    'SELECT MAX(confidence) as best FROM hum_history WHERE user_id = ?'
  ),
  insertHumSession: db.prepare(
    'INSERT INTO hums (user_id, low_note, normal_note, high_note, voice_type, top_song, top_artist, match_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ),
  getRecentHumSessions: db.prepare(
    'SELECT * FROM hums WHERE user_id = ? ORDER BY created_at DESC LIMIT 10'
  ),
  // Squad
  insertSquad: db.prepare(
    'INSERT INTO squad_matches (owner_user_id, squad_name) VALUES (?, ?)'
  ),
  getSquads: db.prepare(
    'SELECT * FROM squad_matches WHERE owner_user_id = ?'
  ),
  insertSquadMember: db.prepare(
    'INSERT INTO squad_members (squad_id, user_id, display_name, voice_type, status) VALUES (?, ?, ?, ?, ?)'
  ),
  getSquadMembers: db.prepare(
    'SELECT * FROM squad_members WHERE squad_id = ?'
  ),
  updateSquadMemberStatus: db.prepare(
    'UPDATE squad_members SET status = ? WHERE id = ?'
  ),
  getSquadById: db.prepare('SELECT * FROM squad_matches WHERE id = ?'),
  getSquadByToken: db.prepare('SELECT * FROM squad_matches WHERE invite_token = ?'),
  // Song requests
  insertSongRequest: db.prepare(
    'INSERT INTO song_requests (user_id, song_title, artist, notes) VALUES (?, ?, ?, ?)'
  ),
  getSongRequests: db.prepare(
    'SELECT * FROM song_requests WHERE user_id = ? ORDER BY requested_at DESC'
  ),
  // Friend codes
  insertFriendCode: db.prepare(
    'INSERT INTO friend_codes (user_id, code) VALUES (?, ?)'
  ),
  getFriendCodes: db.prepare(
    'SELECT * FROM friend_codes WHERE user_id = ? ORDER BY created_at DESC'
  ),
  getCodeTracker: db.prepare(
    'SELECT * FROM friend_code_tracker WHERE user_id = ?'
  ),
  upsertCodeTracker: db.prepare(
    `INSERT INTO friend_code_tracker (user_id, codes_issued, reset_date) VALUES (?, 1, ?)
     ON CONFLICT(user_id) DO UPDATE SET codes_issued = codes_issued + 1`
  ),
  resetCodeTracker: db.prepare(
    'UPDATE friend_code_tracker SET codes_issued = 0, reset_date = ? WHERE user_id = ?'
  ),
  // GroupMatch waitlist
  insertWaitlist: db.prepare(
    'INSERT INTO groupmatch_waitlist (email, zip_code, voice_type) VALUES (?, ?, ?)'
  ),
  getWaitlistByEmail: db.prepare(
    'SELECT id FROM groupmatch_waitlist WHERE email = ?'
  ),
  updateUserZip: db.prepare(
    `UPDATE users SET zip_code = ?, updated_at = datetime('now') WHERE id = ?`
  ),
  // Shared playlists
  insertSharedPlaylist: db.prepare(
    'INSERT INTO shared_playlists (user_email, songs, share_token) VALUES (?, ?, ?)'
  ),
  getSharedPlaylist: db.prepare(
    'SELECT * FROM shared_playlists WHERE share_token = ?'
  )
};

// ---------------------------------------------------------------------------
// Helper: get current month key (YYYY-MM)
// ---------------------------------------------------------------------------
function monthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Helper: admin auth middleware
// ---------------------------------------------------------------------------
function requireAdmin(req, res, next) {
  const key = req.headers['x-reactr-api-key'] || req.headers['x-admin-key'] || req.query.key;
  const adminKey = process.env.HUMMATCH_ADMIN_KEY || '';
  if (key !== ADMIN_KEY && key !== adminKey) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ---------------------------------------------------------------------------
// API: Manual migration endpoint (for fixing production DB without SSH)
// ---------------------------------------------------------------------------
app.get('/api/hummatch/migrate/welcome-email-column', requireAdmin, (req, res) => {
  try {
    const cols = db.pragma('table_info(users)').map(c => c.name);
    if (cols.includes('welcome_email_sent')) {
      return res.json({ status: 'ok', message: 'Column already exists' });
    }
    db.exec(`ALTER TABLE users ADD COLUMN welcome_email_sent INTEGER DEFAULT 0`);
    res.json({ status: 'ok', message: 'Column added successfully' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// API: Version (PWA auto-update)
// ---------------------------------------------------------------------------
app.get('/api/hummatch/version', (_req, res) => {
  res.json({ v: BUILD_VERSION });
});

// ---------------------------------------------------------------------------
// API: Event tracking
// ---------------------------------------------------------------------------
app.post('/api/hummatch/event', (req, res) => {
  const { event, lang, data } = req.body;
  if (!event) return res.status(400).json({ error: 'Missing event' });
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  const ua = req.headers['user-agent'] || '';
  try {
    stmts.insertEvent.run(event, lang || 'en', JSON.stringify(data || {}), ip, ua);
  } catch (e) {
    console.error('Event insert error:', e.message);
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// API: Auth - Register / Login
// ---------------------------------------------------------------------------
app.post('/api/hummatch/auth/register', authLimiter, async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const existing = stmts.getUserByEmail.get(email);
  if (existing) {
    return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const token = uuidv4();
    stmts.insertUser.run(email, token, monthKey(), hash);
    const newUser = stmts.getUserByEmail.get(email);
    trySendWelcomeEmail(newUser.id, email);
    return res.json({ token, email, is_premium: false, isNew: true });
  } catch (e) {
    console.error('Register error:', e.message);
    return res.status(500).json({ error: 'Registration failed' });
  }
});

// ---------------------------------------------------------------------------
// API: Auth - Login with email + password
// ---------------------------------------------------------------------------
app.post('/api/hummatch/auth/login', authLimiter, async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = stmts.getUserByEmail.get(email);
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Legacy user without password — prompt them to set one
  if (!user.password_hash) {
    return res.status(401).json({ error: 'Please set a password for your account.', needsPasswordReset: true });
  }

  try {
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    return res.json({
      token: user.token,
      email: user.email,
      is_premium: !!user.is_premium,
      isNew: false
    });
  } catch (e) {
    console.error('Login error:', e.message);
    return res.status(500).json({ error: 'Login failed' });
  }
});

// ---------------------------------------------------------------------------
// API: Auth - Set password (for legacy users who registered without one)
// ---------------------------------------------------------------------------
app.post('/api/hummatch/auth/set-password', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const user = stmts.getUserByEmail.get(email);
  if (!user) {
    return res.status(404).json({ error: 'No account found with this email' });
  }
  if (user.password_hash) {
    return res.status(400).json({ error: 'Password already set. Use login instead.' });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    db.prepare('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE email = ?').run(hash, email);
    return res.json({
      token: user.token,
      email: user.email,
      is_premium: !!user.is_premium
    });
  } catch (e) {
    console.error('Set-password error:', e.message);
    return res.status(500).json({ error: 'Failed to set password' });
  }
});

// ---------------------------------------------------------------------------
// API: Auth - Forgot password (sends magic login link via email)
// ---------------------------------------------------------------------------
app.post('/api/hummatch/auth/forgot-password', authLimiter, async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  const user = db.prepare('SELECT token, email FROM users WHERE email = ?').get(email);
  if (user) {
    const baseUrl = process.env.BASE_URL || 'https://hummatch.me';
    const loginUrl = `${baseUrl}/login?token=${encodeURIComponent(user.token)}`;
    const html = emailWrapper(`
      <div style="padding:32px 24px;">
        <h2 style="color:#e2e0f0;font-size:1.3rem;margin-bottom:8px;">Log in to HumMatch</h2>
        <p style="color:rgba(255,255,255,0.6);margin-bottom:24px;line-height:1.6;">
          Click the button below to log in instantly. This link is tied to your account — keep it private.
        </p>
        <a href="${loginUrl}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#7c3aed,#db2777);color:#fff;text-decoration:none;border-radius:12px;font-weight:700;font-size:1rem;">
          Log In to HumMatch
        </a>
        <p style="color:rgba(255,255,255,0.4);font-size:0.82rem;margin-top:20px;">
          If you didn't request this, you can safely ignore this email.
        </p>
        ${EMAIL_FOOTER}
      </div>
    `);
    sendEmail(user.email, 'Your HumMatch login link', html);
  }
  // Always return success (don't reveal if email exists)
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// API: Auth - Get current user
// ---------------------------------------------------------------------------
app.get('/api/hummatch/auth/me', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).json({ error: 'Missing token' });

  const user = stmts.getUserByToken.get(token);
  if (!user) return res.status(404).json({ error: 'User not found' });

  let playlist = [];
  try { playlist = JSON.parse(user.playlist || '[]'); } catch (_) {}

  res.json({
    email: user.email,
    is_premium: !!user.is_premium,
    playlist,
    hum_count: user.hum_count || 0,
    export_count: user.export_count || 0,
    month_key: user.month_key || monthKey(),
    zip_code: user.zip_code || ''
  });
});

// ---------------------------------------------------------------------------
// API: Auth - Sync playlist and counts
// ---------------------------------------------------------------------------
app.post('/api/hummatch/auth/sync', (req, res) => {
  const { token, playlist, hum_count, export_count } = req.body;
  if (!token) return res.status(400).json({ error: 'Missing token' });

  const user = stmts.getUserByToken.get(token);
  if (!user) return res.status(404).json({ error: 'User not found' });

  try {
    stmts.syncUser.run(
      JSON.stringify(playlist || []),
      hum_count !== undefined ? hum_count : null,
      export_count !== undefined ? export_count : null,
      token
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('Sync error:', e.message);
    res.status(500).json({ error: 'Sync failed' });
  }
});

// ---------------------------------------------------------------------------
// API: Affiliate - Instant Signup
// ---------------------------------------------------------------------------
app.post('/api/hummatch/affiliate/signup', async (req, res) => {
  try {
    const { email, venueName, city, payoutMethod } = req.body;
    
    if (!email || !venueName || !city || !payoutMethod) {
      return res.status(400).json({ error: 'All fields required' });
    }
    
    // Check if email already registered
    const existing = db.prepare('SELECT * FROM affiliates WHERE email = ?').get(email);
    if (existing) {
      return res.json({ 
        success: true, 
        affiliateCode: existing.affiliate_code,
        alreadyExists: true 
      });
    }
    
    // Generate unique affiliate code
    const cityCode = city.substring(0,3).toUpperCase().replace(/[^A-Z]/g,'X');
    const randomCode = Math.random().toString(36).substring(2,7).toUpperCase();
    const affiliateCode = `HM-${cityCode}-${randomCode}`;
    
    // Save to database
    db.prepare(`
      INSERT INTO affiliates (email, affiliate_code, venue_name, city, payout_method)
      VALUES (?, ?, ?, ?, ?)
    `).run(email, affiliateCode, venueName, city, payoutMethod);
    
    // Send welcome email with QR code
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=600x600&data=https://hummatch.me?ref=${affiliateCode}`;
    const dashboardUrl = `https://hummatch.me/affiliate/dashboard?code=${affiliateCode}`;
    
    const html = emailWrapper(`
      <div style="padding:32px 24px;">
        <h2 style="color:#e2e0f0;font-size:1.5rem;margin-bottom:8px;">Welcome to the HumMatch Affiliate Program! 🎤</h2>
        <p style="color:rgba(255,255,255,0.6);margin-bottom:24px;line-height:1.6;">
          You're all set, ${venueName}! Here's everything you need to start earning.
        </p>
        
        <div style="background:rgba(168,85,247,0.1);border:1px solid rgba(168,85,247,0.3);border-radius:12px;padding:20px;margin-bottom:24px;">
          <p style="color:rgba(255,255,255,0.5);font-size:0.85rem;margin-bottom:4px;">Your Affiliate Code</p>
          <p style="color:#a855f7;font-size:1.3rem;font-weight:800;margin:0;">${affiliateCode}</p>
        </div>
        
        <h3 style="color:#e2e0f0;font-size:1.1rem;margin:24px 0 12px;">How You Earn</h3>
        <div style="background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.3);border-radius:12px;padding:20px;margin-bottom:16px;">
          <p style="color:#4ade80;font-size:1.2rem;font-weight:800;margin:0 0 8px 0;">20% Recurring Commission</p>
          <p style="color:rgba(255,255,255,0.7);margin:0;line-height:1.6;">
            Every time someone you refer upgrades to <strong>Squad Leader</strong>, you earn <strong>20% of their subscription fee</strong> every month for as long as they stay subscribed. Build passive income one referral at a time!
          </p>
        </div>
        <p style="color:rgba(255,255,255,0.5);font-size:0.9rem;line-height:1.6;">
          <strong>Example:</strong> Refer 50 subscribers and earn recurring monthly income from their subscriptions. The more you refer, the more you earn!
        </p>
        
        <h3 style="color:#e2e0f0;font-size:1.1rem;margin:24px 0 12px;">Your QR Code</h3>
        <p style="color:rgba(255,255,255,0.6);margin-bottom:16px;">
          Download your custom QR code and display it at your venue:
        </p>
        <img src="${qrUrl}" alt="Your HumMatch QR Code" style="width:200px;height:200px;border-radius:12px;margin-bottom:16px;" />
        <br/>
        <a href="${qrUrl}" style="display:inline-block;padding:12px 24px;background:rgba(168,85,247,0.2);border:1px solid rgba(168,85,247,0.4);color:#a855f7;text-decoration:none;border-radius:10px;font-weight:700;font-size:0.9rem;margin-right:8px;">
          Download QR Code
        </a>
        <a href="${dashboardUrl}" style="display:inline-block;padding:12px 24px;background:linear-gradient(135deg,#7c3aed,#db2777);color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:0.9rem;">
          View Dashboard
        </a>
        
        <p style="color:rgba(255,255,255,0.4);font-size:0.82rem;margin-top:32px;line-height:1.6;">
          <strong>Tips for Success:</strong><br/>
          • Project the QR on screens during karaoke breaks<br/>
          • Print handouts for singers<br/>
          • Share on your venue's social media<br/>
          • Wear it on a T-shirt while KJ'ing
        </p>
        
        ${EMAIL_FOOTER}
      </div>
    `);
    
    sendEmail(email, 'Welcome to HumMatch Affiliates! 🎤', html);
    
    // Mark email as sent
    db.prepare('UPDATE affiliates SET welcome_email_sent = 1 WHERE email = ?').run(email);
    
    res.json({ 
      success: true, 
      affiliateCode,
      qrUrl,
      dashboardUrl
    });
    
  } catch (err) {
    console.error('Affiliate signup error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// API: Analytics dashboard (admin-only)
// ---------------------------------------------------------------------------
app.get('/api/hummatch/analytics', requireAdmin, (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const sinceDate = since > 0
    ? new Date(since * 1000).toISOString()
    : '1970-01-01T00:00:00.000Z';

  const total = (event, lang) => {
    let q = 'SELECT COUNT(*) as cnt FROM events WHERE event = ? AND created_at >= ?';
    const params = [event, sinceDate];
    if (lang) { q += ' AND lang = ?'; params.push(lang); }
    return db.prepare(q).get(...params).cnt;
  };

  const totalVisits = total('page_view');
  const enVisits = total('page_view', 'en');
  const esVisits = total('page_view', 'es');
  const totalHums = total('hum_complete') + total('hum_phase_complete');
  const enHums = total('hum_complete', 'en') + total('hum_phase_complete', 'en');
  const esHums = total('hum_complete', 'es') + total('hum_phase_complete', 'es');
  const totalShares = total('share');
  const pwaInstalls = total('pwa_install');
  const totalSung = total('karaoke_open');
  const monthlyPurchases = total('purchase');

  // Session duration average
  const durRow = db.prepare(`
    SELECT AVG(CAST(json_extract(data, '$.duration_sec') AS INTEGER)) as avg_dur
    FROM events WHERE event = 'session_end' AND created_at >= ?
  `).get(sinceDate);
  const avgSessionSec = durRow ? Math.round(durRow.avg_dur || 0) : 0;

  // Return visitors (IPs with > 1 page_view)
  const returnRow = db.prepare(`
    SELECT COUNT(*) as cnt FROM (
      SELECT ip FROM events WHERE event = 'page_view' AND created_at >= ?
      GROUP BY ip HAVING COUNT(*) > 1
    )
  `).get(sinceDate);
  const returnVisitors = returnRow ? returnRow.cnt : 0;

  const convRate = totalVisits > 0
    ? Math.round((totalHums / totalVisits) * 100)
    : 0;

  // Hum → Signup conversion metrics
  const anonHumCount = db.prepare(
    `SELECT COUNT(*) as cnt FROM hum_history WHERE user_id IS NULL AND hummed_at >= ?`
  ).get(sinceDate).cnt;

  const registeredHummerCount = db.prepare(
    `SELECT COUNT(DISTINCT user_id) as cnt FROM hum_history WHERE user_id IS NOT NULL AND hummed_at >= ?`
  ).get(sinceDate).cnt;

  const totalHumSessions = anonHumCount + registeredHummerCount;
  const humSignupConvRate = totalHumSessions > 0
    ? parseFloat(((registeredHummerCount / totalHumSessions) * 100).toFixed(1))
    : 0;

  // Daily anon vs registered hum breakdown for trend chart
  const humConvTrend = db.prepare(`
    SELECT DATE(hummed_at) as day,
      SUM(CASE WHEN user_id IS NULL THEN 1 ELSE 0 END) as anon_hums,
      SUM(CASE WHEN user_id IS NOT NULL THEN 1 ELSE 0 END) as registered_hums
    FROM hum_history
    WHERE hummed_at >= ?
    GROUP BY day ORDER BY day
  `).all(sinceDate);

  // Daily breakdown for charts
  const dailyRows = db.prepare(`
    SELECT DATE(created_at) as day, event, COUNT(*) as cnt
    FROM events WHERE created_at >= ?
    GROUP BY day, event ORDER BY day
  `).all(sinceDate);

  const daily = {};
  for (const r of dailyRows) {
    if (!daily[r.day]) daily[r.day] = {};
    daily[r.day][r.event] = r.cnt;
  }

  // Top songs (karaoke opens)
  const topSongs = db.prepare(`
    SELECT json_extract(data, '$.song') as song, COUNT(*) as cnt
    FROM events WHERE event = 'karaoke_open' AND created_at >= ?
    AND json_extract(data, '$.song') IS NOT NULL
    GROUP BY song ORDER BY cnt DESC LIMIT 10
  `).all(sinceDate);

  // Top referrers
  const topReferrers = db.prepare(`
    SELECT json_extract(data, '$.referrer') as ref, COUNT(*) as cnt
    FROM events WHERE event = 'page_view' AND created_at >= ?
    AND json_extract(data, '$.referrer') IS NOT NULL AND json_extract(data, '$.referrer') != ''
    GROUP BY ref ORDER BY cnt DESC LIMIT 10
  `).all(sinceDate);

  // No-match count (hums that produced zero results)
  const noMatch = db.prepare(`
    SELECT COUNT(*) as cnt FROM events
    WHERE event = 'no_match' AND created_at >= ?
  `).get(sinceDate).cnt;

  // Voice Type Distribution
  const voiceTypes = db.prepare(`
    SELECT voice_type, COUNT(*) as cnt FROM hums
    WHERE voice_type IS NOT NULL AND created_at >= ?
    GROUP BY voice_type ORDER BY cnt DESC
  `).all(sinceDate);

  // Device Breakdown (parse user_agent)
  const deviceRows = db.prepare(`
    SELECT user_agent, COUNT(*) as cnt FROM events
    WHERE event = 'page_view' AND created_at >= ? AND user_agent IS NOT NULL
    GROUP BY user_agent
  `).all(sinceDate);
  const deviceCounts = { Mobile: 0, Desktop: 0, Tablet: 0 };
  for (const r of deviceRows) {
    const ua = (r.user_agent || '').toLowerCase();
    if (/ipad|tablet/i.test(ua)) deviceCounts.Tablet += r.cnt;
    else if (/mobile|iphone|android/i.test(ua)) deviceCounts.Mobile += r.cnt;
    else deviceCounts.Desktop += r.cnt;
  }
  const devices = Object.entries(deviceCounts).map(([device, cnt]) => ({ device, cnt })).filter(d => d.cnt > 0);

  // Top Songs Matched
  const topMatched = db.prepare(`
    SELECT json_extract(data, '$.song') as song, json_extract(data, '$.artist') as artist, COUNT(*) as cnt
    FROM events WHERE event = 'song_match' AND created_at >= ?
    AND json_extract(data, '$.song') IS NOT NULL
    GROUP BY song, artist ORDER BY cnt DESC LIMIT 10
  `).all(sinceDate);

  // Top Songs Dismissed
  const topDismissed = db.prepare(`
    SELECT json_extract(data, '$.song') as song, json_extract(data, '$.artist') as artist, COUNT(*) as cnt
    FROM events WHERE event = 'song_dismiss' AND created_at >= ?
    AND json_extract(data, '$.song') IS NOT NULL
    GROUP BY song, artist ORDER BY cnt DESC LIMIT 10
  `).all(sinceDate);

  // Top Songs Exported
  const topExported = db.prepare(`
    SELECT json_extract(data, '$.song') as song, json_extract(data, '$.artist') as artist, COUNT(*) as cnt
    FROM events WHERE event = 'playlist_export' AND created_at >= ?
    AND json_extract(data, '$.song') IS NOT NULL
    GROUP BY song, artist ORDER BY cnt DESC LIMIT 10
  `).all(sinceDate);

  res.json({
    totalVisits, enVisits, esVisits,
    totalHums, enHums, esHums,
    totalShares, totalSung,
    pwaInstalls, monthlyPurchases,
    convRate, avgSessionSec, returnVisitors,
    daily, topSongs, topReferrers,
    anonHumCount, registeredHummerCount, humSignupConvRate, humConvTrend,
    voiceTypes, devices, topMatched, topDismissed, topExported
  });
});

// ---------------------------------------------------------------------------
// API: Geo data for map (admin-only)
// ---------------------------------------------------------------------------
app.get('/api/hummatch/geo', requireAdmin, (req, res) => {
  const points = db.prepare(
    'SELECT lat, lng, city, country, cnt FROM geo ORDER BY cnt DESC LIMIT 500'
  ).all();
  res.json({ points });
});

// ---------------------------------------------------------------------------
// API: Songs endpoint (for ES version / future use)
// ---------------------------------------------------------------------------
app.get('/api/hummatch/songs', (_req, res) => {
  res.json({ songs: [], note: 'Songs are loaded from inline JS. This endpoint is reserved for admin management.' });
});

// ---------------------------------------------------------------------------
// API: Contact form
// ---------------------------------------------------------------------------
app.post('/api/hummatch/contact', contactLimiter, async (req, res) => {
  const { name, email, message } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }
  try {
    stmts.insertContact.run(name || '', email || '', message.trim());
  } catch (e) {
    console.error('Contact insert error:', e.message);
    return res.status(500).json({ error: 'Failed to save message' });
  }

  // Send notification email to Joe (don't fail if email fails)
  try {
    await sendEmail(EMAIL_FROM, 'New HumMatch Contact Form Submission', `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;background:#0d0b1a;color:#e2e0f0;padding:32px;border-radius:14px;">
        <h2 style="margin:0 0 24px;background:linear-gradient(135deg,#A855F7,#EC4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">New Contact Form Submission</h2>
        <p style="margin:0 0 8px;"><strong style="color:#A855F7;">Name:</strong> ${(name || 'Not provided').replace(/</g, '&lt;')}</p>
        <p style="margin:0 0 8px;"><strong style="color:#A855F7;">Email:</strong> ${(email || 'Not provided').replace(/</g, '&lt;')}</p>
        <hr style="border:none;border-top:1px solid rgba(124,58,237,0.2);margin:16px 0;">
        <p style="margin:0;"><strong style="color:#A855F7;">Message:</strong></p>
        <p style="margin:8px 0 0;white-space:pre-wrap;">${message.trim().replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>
      </div>
    `);
  } catch (e) {
    console.error('Contact notification email error:', e.message);
  }

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Helper: auth middleware (token-based)
// ---------------------------------------------------------------------------
function requireAuth(req, res, next) {
  const token = req.headers['x-hm-token'] || req.query.token;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  const user = stmts.getUserByToken.get(token);
  if (!user) return res.status(401).json({ error: 'Invalid token' });
  req.user = user;
  next();
}

function requirePremium(req, res, next) {
  if (!req.user.is_premium) return res.status(403).json({ error: 'Squad Leader required' });
  next();
}

// ---------------------------------------------------------------------------
// API: Dashboard - Stats overview
// ---------------------------------------------------------------------------
app.get('/api/hummatch/dashboard', requireAuth, (req, res) => {
  const uid = req.user.id;
  const totalHums = stmts.getHumCount.get(uid).cnt;
  const weekHums = stmts.getWeekHumCount.get(uid).cnt;
  const bestMatch = stmts.getBestMatch.get(uid).best || 0;
  const playlist = stmts.getPlaylist.all(uid);
  const oldHums = stmts.getHumHistory.all(uid);
  // New hum sessions table — map to same shape dashboard expects
  const humSessions = stmts.getRecentHumSessions.all(uid).map(h => ({
    song_title: h.top_song,
    artist: h.top_artist,
    confidence: h.match_score,
    hummed_at: h.created_at,
    voice_type: h.voice_type
  }));
  // Merge: sessions first (newer), then old hum_history entries not already covered
  const seen = new Set(humSessions.map(h => h.song_title + '|' + h.hummed_at));
  const merged = [...humSessions, ...oldHums.filter(h => !seen.has(h.song_title + '|' + h.hummed_at))].slice(0, 10);

  res.json({
    stats: {
      totalHums: Math.max(totalHums, humSessions.length),
      weekHums,
      bestMatch,
      playlistSize: playlist.length
    },
    recentHums: merged,
    user: {
      email: req.user.email,
      is_premium: !!req.user.is_premium,
      created_at: req.user.created_at,
      zip_code: req.user.zip_code || ''
    }
  });
});

// ---------------------------------------------------------------------------
// API: Playlist CRUD
// ---------------------------------------------------------------------------
app.get('/api/hummatch/playlist', requireAuth, (req, res) => {
  const songs = stmts.getPlaylist.all(req.user.id);
  res.json({ songs });
});

app.post('/api/hummatch/playlist/add', requireAuth, (req, res) => {
  const { song_title, artist, confidence, genre, song_key, voice_type, language } = req.body;
  if (!song_title) return res.status(400).json({ error: 'Song title required' });
  try {
    const info = stmts.insertPlaylistSong.run(
      req.user.id, song_title, artist || '', confidence || 0,
      genre || '', song_key || '', voice_type || '', language || 'en'
    );
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: 'Failed to add song' });
  }
});

app.delete('/api/hummatch/playlist/:id', requireAuth, (req, res) => {
  const result = stmts.deletePlaylistSong.run(parseInt(req.params.id), req.user.id);
  res.json({ ok: true, deleted: result.changes });
});

// ---------------------------------------------------------------------------
// API: Hum History
// ---------------------------------------------------------------------------
app.post('/api/hummatch/hum', requireAuth, (req, res) => {
  const { song_title, artist, confidence } = req.body;
  if (!song_title) return res.status(400).json({ error: 'Song title required' });
  try {
    stmts.insertHumHistory.run(req.user.id, song_title, artist || '', confidence || 0);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to record hum' });
  }
});

// Log a completed hum session + sync hum_count immediately
app.post('/api/hummatch/hum/session', requireAuth, (req, res) => {
  const { low_note, normal_note, high_note, voice_type, top_song, top_artist, match_score, hum_count } = req.body;
  console.log(`[hum/session] user=${req.user.id} (${req.user.email}) song="${top_song}" score=${match_score}`);
  try {
    stmts.insertHumSession.run(
      req.user.id,
      low_note || null, normal_note || null, high_note || null,
      voice_type || '', top_song || '', top_artist || '', match_score || 0
    );
    // Also sync hum_count on the user record
    if (hum_count !== undefined) {
      db.prepare(`UPDATE users SET hum_count = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(hum_count, req.user.id);
    }
    console.log(`[hum/session] logged successfully for user ${req.user.id}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[hum/session] ERROR:', e.message, e.stack);
    res.status(500).json({ error: 'Failed to log hum session' });
  }
});

// ---------------------------------------------------------------------------
// API: SquadMatch (Free + Premium)
// ---------------------------------------------------------------------------
app.get('/api/hummatch/squad', requireAuth, (req, res) => {
  const squads = stmts.getSquads.all(req.user.id);
  const result = squads.map(s => ({
    ...s,
    session_name: s.squad_name,
    members: stmts.getSquadMembers.all(s.id)
  }));
  res.json({ squads: result });
});

app.post('/api/hummatch/squad', requireAuth, (req, res) => {
  const { squad_name, session_name, my_songs, voice_type, voice_low, voice_high } = req.body;
  const leaderName = req.user.email.split('@')[0].split('.')[0];
  const name = session_name || squad_name || `${leaderName}'s Squad`;
  try {
    const info = stmts.insertSquad.run(req.user.id, name);
    const squadId = info.lastInsertRowid;
    const inviteToken = uuidv4().replace(/-/g, '').slice(0, 10);
    db.prepare('UPDATE squad_matches SET invite_token = ? WHERE id = ?').run(inviteToken, squadId);
    // Add leader as first member with hum results
    const memInfo = stmts.insertSquadMember.run(squadId, req.user.id, leaderName, voice_type || '', 'done');
    if (my_songs && my_songs.length) {
      db.prepare('UPDATE squad_members SET songs_json = ?, hum_done = 1, voice_low = ?, voice_high = ? WHERE id = ?')
        .run(JSON.stringify(my_songs.slice(0, 20)), voice_low || null, voice_high || null, memInfo.lastInsertRowid);
    }
    res.json({ ok: true, id: squadId, session_name: name, invite_token: inviteToken });
  } catch (e) {
    console.error('[squad/create] ERROR:', e.message);
    res.status(500).json({ error: 'Failed to create squad' });
  }
});

app.post('/api/hummatch/squad/:id/invite', requireAuth, (req, res) => {
  const { display_name, voice_type } = req.body;
  const squadId = parseInt(req.params.id);

  // Free users: 2-member limit (Duet = 2 people total)
  // Premium users: 5-member limit (Squad = 5 people total)
  if (!req.user.is_premium) {
    const members = stmts.getSquadMembers.all(squadId);
    if (members.length >= 2) {
      return res.status(403).json({ error: 'Free plan allows 2 members (Duet). Upgrade to Premium for Squads up to 5!' });
    }
  } else {
    const members = stmts.getSquadMembers.all(squadId);
    if (members.length >= 5) {
      return res.status(403).json({ error: 'Squad full! Maximum 5 members.' });
    }
  }

  try {
    const info = stmts.insertSquadMember.run(squadId, null, display_name || '', voice_type || '', 'pending');
    const squad = stmts.getSquads.all(req.user.id).find(s => s.id === squadId);
    res.json({ ok: true, id: info.lastInsertRowid, session_name: squad ? squad.squad_name : '' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to invite member' });
  }
});

// Admin: look up or regenerate invite token for a squad by name
app.get('/api/hummatch/admin/squad-invite', requireAdmin, (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'Pass ?name=SquadName' });
  const squads = db.prepare('SELECT * FROM squad_matches WHERE LOWER(squad_name) LIKE LOWER(?)').all(`%${name}%`);
  if (!squads.length) return res.status(404).json({ error: 'No squad found matching that name' });
  res.json({ squads: squads.map(s => ({ id: s.id, squad_name: s.squad_name, invite_token: s.invite_token, invite_url: s.invite_token ? `/squadmatch?join=${s.invite_token}` : null, status: s.status })) });
});

app.post('/api/hummatch/admin/squad-invite/regen', requireAdmin, (req, res) => {
  const { squad_id } = req.body;
  if (!squad_id) return res.status(400).json({ error: 'Pass squad_id in body' });
  const squad = db.prepare('SELECT * FROM squad_matches WHERE id = ?').get(squad_id);
  if (!squad) return res.status(404).json({ error: 'Squad not found' });
  const token = require('crypto').randomBytes(5).toString('hex');
  db.prepare('UPDATE squad_matches SET invite_token = ? WHERE id = ?').run(token, squad_id);
  res.json({ ok: true, squad_name: squad.squad_name, invite_token: token, invite_url: `/squadmatch?join=${token}` });
});

// Get squad by invite token (for join page — no auth)
app.get('/api/hummatch/squad/join/:token', (req, res) => {
  const squad = stmts.getSquadByToken.get(req.params.token);
  if (!squad) return res.status(404).json({ error: 'Squad not found' });
  const members = stmts.getSquadMembers.all(squad.id);
  res.json({
    squad_id: squad.id,
    squad_name: squad.squad_name,
    invite_token: squad.invite_token,
    member_count: members.length,
    members: members.map(m => ({ display_name: m.display_name, status: m.status, hum_done: m.hum_done || 0 }))
  });
});

// Public squad info (no auth — for invite link landing page)
app.get('/api/hummatch/squad/:id/public', (req, res) => {
  const squadId = parseInt(req.params.id);
  const squad = db.prepare('SELECT id, squad_name FROM squad_matches WHERE id = ?').get(squadId);
  if (!squad) return res.status(404).json({ error: 'Squad not found' });
  const members = stmts.getSquadMembers.all(squadId);
  res.json({ squad_name: squad.squad_name, member_count: members.length, squad_id: squad.id });
});

// Join squad via invite link (no auth required)
app.post('/api/hummatch/squad/:id/join', (req, res) => {
  const squadId = parseInt(req.params.id);
  const { display_name, voice_type } = req.body;
  if (!display_name) return res.status(400).json({ error: 'Name required' });

  const squad = db.prepare('SELECT id, squad_name, owner_user_id FROM squad_matches WHERE id = ?').get(squadId);
  if (!squad) return res.status(404).json({ error: 'Squad not found' });

  // Check member limit based on owner's premium status
  const owner = db.prepare('SELECT is_premium FROM users WHERE id = ?').get(squad.owner_user_id);
  const members = stmts.getSquadMembers.all(squadId);
  if (!owner?.is_premium && members.length >= 4) {
    return res.status(403).json({ error: 'This squad is full (4 member limit on free plan).' });
  }

  try {
    const info = stmts.insertSquadMember.run(squadId, null, display_name, voice_type || '', 'joined');
    res.json({ ok: true, id: info.lastInsertRowid, squad_name: squad.squad_name });
  } catch (e) {
    res.status(500).json({ error: 'Failed to join squad' });
  }
});

// Get squad status with members (polling endpoint)
app.get('/api/hummatch/squad/:id/status', (req, res) => {
  const squadId = parseInt(req.params.id);
  const squad = stmts.getSquadById.get(squadId);
  if (!squad) return res.status(404).json({ error: 'Squad not found' });
  const members = stmts.getSquadMembers.all(squadId);
  const doneCount = members.filter(m => m.hum_done).length;
  const allDone = members.length >= 2 && doneCount === members.length;
  res.json({
    squad_id: squad.id,
    squad_name: squad.squad_name,
    invite_token: squad.invite_token,
    status: squad.status || 'active',
    voted_name: squad.voted_name || null,
    best_song: squad.best_song || null,
    best_artist: squad.best_artist || null,
    shared_songs: (() => { try { return JSON.parse(squad.shared_songs || '[]'); } catch { return []; } })(),
    member_count: members.length,
    done_count: doneCount,
    all_done: allDone,
    members: members.map(m => ({
      id: m.id,
      display_name: m.display_name,
      status: m.status,
      hum_done: m.hum_done || 0
    }))
  });
});

// Member submits hum results
app.post('/api/hummatch/squad/:id/hum', (req, res) => {
  const squadId = parseInt(req.params.id);
  const { member_id, songs, voice_low, voice_high, voice_type } = req.body;
  if (!member_id || !songs) return res.status(400).json({ error: 'member_id and songs required' });

  const squad = stmts.getSquadById.get(squadId);
  if (!squad) return res.status(404).json({ error: 'Squad not found' });

  try {
    db.prepare('UPDATE squad_members SET songs_json = ?, hum_done = 1, voice_low = ?, voice_high = ?, voice_type = ?, status = ? WHERE id = ? AND squad_id = ?')
      .run(JSON.stringify(songs.slice(0, 20)), voice_low || null, voice_high || null, voice_type || '', 'done', member_id, squadId);

    // Check if all members done — calculate shared songs
    const members = stmts.getSquadMembers.all(squadId);
    const doneCount = members.filter(m => m.hum_done).length;

    if (doneCount === members.length && members.length >= 2) {
      const allSongArrays = members.map(m => {
        try { return JSON.parse(m.songs_json || '[]'); } catch { return []; }
      });
      // Build strict intersection first
      const titleSets = allSongArrays.map(arr => new Set(arr.map(s => (s.title || '').toLowerCase())));
      const firstSet = titleSets[0];
      let sharedTitles = [...firstSet].filter(t => titleSets.every(s => s.has(t)));

      // Fallback: majority (>= half of members)
      if (sharedTitles.length === 0) {
        const titleCounts = {};
        allSongArrays.flat().forEach(s => {
          const t = (s.title || '').toLowerCase();
          titleCounts[t] = (titleCounts[t] || 0) + 1;
        });
        sharedTitles = Object.keys(titleCounts).filter(t => titleCounts[t] >= Math.ceil(members.length / 2));
      }

      // Build song objects with avg scores
      const allSongsFlat = allSongArrays.flat();
      let sharedSongs = sharedTitles.map(t => {
        const matches = allSongsFlat.filter(s => (s.title || '').toLowerCase() === t);
        const avgScore = matches.reduce((a, b) => a + (b.score || 0), 0) / matches.length;
        return { ...matches[0], score: avgScore };
      });
      sharedSongs.sort((a, b) => (b.score || 0) - (a.score || 0));
      sharedSongs = sharedSongs.slice(0, 10);

      const best = sharedSongs[0] || {};
      db.prepare('UPDATE squad_matches SET best_song = ?, best_artist = ?, shared_songs = ?, status = ? WHERE id = ?')
        .run(best.title || '', best.artist || '', JSON.stringify(sharedSongs), 'complete', squadId);
    }

    const updatedMembers = stmts.getSquadMembers.all(squadId);
    const newDone = updatedMembers.filter(m => m.hum_done).length;
    res.json({ ok: true, done_count: newDone, total_count: updatedMembers.length, all_done: newDone === updatedMembers.length });
  } catch (e) {
    console.error('[squad/hum] ERROR:', e.message);
    res.status(500).json({ error: 'Failed to record hum results' });
  }
});

// Submit name vote
app.post('/api/hummatch/squad/:id/vote', (req, res) => {
  const squadId = parseInt(req.params.id);
  const { member_id, voted_name } = req.body;
  if (!member_id || !voted_name) return res.status(400).json({ error: 'member_id and voted_name required' });

  try {
    db.prepare('INSERT OR REPLACE INTO squad_name_votes (squad_id, member_id, voted_name) VALUES (?, ?, ?)')
      .run(squadId, member_id, voted_name);
    const votes = db.prepare('SELECT voted_name, COUNT(*) as count FROM squad_name_votes WHERE squad_id = ? GROUP BY voted_name ORDER BY count DESC').all(squadId);
    const members = stmts.getSquadMembers.all(squadId);
    const totalVotes = votes.reduce((a, b) => a + b.count, 0);
    // Set name if majority agreed
    if (votes[0] && votes[0].count > members.length / 2) {
      db.prepare('UPDATE squad_matches SET voted_name = ? WHERE id = ?').run(votes[0].voted_name, squadId);
    }
    res.json({ ok: true, votes, total_members: members.length, total_votes: totalVotes });
  } catch (e) {
    res.status(500).json({ error: 'Failed to record vote' });
  }
});

// Get vote tallies
app.get('/api/hummatch/squad/:id/votes', (req, res) => {
  const squadId = parseInt(req.params.id);
  const votes = db.prepare('SELECT voted_name, COUNT(*) as count FROM squad_name_votes WHERE squad_id = ? GROUP BY voted_name ORDER BY count DESC').all(squadId);
  const members = stmts.getSquadMembers.all(squadId);
  const squad = stmts.getSquadById.get(squadId);
  res.json({ votes, total_members: members.length, voted_name: squad?.voted_name || null });
});

// Delete squad
app.delete('/api/hummatch/squad/:id', requireAuth, (req, res) => {
  const squadId = parseInt(req.params.id);
  const squad = stmts.getSquadById.get(squadId);
  
  if (!squad) {
    return res.status(404).json({ error: 'Squad not found' });
  }
  
  // Check if user is the creator
  if (squad.owner_user_id !== req.user.id) {
    return res.status(403).json({ error: 'Only the squad creator can delete it' });
  }
  
  try {
    // Delete squad members first (foreign key constraint)
    db.prepare('DELETE FROM squad_members WHERE squad_id = ?').run(squadId);
    // Delete the squad (table is named squad_matches, not squads)
    db.prepare('DELETE FROM squad_matches WHERE id = ?').run(squadId);
    
    res.json({ ok: true });
  } catch (e) {
    console.error('Squad deletion error:', e);
    res.status(500).json({ error: 'Failed to delete squad' });
  }
});

// ---------------------------------------------------------------------------
// API: Song Requests (Premium)
// ---------------------------------------------------------------------------
app.get('/api/hummatch/song-requests', requireAuth, requirePremium, (req, res) => {
  const requests = stmts.getSongRequests.all(req.user.id);
  res.json({ requests });
});

app.post('/api/hummatch/song-requests', requireAuth, requirePremium, (req, res) => {
  const { song_title, artist, notes } = req.body;
  if (!song_title) return res.status(400).json({ error: 'Song title required' });
  try {
    const info = stmts.insertSongRequest.run(req.user.id, song_title, artist || '', notes || '');
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: 'Failed to submit request' });
  }
});

// ---------------------------------------------------------------------------
// API: Friend Codes (Premium)
// ---------------------------------------------------------------------------
app.get('/api/hummatch/friend-codes', requireAuth, requirePremium, (req, res) => {
  const codes = stmts.getFriendCodes.all(req.user.id);
  let tracker = stmts.getCodeTracker.get(req.user.id);

  // Auto-reset if past reset date
  if (tracker && tracker.reset_date && new Date(tracker.reset_date) <= new Date()) {
    const nextReset = new Date();
    nextReset.setMonth(nextReset.getMonth() + 1, 1);
    nextReset.setHours(0, 0, 0, 0);
    stmts.resetCodeTracker.run(nextReset.toISOString(), req.user.id);
    tracker = stmts.getCodeTracker.get(req.user.id);
  }

  const codesIssued = tracker ? tracker.codes_issued : 0;
  const conversions = codes.filter(c => c.converted).length;

  res.json({
    codes,
    remaining: Math.max(0, 5 - codesIssued),
    total: 5,
    conversions,
    resetDate: tracker ? tracker.reset_date : null
  });
});

app.post('/api/hummatch/friend-codes', requireAuth, requirePremium, (req, res) => {
  let tracker = stmts.getCodeTracker.get(req.user.id);

  // Auto-reset if past reset date
  if (tracker && tracker.reset_date && new Date(tracker.reset_date) <= new Date()) {
    const nextReset = new Date();
    nextReset.setMonth(nextReset.getMonth() + 1, 1);
    nextReset.setHours(0, 0, 0, 0);
    stmts.resetCodeTracker.run(nextReset.toISOString(), req.user.id);
    tracker = stmts.getCodeTracker.get(req.user.id);
  }

  const codesIssued = tracker ? tracker.codes_issued : 0;
  if (codesIssued >= 5) {
    return res.status(400).json({ error: 'Monthly code limit reached (5/5)' });
  }

  // Generate code from email prefix
  const prefix = req.user.email.split('@')[0].replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 8);
  const code = prefix + 'MUSIC20' + Math.floor(Math.random() * 100);

  try {
    stmts.insertFriendCode.run(req.user.id, code);
    const nextReset = new Date();
    nextReset.setMonth(nextReset.getMonth() + 1, 1);
    nextReset.setHours(0, 0, 0, 0);
    stmts.upsertCodeTracker.run(req.user.id, nextReset.toISOString());
    res.json({ ok: true, code, remaining: Math.max(0, 4 - codesIssued) });
  } catch (e) {
    res.status(500).json({ error: 'Failed to generate code' });
  }
});

// ---------------------------------------------------------------------------
// API: Squad Leader Discount Codes
// ---------------------------------------------------------------------------

// Generate a new discount code (max 5 per month)
app.post('/api/hummatch/discount-codes/generate', requireAuth, requirePremium, (req, res) => {
  const monthKey = new Date().toISOString().slice(0, 7);
  
  // Check/initialize quota
  let quota = db.prepare('SELECT * FROM squad_leader_code_quota WHERE user_id = ? AND month_key = ?').get(req.user.id, monthKey);
  if (!quota) {
    db.prepare('INSERT INTO squad_leader_code_quota (user_id, month_key, codes_generated) VALUES (?, ?, 0)').run(req.user.id, monthKey);
    quota = { codes_generated: 0, max_codes: 5 };
  }
  
  if (quota.codes_generated >= quota.max_codes) {
    return res.status(400).json({ error: `Monthly code limit reached (${quota.codes_generated}/${quota.max_codes})` });
  }
  
  // Generate unique code
  const prefix = req.user.email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 6);
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  const code = `${prefix}${random}20`; // e.g., SINGER7G4X20
  
  try {
    db.prepare('INSERT INTO discount_codes (code, squad_leader_id) VALUES (?, ?)').run(code, req.user.id);
    db.prepare('UPDATE squad_leader_code_quota SET codes_generated = codes_generated + 1 WHERE user_id = ? AND month_key = ?').run(req.user.id, monthKey);
    
    const remaining = quota.max_codes - quota.codes_generated - 1;
    res.json({ ok: true, code, remaining });
  } catch (e) {
    console.error('Code generation failed:', e.message);
    res.status(500).json({ error: 'Failed to generate code' });
  }
});

// Get all my codes and their usage stats
app.get('/api/hummatch/discount-codes/my-codes', requireAuth, requirePremium, (req, res) => {
  const codes = db.prepare(`
    SELECT 
      dc.code,
      dc.discount_percent,
      dc.uses_count,
      dc.is_active,
      dc.created_at,
      COUNT(dcu.id) as total_uses,
      COALESCE(SUM(dcu.amount_cents), 0) as total_revenue_cents
    FROM discount_codes dc
    LEFT JOIN discount_code_uses dcu ON dc.id = dcu.code_id
    WHERE dc.squad_leader_id = ?
    GROUP BY dc.id
    ORDER BY dc.created_at DESC
  `).all(req.user.id);
  
  const monthKey = new Date().toISOString().slice(0, 7);
  const quota = db.prepare('SELECT * FROM squad_leader_code_quota WHERE user_id = ? AND month_key = ?').get(req.user.id, monthKey);
  
  res.json({ 
    codes, 
    quota: quota ? { generated: quota.codes_generated, max: quota.max_codes, remaining: quota.max_codes - quota.codes_generated } : { generated: 0, max: 5, remaining: 5 }
  });
});

// Validate a discount code (public endpoint for checkout)
app.post('/api/hummatch/discount-codes/validate', (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });
  
  const discountCode = db.prepare('SELECT * FROM discount_codes WHERE UPPER(code) = UPPER(?) AND is_active = 1').get(code.trim());
  
  if (!discountCode) {
    return res.json({ valid: false, error: 'Invalid or expired code' });
  }
  
  res.json({ 
    valid: true, 
    discount_percent: discountCode.discount_percent,
    code: discountCode.code 
  });
});

// Track code usage (called after successful Stripe checkout)
app.post('/api/hummatch/discount-codes/track-use', (req, res) => {
  const { code, user_id, stripe_session_id, amount_cents } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });
  
  const discountCode = db.prepare('SELECT * FROM discount_codes WHERE UPPER(code) = UPPER(?)').get(code.trim());
  if (!discountCode) {
    return res.status(404).json({ error: 'Code not found' });
  }
  
  try {
    db.prepare('INSERT INTO discount_code_uses (code_id, user_id, stripe_session_id, amount_cents) VALUES (?, ?, ?, ?)').run(
      discountCode.id, user_id || null, stripe_session_id || null, amount_cents || 0
    );
    db.prepare('UPDATE discount_codes SET uses_count = uses_count + 1 WHERE id = ?').run(discountCode.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('Track use failed:', e.message);
    res.status(500).json({ error: 'Failed to track code usage' });
  }
});

// Admin: Get all discount code stats
app.get('/api/hummatch/admin/discount-codes/stats', requireAdmin, (req, res) => {
  const stats = db.prepare(`
    SELECT 
      u.email as squad_leader_email,
      dc.code,
      dc.uses_count,
      COUNT(dcu.id) as total_conversions,
      COALESCE(SUM(dcu.amount_cents), 0) as total_revenue_cents,
      dc.created_at
    FROM discount_codes dc
    JOIN users u ON dc.squad_leader_id = u.id
    LEFT JOIN discount_code_uses dcu ON dc.id = dcu.code_id
    GROUP BY dc.id
    ORDER BY total_revenue_cents DESC
  `).all();
  
  res.json({ stats });
});

// ---------------------------------------------------------------------------
// Campaign Email System (Admin)
// ---------------------------------------------------------------------------

// In-memory tracking for daily email limits
const campaignState = {
  dailySent: 0,
  lastResetDate: new Date().toISOString().split('T')[0],
  dailyLimit: 500
};

function resetDailySentIfNeeded() {
  const today = new Date().toISOString().split('T')[0];
  if (campaignState.lastResetDate !== today) {
    campaignState.dailySent = 0;
    campaignState.lastResetDate = today;
  }
}

// Helper: delay between emails to avoid SMTP throttling
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Template A: Vocal Coaches
function generateVocalCoachEmail(firstName, platform, specificContent) {
  const subject = 'I built something for your singers';
  const html = emailWrapper(`
    <p>Hey ${firstName},</p>
    <p>I'm Joe, founder of HumMatch. Just launched and thought your students would love this.</p>
    <p><strong>The problem:</strong> Most singers don't know which songs actually fit their voice. They pick songs that sound cool but sit outside their range. Then they strain, sound bad, and get discouraged.</p>
    <p><strong>HumMatch fixes this:</strong> Hum 3 notes → instant song matches in your exact range.</p>
    <p>It's free to use. No signup required. Works on any device.</p>
    <p><strong>Why I'm reaching out:</strong> I'm offering vocal coaches like you a 25% affiliate commission (vs. our standard 20%) as a launch partner.</p>
    <p>Your students get 10% off when they upgrade. You get credit for every conversion. First 100 coaches only.</p>
    <p>Try it yourself: <a href="https://hummatch.me" style="color:#A855F7;">https://hummatch.me</a></p>
    <p>If it clicks, here's the affiliate signup: <a href="https://hummatch.me/affiliate" style="color:#A855F7;">https://hummatch.me/affiliate</a></p>
    <p style="margin-top:24px;">- Joe</p>
    <p style="color:rgba(255,255,255,0.5);font-size:13px;">Founder, HumMatch<br><a href="https://hummatch.me" style="color:#A855F7;">https://hummatch.me</a></p>
  `);
  return { subject, html };
}

// Template B: Karaoke Creators
function generateKaraokeEmail(firstName, platform, specificContent) {
  const subject = 'Built something for your karaoke community';
  const html = emailWrapper(`
    <p>Hey ${firstName},</p>
    <p>I'm Joe from HumMatch.</p>
    <p><strong>Quick pitch:</strong> I built a tool that matches people to songs in their exact vocal range. Hum 3 notes → instant personalized song list.</p>
    <p>No more "can I sing this?" guessing. Works for solo singers AND groups.</p>
    <p><strong>Why you'd care:</strong></p>
    <ul style="color:#e2e0f0;padding-left:20px;margin:0 0 20px;">
      <li style="margin-bottom:8px;">Your audience gets better song recommendations</li>
      <li style="margin-bottom:8px;">Makes karaoke less intimidating for newbies</li>
      <li style="margin-bottom:8px;">Group feature finds songs everyone can sing</li>
    </ul>
    <p>It's completely free. No account needed: <a href="https://hummatch.me" style="color:#A855F7;">https://hummatch.me</a></p>
    <p><strong>Partnership opportunity:</strong> I'm offering 25% commission (higher than our standard 20%) to the first 100 creators who join.</p>
    <p>Your community gets 10% off when they upgrade to premium ($7.99/mo). You earn 25% commission for 12 months on each referral — that's $2/month per subscriber.</p>
    <p>Give it a spin. If you like it, affiliate signup is here: <a href="https://hummatch.me/affiliate" style="color:#A855F7;">https://hummatch.me/affiliate</a></p>
    <p>Keep crushing it!</p>
    <p style="margin-top:24px;">- Joe</p>
    <p style="color:rgba(255,255,255,0.5);font-size:13px;">Founder, HumMatch<br><a href="https://hummatch.me" style="color:#A855F7;">https://hummatch.me</a></p>
  `);
  return { subject, html };
}

// Template C: Music Bloggers/Reviewers
function generateMusicBloggerEmail(firstName) {
  const subject = 'Worth covering? (vocal range tool launch)';
  const html = emailWrapper(`
    <p>Hey ${firstName},</p>
    <p>I'm Joe, founder of HumMatch. Came across your blog while researching the karaoke/vocal tech space.</p>
    <p><strong>What it is:</strong> HumMatch analyzes your voice in 10 seconds (you just hum) and shows you which songs from our 10K+ library match your exact range.</p>
    <p>No more picking songs that are too high or too low. Just instant personalized matches.</p>
    <p><strong>Unique angle:</strong> We also do group matching (SquadMatch) — finds songs your whole crew can sing together. First tool I've seen that does this.</p>
    <p><strong>Tech:</strong> Real-time pitch detection, vocal range mapping, genre filtering. Works on any device (web app, no download needed). Free tier + $7.99/mo premium.</p>
    <p>Try it: <a href="https://hummatch.me" style="color:#A855F7;">https://hummatch.me</a></p>
    <p><strong>If you cover it:</strong> I'd offer you affiliate terms (25% commission, vs our standard 20%). Your readers get 10% off. First 100 partners only.</p>
    <p>No pressure — just thought it might fit your audience.</p>
    <p>Affiliate signup (if interested): <a href="https://hummatch.me/affiliate" style="color:#A855F7;">https://hummatch.me/affiliate</a></p>
    <p>Thanks for reading!</p>
    <p style="margin-top:24px;">- Joe</p>
    <p style="color:rgba(255,255,255,0.5);font-size:13px;">Founder, HumMatch<br><a href="https://hummatch.me" style="color:#A855F7;">https://hummatch.me</a></p>
  `);
  return { subject, html };
}

// Admin: Send batch campaign emails
app.post('/api/hummatch/admin/campaign/send', requireAdmin, async (req, res) => {
  const { recipients, template, dryRun } = req.body;

  if (!Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: 'recipients must be a non-empty array' });
  }

  if (!['vocal-coach', 'karaoke', 'music-blogger'].includes(template)) {
    return res.status(400).json({ error: 'template must be vocal-coach, karaoke, or music-blogger' });
  }

  if (recipients.length > 50) {
    return res.status(400).json({ error: 'Max 50 recipients per request' });
  }

  resetDailySentIfNeeded();

  const sent = [];
  const failed = [];
  const errors = [];

  for (const recipient of recipients) {
    const { email, firstName, lastName, category, platform, followers, url } = recipient;

    if (!email || !firstName) {
      errors.push({ email: email || 'unknown', error: 'Missing email or firstName' });
      failed.push(email);
      continue;
    }

    try {
      // Generate email based on template
      let emailData;
      if (template === 'vocal-coach') {
        const content = category || 'teaching technique';
        emailData = generateVocalCoachEmail(firstName, platform || 'your platform', content);
      } else if (template === 'karaoke') {
        const content = category || 'recent karaoke series';
        emailData = generateKaraokeEmail(firstName, platform || 'your channel', content);
      } else if (template === 'music-blogger') {
        emailData = generateMusicBloggerEmail(firstName);
      }

      if (!dryRun) {
        // Check daily limit
        if (campaignState.dailySent >= campaignState.dailyLimit) {
          errors.push({ email, error: 'Daily limit reached' });
          failed.push(email);
          continue;
        }

        // Send email with rate limiting (2 second delay)
        const sendSuccess = await sendEmail(email, emailData.subject, emailData.html);
        if (sendSuccess) {
          sent.push(email);
          campaignState.dailySent++;
        } else {
          errors.push({ email, error: 'Email send failed' });
          failed.push(email);
        }
      } else {
        // Dry run: just log
        console.log(`[DRY RUN] Would send "${emailData.subject}" to ${email}`);
        sent.push(email);
      }

      // 2-second delay between sends to avoid SMTP throttling
      if (recipients.indexOf(recipient) < recipients.length - 1) {
        await delay(2000);
      }
    } catch (err) {
      console.error(`Campaign email error (${email}):`, err.message);
      errors.push({ email, error: err.message });
      failed.push(email);
    }
  }

  res.json({
    sent: sent.length,
    failed: failed.length,
    errors,
    dryRun: !!dryRun
  });
});

// Admin: Get campaign status
app.get('/api/hummatch/admin/campaign/status', requireAdmin, (req, res) => {
  resetDailySentIfNeeded();

  res.json({
    emailConfigured: !!emailTransporter,
    dailySent: campaignState.dailySent,
    dailyLimit: campaignState.dailyLimit,
    remaining: campaignState.dailyLimit - campaignState.dailySent
  });
});

// ---------------------------------------------------------------------------
// API: Account Settings
// ---------------------------------------------------------------------------
app.put('/api/hummatch/account', requireAuth, (req, res) => {
  const { email, zip_code } = req.body;
  if (email) {
    const trimmed = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      return res.status(400).json({ error: 'Invalid email' });
    }
    try {
      db.prepare('UPDATE users SET email = ?, updated_at = datetime(\'now\') WHERE id = ?').run(trimmed, req.user.id);
    } catch (e) {
      return res.status(400).json({ error: 'Email already in use' });
    }
  }
  if (zip_code !== undefined) {
    stmts.updateUserZip.run(zip_code.trim().slice(0, 10), req.user.id);
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// API: Stripe Checkout
// ---------------------------------------------------------------------------
// NEW PRICING: $7.99/mo, $49.99/yr (created 2026-04-05)
// Old prices archived:
//   monthly $5.99: price_1TE07i8kAFC9VsZHxD9xqXYB
//   annual $39.99: price_1TDCM48kAFC9VsZHdVNcIKI7
const STRIPE_PRICES = {
  monthly: 'price_1TIpgS8kAFC9VsZHvbr6HjoD', // $7.99/mo
  annual: 'price_1TIpgT8kAFC9VsZHWMuxhboQ'   // $49.99/yr
};

app.get('/api/hummatch/checkout/success', async (req, res) => {
  if (stripe && req.query.session_id) {
    try {
      const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
      if (session.payment_status === 'paid') {
        const email = (session.customer_details?.email || session.customer_email || '').toLowerCase();
        if (email) {
          const user = stmts.getUserByEmail.get(email);
          if (user) {
            db.prepare("UPDATE users SET is_premium = 1, updated_at = datetime('now') WHERE id = ?").run(user.id);
          } else {
            const newToken = uuidv4();
            stmts.insertUser.run(email, newToken, monthKey(), null);
            db.prepare("UPDATE users SET is_premium = 1 WHERE email = ?").run(email);
          }
          console.log(`Premium activated for ${email} via checkout success`);
          sendEmail(email, 'Welcome to Squad Leader!', emailSquadLeader(email));
        }
      }
    } catch (e) {
      console.error('Checkout success verification error:', e.message);
    }
  }
  res.redirect('/dashboard?upgraded=1');
});

app.post('/api/checkout', async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

  const plan = req.body.plan || 'monthly';
  const priceId = STRIPE_PRICES[plan];
  if (!priceId) return res.status(400).json({ error: 'Invalid plan. Use monthly or annual.' });

  const sessionOpts = {
    mode: 'subscription',
    payment_method_types: ['card', 'us_bank_account'],
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${req.protocol}://${req.get('host')}/api/hummatch/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${req.protocol}://${req.get('host')}/`
  };

  const token = req.headers['x-hm-token'] || req.body.token;
  if (token) {
    const user = stmts.getUserByToken.get(token);
    if (user) sessionOpts.customer_email = user.email;
  }

  try {
    const session = await stripe.checkout.sessions.create(sessionOpts);
    res.json({ url: session.url });
  } catch (e) {
    console.error('Stripe checkout error:', e.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

app.get('/api/hummatch/checkout/:plan', async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

  const priceId = STRIPE_PRICES[req.params.plan];
  if (!priceId) return res.status(400).json({ error: 'Invalid plan. Use monthly or annual.' });

  const sessionOpts = {
    mode: 'subscription',
    payment_method_types: ['card', 'us_bank_account'],
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${req.protocol}://${req.get('host')}/api/hummatch/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${req.protocol}://${req.get('host')}/`
  };

  // Apply discount code if provided
  const discountCode = req.query.code;
  if (discountCode) {
    const code = db.prepare('SELECT * FROM discount_codes WHERE UPPER(code) = UPPER(?) AND is_active = 1').get(discountCode.trim());
    if (code) {
      // Create Stripe coupon for this discount
      try {
        const coupon = await stripe.coupons.create({
          percent_off: code.discount_percent,
          duration: 'once',
          name: `HumMatch Squad Leader Discount (${code.code})`
        });
        sessionOpts.discounts = [{ coupon: coupon.id }];
        sessionOpts.metadata = { discount_code: code.code, squad_leader_id: code.squad_leader_id };
      } catch (e) {
        console.error('Failed to create Stripe coupon:', e.message);
      }
    }
  }

  // Stage 8: ride-originated discount + attribution pass-through.
  // Uses ?rideDiscountCode= to avoid collision with the squad leader ?code= path.
  const rideDiscountCode   = (req.query.rideDiscountCode   || '').toString().trim();
  const rideSessionId      = (req.query.rideSessionId      || '').toString().trim();
  const rideAffiliateCode  = (req.query.rideAffiliateCode  || '').toString().trim();
  if (rideDiscountCode || rideSessionId || rideAffiliateCode) {
    sessionOpts.metadata = sessionOpts.metadata || {};
    if (rideSessionId)     sessionOpts.metadata.ride_session_id    = rideSessionId;
    if (rideAffiliateCode) sessionOpts.metadata.ride_affiliate_code = rideAffiliateCode;
    sessionOpts.metadata.ride_originated = 'true';

    if (rideDiscountCode) {
      try {
        const rideCode = db.prepare(
          'SELECT * FROM ride_discount_codes WHERE UPPER(code) = UPPER(?) AND is_active = 1'
        ).get(rideDiscountCode);
        const isExpired = rideCode && rideCode.expires_at && new Date(rideCode.expires_at) < new Date();
        if (rideCode && !isExpired && !sessionOpts.discounts) {
          const coupon = await stripe.coupons.create({
            percent_off: rideCode.discount_percent || 10,
            duration: 'once',
            name: 'HumMatch Ride Mode Discount'
          });
          sessionOpts.discounts = [{ coupon: coupon.id }];
          sessionOpts.metadata.ride_discount_code = rideCode.code;
          if (!sessionOpts.metadata.ride_session_id && rideCode.ride_session_id) {
            sessionOpts.metadata.ride_session_id = rideCode.ride_session_id;
          }
          if (!sessionOpts.metadata.ride_affiliate_code && rideCode.affiliate_code) {
            sessionOpts.metadata.ride_affiliate_code = rideCode.affiliate_code;
          }
        } else {
          // Still carry the code string for attribution even if unusable.
          sessionOpts.metadata.ride_discount_code = rideDiscountCode;
          if (isExpired) sessionOpts.metadata.ride_discount_expired = 'true';
        }
      } catch (e) {
        console.error('[ride-mode] ride discount coupon error:', e.message);
      }
    }
  }

  // Pre-fill email if user is logged in
  const token = req.headers['x-hm-token'] || req.query.token;
  if (token) {
    const user = stmts.getUserByToken.get(token);
    if (user) {
      sessionOpts.customer_email = user.email;
      if (sessionOpts.metadata) sessionOpts.metadata.user_id = user.id;
    }
  }

  try {
    const session = await stripe.checkout.sessions.create(sessionOpts);
    res.redirect(303, session.url);
  } catch (e) {
    console.error('Stripe checkout error:', e.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// ---------------------------------------------------------------------------
// API: GroupMatch Waitlist
// ---------------------------------------------------------------------------
app.post('/api/groupmatch/waitlist', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  const zip_code = (req.body.zip_code || '').trim().slice(0, 10);
  const voice_type = (req.body.voice_type || '').trim().slice(0, 30);

  // Prevent duplicate signups
  const existing = stmts.getWaitlistByEmail.get(email);
  if (existing) {
    return res.json({ ok: true, message: 'You\'re already on the waitlist!' });
  }

  try {
    stmts.insertWaitlist.run(email, zip_code, voice_type);

    // Track analytics event
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const ua = req.headers['user-agent'] || '';
    stmts.insertEvent.run('groupmatch_waitlist_signup', 'en', JSON.stringify({ email: email.split('@')[0] + '@***', zip_code, voice_type }), ip, ua);

    sendEmail(email, "You're on the GroupMatch Waitlist!", emailGroupMatchWaitlist(email));

    res.json({ ok: true, message: 'You\'re on the list! We\'ll notify you when GroupMatch launches.' });
  } catch (e) {
    console.error('GroupMatch waitlist error:', e.message);
    res.status(500).json({ error: 'Failed to join waitlist' });
  }
});

// ---------------------------------------------------------------------------
// API: Save Playlist & Send Email
// ---------------------------------------------------------------------------
app.post('/api/hummatch/playlist/save', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  const songs = req.body.songs;
  if (!Array.isArray(songs) || songs.length === 0) {
    return res.status(400).json({ error: 'No songs to save' });
  }

  const shareToken = uuidv4().replace(/-/g, '').slice(0, 12);

  try {
    stmts.insertSharedPlaylist.run(email, JSON.stringify(songs), shareToken);

    // Auto-register user if new
    let user = stmts.getUserByEmail.get(email);
    const isNew = !user;
    if (!user) {
      const token = uuidv4();
      stmts.insertUser.run(email, token, monthKey(), null);
      user = stmts.getUserByEmail.get(email);
    }

    // Also save songs to user_playlists table
    const insertPlaylist = db.transaction((songList, userId) => {
      for (const s of songList) {
        stmts.insertPlaylistSong.run(
          userId, s.song_title || s.title || '', s.artist || '',
          s.confidence || 0, s.genre || '', s.song_key || s.key || '',
          s.voice_type || '', s.language || 'en'
        );
      }
    });
    insertPlaylist(songs, user.id);

    const host = req.get('host') || 'hummatch.me';
    const protocol = req.protocol || 'https';
    const shareUrl = host.includes('localhost')
      ? `${protocol}://${host}/playlist/${shareToken}`
      : `https://hummatch.me/playlist/${shareToken}`;

    // Send playlist email (async, don't block response)
    sendEmail(email, 'Your HumMatch Playlist is Ready!', emailPlaylistSaved(songs, shareUrl));

    // Send welcome email if new user (guarded — only sends once)
    if (isNew) {
      trySendWelcomeEmail(user.id, email);
    }

    res.json({ ok: true, shareToken, shareUrl, isNew });
  } catch (e) {
    console.error('Playlist save error:', e.message);
    res.status(500).json({ error: 'Failed to save playlist' });
  }
});

// ---------------------------------------------------------------------------
// Public Playlist View (serves playlist.html)
// ---------------------------------------------------------------------------
app.get('/playlist/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'playlist.html'));
});

// API: Get shared playlist data
app.get('/api/hummatch/shared-playlist/:token', (req, res) => {
  const playlist = stmts.getSharedPlaylist.get(req.params.token);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

  let songs = [];
  try { songs = JSON.parse(playlist.songs || '[]'); } catch (_) {}

  res.json({
    songs,
    created_at: playlist.created_at,
    email: playlist.user_email.split('@')[0] + '@***'
  });
});

// ---------------------------------------------------------------------------
// Static files & SPA routing
// ---------------------------------------------------------------------------
// Canonical host + protocol normalization
app.use((req, res, next) => {
  const host = (req.get('host') || '').toLowerCase();
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim().toLowerCase();
  let path = req.originalUrl || req.url || '/';
  if (host && (proto !== 'https' || host === 'www.hummatch.me')) {
    return res.redirect(301, 'https://' + CANONICAL_HOST + path);
  }
  next();
});

// Serve HTML with no-cache headers (always fresh)
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/' || !req.path.includes('.')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

// Block access to sensitive files
app.use((req, res, next) => {
  const blocked = [
    /\.db$/i, /\.db-wal$/i, /\.db-shm$/i,
    /\.json$/i, /\.js$/i, /\.md$/i,
    /\.bak\d?$/i, /\.backup$/i,
    /^\/\./,
    /^\/node_modules/,
    /^\/package/,
    /^\/server\.js/i,
    /^\/seed-songs/i,
    /^\/fetch-popular/i,
    /^\/add-genre/i,
  ];
  const allowed = [
    /^\/sw\.js$/i,
    /^\/manifest\.json$/i,
  ];
  if (allowed.some(p => p.test(req.path))) return next();
  if (blocked.some(p => p.test(req.path))) return res.status(404).send('Not found');
  next();
});

app.use(express.static(path.join(__dirname), {
  extensions: ['html'],
  index: 'index.html',
  maxAge: 0  // No caching for HTML
}));

// Blog clean URLs (match render.yaml rewrites)
app.get('/blog/find-songs-you-can-nail', (_req, res) => {
  res.sendFile(path.join(__dirname, 'blog', 'find-songs-you-can-nail.html'));
});
app.get('/blog/how-hummatch-works', (_req, res) => {
  res.sendFile(path.join(__dirname, 'blog', 'how-hummatch-works.html'));
});
app.get('/blog/how-hummatch-was-built', (_req, res) => {
  res.sendFile(path.join(__dirname, 'blog', 'how-hummatch-was-built.html'));
});
app.get('/blog/from-swipe-culture-to-sing-culture', (_req, res) => {
  res.sendFile(path.join(__dirname, 'blog', 'from-swipe-culture-to-sing-culture.html'));
});
app.get('/blog', (_req, res) => {
  res.sendFile(path.join(__dirname, 'blog', 'index.html'));
});
app.get('/blog/introducing-squadmatch', (_req, res) => {
  res.sendFile(path.join(__dirname, 'blog', 'introducing-squadmatch.html'));
});
app.get('/blog/red-flag-playlists', (_req, res) => {
  res.sendFile(path.join(__dirname, 'blog', 'red-flag-playlists.html'));
});
app.get('/blog/squad-leader-best-practices', (_req, res) => {
  res.sendFile(path.join(__dirname, 'blog', 'squad-leader-best-practices.html'));
});
app.get('/blog/vocal-timbre-brightness-science', (_req, res) => {
  res.sendFile(path.join(__dirname, 'blog', 'vocal-timbre-brightness-science.html'));
});

// Spanish blog routes
app.get('/es/blog', (_req, res) => {
  res.sendFile(path.join(__dirname, 'es', 'blog', 'index.html'));
});
app.get('/es/blog/find-songs-you-can-nail', (_req, res) => {
  res.sendFile(path.join(__dirname, 'es', 'blog', 'find-songs-you-can-nail.html'));
});
app.get('/es/blog/how-hummatch-works', (_req, res) => {
  res.sendFile(path.join(__dirname, 'es', 'blog', 'how-hummatch-works.html'));
});
app.get('/es/blog/how-hummatch-was-built', (_req, res) => {
  res.sendFile(path.join(__dirname, 'es', 'blog', 'how-hummatch-was-built.html'));
});
app.get('/es/blog/introducing-squadmatch', (_req, res) => {
  res.sendFile(path.join(__dirname, 'es', 'blog', 'introducing-squadmatch.html'));
});
app.get('/es/blog/red-flag-playlists', (_req, res) => {
  res.sendFile(path.join(__dirname, 'es', 'blog', 'red-flag-playlists.html'));
});
app.get('/es/blog/squad-leader-best-practices', (_req, res) => {
  res.sendFile(path.join(__dirname, 'es', 'blog', 'squad-leader-best-practices.html'));
});
app.get('/es/blog/vocal-timbre-brightness-science', (_req, res) => {
  res.sendFile(path.join(__dirname, 'es', 'blog', 'vocal-timbre-brightness-science.html'));
});

// Dashboard page (requires authentication)
app.get('/dashboard', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Pricing page
app.get('/pricing', (_req, res) => {
  res.sendFile(path.join(__dirname, 'pricing.html'));
});
app.get('/es/precios', (_req, res) => {
  res.sendFile(path.join(__dirname, 'pricing-es.html'));
});
app.get('/hummatch/pricing', (_req, res) => {
  res.sendFile(path.join(__dirname, 'pricing.html'));
});

// How it works pages
app.get('/es/how-it-works', (_req, res) => {
  res.sendFile(path.join(__dirname, 'how-it-works-es.html'));
});

// SquadMatch landing page
app.get('/squadmatch', (_req, res) => {
  res.sendFile(path.join(__dirname, 'squadmatch.html'));
});
app.get('/es/squadmatch', (_req, res) => { res.redirect(301, '/es/grupomatch'); });
app.get('/es/grupomatch', (_req, res) => {
  res.sendFile(path.join(__dirname, 'squadmatch.html'));
});

// GroupMatch landing page
app.get('/groupmatch', (_req, res) => {
  res.sendFile(path.join(__dirname, 'groupmatch.html'));
});

// Contact page
app.get('/contact', (_req, res) => {
  res.sendFile(path.join(__dirname, 'contact.html'));
});
app.get('/es/contact', (_req, res) => {
  res.sendFile(path.join(__dirname, 'es', 'contact.html'));
});

// Affiliate page
app.get('/affiliate', (_req, res) => {
  res.sendFile(path.join(__dirname, 'affiliate.html'));
});
app.get('/es/affiliate', (_req, res) => {
  res.sendFile(path.join(__dirname, 'es', 'affiliate.html'));
});

// Privacy & Terms
app.get('/privacy', (_req, res) => {
  res.sendFile(path.join(__dirname, 'privacy.html'));
});
app.get('/terms', (_req, res) => {
  res.sendFile(path.join(__dirname, 'terms.html'));
});

// Login page
app.get('/login', (_req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

// Artist pages: /artist/[slug] → /artist/[slug].html
app.get('/artist/:slug', (req, res) => {
  const file = path.join(__dirname, 'artist', `${req.params.slug}.html`);
  if (fs.existsSync(file)) {
    res.sendFile(file);
  } else {
    res.redirect(302, '/song/');
  }
});

// Difficulty category pages
app.get('/easy-songs',   (_req, res) => res.sendFile(path.join(__dirname, 'easy-songs.html')));
app.get('/medium-songs', (_req, res) => res.sendFile(path.join(__dirname, 'medium-songs.html')));
app.get('/hard-songs',   (_req, res) => res.sendFile(path.join(__dirname, 'hard-songs.html')));

// Voice type category pages
app.get('/bass-songs',      (_req, res) => res.sendFile(path.join(__dirname, 'bass-songs.html')));
app.get('/baritone-songs',  (_req, res) => res.sendFile(path.join(__dirname, 'baritone-songs.html')));
app.get('/tenor-songs',     (_req, res) => res.sendFile(path.join(__dirname, 'tenor-songs.html')));
app.get('/alto-songs',      (_req, res) => res.sendFile(path.join(__dirname, 'alto-songs.html')));
app.get('/soprano-songs',   (_req, res) => res.sendFile(path.join(__dirname, 'soprano-songs.html')));

// Song directory index: /song/ → /song/index.html
app.get('/song', (req, res) => {
  res.sendFile(path.join(__dirname, 'song', 'index.html'));
});
app.get('/song/', (req, res) => {
  res.sendFile(path.join(__dirname, 'song', 'index.html'));
});

// Song SEO pages: /song/:slug → /song/:slug.html
app.get('/song/:slug', (req, res) => {
  const file = path.join(__dirname, 'song', `${req.params.slug}.html`);
  if (fs.existsSync(file)) {
    res.sendFile(file);
  } else {
    res.redirect(302, '/#catalog');
  }
});

// How It Works page
app.get('/how-it-works', (req, res) => {
  res.sendFile(path.join(__dirname, 'how-it-works.html'));
});

// SPA fallback moved to bottom of file so it does not swallow GET routes
// registered after app.listen() (e.g. the ride-mode block).


app.get('/es/ride-mode', (req, res) => {
  res.sendFile(path.join(__dirname, 'es', 'ride-mode.html'));
});
app.get('/es/ride-mode.html', (_req, res) => {
  res.redirect(301, '/es/ride-mode');
});

// Auto-seed songs if empty
// ---------------------------------------------------------------------------
function autoSeedSongs() {
  try {
    const songsCount = db.prepare('SELECT COUNT(*) as cnt FROM songs').get().cnt;
    // Force re-seed if count doesn't match expected (10172 songs with popularity scores)
    // Only auto-seed if songs table is truly empty (never force re-seed on count mismatch)
    if (songsCount > 0) {
      console.log(`[seed] songs table already populated (${songsCount} rows) — skipping auto-seed`);
      return;
    }
    console.log('[seed] songs table is EMPTY — auto-seeding from index.html...');
    const { execSync } = require('child_process');
    const result = execSync('node seed-songs.js', { cwd: __dirname, encoding: 'utf8' });
    console.log(result);
    console.log('[seed] auto-seed complete!');
  } catch (e) {
    console.error('[seed] auto-seed FAILED:', e.message);
    console.error('[seed] you may need to manually run: node seed-songs.js');
  }
}

autoSeedSongs();

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`HumMatch server running on port ${PORT}`);
  console.log(`  Static files: ${__dirname}`);
  console.log(`  Database: ${DB_PATH}`);
  console.log(`  Build version: ${BUILD_VERSION}`);

  // Startup diagnostics — verify critical tables and columns exist
  try {
    const humsCount = db.prepare('SELECT COUNT(*) as cnt FROM hums').get().cnt;
    console.log(`  [diag] hums table: OK (${humsCount} rows)`);
  } catch (e) {
    console.error('  [diag] hums table: MISSING or ERROR —', e.message);
  }
  try {
    const songsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='songs'").get();
    if (!songsTable) {
      console.error('  [diag] songs table: MISSING');
    } else {
      const total = db.prepare('SELECT COUNT(*) AS c FROM songs').get().c;
      const artists = db.prepare('SELECT COUNT(DISTINCT artist) AS c FROM songs').get().c;
      const slugs = db.prepare('SELECT COUNT(DISTINCT slug) AS c FROM songs').get().c;
      const withRange = db.prepare('SELECT COUNT(*) AS c FROM songs WHERE lo IS NOT NULL AND hi IS NOT NULL').get().c;
      const withLanguage = db.prepare("SELECT COUNT(*) AS c FROM songs WHERE language IS NOT NULL AND language != ''").get().c;
      const enCount = db.prepare("SELECT COUNT(*) AS c FROM songs WHERE language = 'en'").get().c;
      const esCount = db.prepare("SELECT COUNT(*) AS c FROM songs WHERE language = 'es'").get().c;
      const samples = db.prepare('SELECT slug, title, artist FROM songs LIMIT 5').all();
      
      console.log(`  [diag] songs table: OK (${total} rows)`);
      console.log(`  [diag] songs artists: ${artists} unique`);
      console.log(`  [diag] songs slugs: ${slugs} unique`);
      console.log(`  [diag] songs with range: ${withRange}`);
      console.log(`  [diag] songs with language: ${withLanguage}`);
      console.log(`  [diag] songs languages: en=${enCount}, es=${esCount}`);
      console.log(`  [diag] songs sample: ${samples.map(s => `${s.slug} ("${s.title}" by ${s.artist})`).join(', ')}`);
      
      if (total === 0) {
        console.error('  [ERROR] SONGS TABLE IS EMPTY! Auto-seed should have run.');
      } else if (total < 100) {
        console.error(`  [WARNING] Only ${total} songs in catalog (expected 3000+)`);
      } else if (withRange < total * 0.9) {
        console.error(`  [WARNING] ${total - withRange} songs missing vocal range data`);
      }
    }
  } catch (e) {
    console.error('  [diag] songs table: ERROR —', e.message);
  }
  try {
    const cols = db.pragma('table_info(users)').map(c => c.name);
    const hasWelcomeFlag = cols.includes('welcome_email_sent');
    console.log(`  [diag] users.welcome_email_sent column: ${hasWelcomeFlag ? 'OK' : 'MISSING'}`);
    if (hasWelcomeFlag) {
      const sentCount = db.prepare('SELECT COUNT(*) as cnt FROM users WHERE welcome_email_sent = 1').get().cnt;
      console.log(`  [diag] users with welcome_email_sent=1: ${sentCount}`);
    }
  } catch (e) {
    console.error('  [diag] users table check error:', e.message);
  }
});
const { createSession: createRideSession, joinSession: joinRideSession, assignHost: assignRideHost, advanceSession: advanceRideSession, endSession: endRideSession, getSession: getRideSession, getSessionForViewer: getRideSessionForViewer, storeHumData: storeRideHumData, scoreResultsById: scoreRideResultsById, setSessionAffiliateCode: setRideSessionAffiliateCode, getRawSession: getRawRideSession } = require('./src/sessionManager');

// Stage 7: helper — insert a Ride Mode event into affiliate_conversions.
// Swallows DB errors so a missing index or constraint never crashes the
// session endpoints. commission_amount stays 0; these are event records only.
function recordRideAffiliateEvent(affiliateCode, userId, eventType) {
  if (!affiliateCode) return;
  try {
    db.prepare(
      'INSERT INTO affiliate_conversions (affiliate_code, user_id, event_type, commission_amount) VALUES (?, ?, ?, 0)'
    ).run(affiliateCode, userId || null, eventType);
  } catch (e) {
    console.log('[ride-mode] affiliate event insert failed:', e.message);
  }
}

// Stage 8: generate a ride-originated 10% discount code scoped to a passenger join.
// Expires in 7 days. Returns { code, expiresAt } or null on failure.
function generateRideDiscountCode(sessionId, driverUserId, affiliateCode) {
  try {
    const short = (sessionId || '').toString().replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase() || 'RIDE00';
    const rand = Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(0, 4).toUpperCase() || 'XYZW';
    const code = 'RIDE-' + short + '-' + rand;
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO ride_discount_codes (code, ride_session_id, driver_user_id, affiliate_code, discount_percent, expires_at)
      VALUES (?, ?, ?, ?, 10, ?)
    `).run(code, sessionId, driverUserId || null, affiliateCode || null, expiresAt);
    return { code, expiresAt };
  } catch (e) {
    console.log('[ride-mode] generateRideDiscountCode failed:', e.message);
    return null;
  }
}

app.get('/ride-mode', (req, res) => {
    res.sendFile(path.join(__dirname, 'ride-mode.html'));
});

app.post('/api/ride-mode/session', (req, res) => {
  try {
    const { sessionName, expectedRiderCount, vibePreset, driverAlias } = req.body || {};

    // Optional driver auth: if a token is present, link the session to a user.
    // Missing or invalid token is fine — Ride Mode works for anonymous drivers.
    const token = req.headers['x-auth-token'] || req.query.token || null;
    let driverUser = null;
    if (token) {
      try { driverUser = stmts.getUserByToken.get(token) || null; } catch (_) { driverUser = null; }
    }
    const driverUserId = driverUser ? driverUser.id : null;

    let session = createRideSession(
      sessionName || 'Ride Mode Session',
      Number(expectedRiderCount) || 5,
      vibePreset || 'Easy Wins',
      driverAlias || null,
      driverUserId
    );

    // If the driver user has an affiliate record, attach the code to the session.
    let affiliateCode = null;
    if (driverUser && driverUser.email) {
      try {
        const row = db.prepare('SELECT affiliate_code FROM affiliates WHERE email = ?').get(driverUser.email);
        if (row && row.affiliate_code) {
          affiliateCode = row.affiliate_code;
          session = setRideSessionAffiliateCode(session.id, affiliateCode) || session;
        }
      } catch (_) { /* non-fatal */ }
    }

    // DB event store: record the session start.
    try {
      db.prepare(
        `INSERT INTO ride_sessions (session_id, driver_user_id, affiliate_code, vibe_preset, expected_rider_count, session_status)
         VALUES (?, ?, ?, ?, ?, 'active')`
      ).run(session.id, driverUserId, affiliateCode, session.vibePreset, session.expectedCount);
    } catch (e) {
      console.log('[ride-mode] ride_sessions insert failed:', e.message);
    }

    // Affiliate event: ride_session_started
    recordRideAffiliateEvent(affiliateCode, driverUserId, 'ride_session_started');

    // Session-aware join URL + QR image URL -- passengers scan from any seat.
    const rideBaseUrl = (process.env.BASE_URL || 'https://hummatch.me').replace(/\/+$/, '');
    const joinUrl = `${rideBaseUrl}/ride-mode?join=${session.id}`;
    const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(joinUrl)}`;

    return res.json({ ok: true, session, joinUrl, qrImageUrl });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/ride-mode/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const viewerRole = req.query.viewer || 'driver';
  const participantId = req.query.participantId || null;
  const session = getRideSessionForViewer(sessionId, viewerRole, participantId);
  if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });
  return res.json({ ok: true, session });
});

app.post('/api/ride-mode/session/:sessionId/join', (req, res) => {
  const { sessionId } = req.params;
  const { participantName, preference } = req.body || {};

  // Session integrity guard: prevent stale QR joins into ended sessions.
  const existing = getRideSession(sessionId);
  if (!existing) return res.status(404).json({ ok: false, error: 'Session not found' });
  if (existing.status && existing.status !== 'active') {
    return res.status(410).json({ ok: false, error: 'Session is no longer active' });
  }

  // Build attribution metadata from the raw session (so driverUserId/affiliateCode
  // are captured without leaking via the public view).
  const raw = getRawRideSession(sessionId);
  const attributionMeta = {
    sessionId,
    driverUserId:      raw ? raw.driverUserId   : null,
    affiliateCode:     raw ? raw.affiliateCode  : null,
    joinedViaRideMode: true
  };

  const session = joinRideSession(sessionId, participantName || 'Guest', preference || 'Either', attributionMeta);
  if (!session) return res.status(404).json({ ok: false, error: 'Session not found or inactive' });

  // DB event store: bump rider count.
  try {
    db.prepare(
      `UPDATE ride_sessions SET actual_rider_count = ? WHERE session_id = ?`
    ).run(Math.max(session.joinedCount - 1, 0), sessionId);
  } catch (e) {
    console.log('[ride-mode] ride_sessions update failed:', e.message);
  }

  // Affiliate event: ride_session_join (only when session is affiliate-owned).
  if (raw && raw.affiliateCode) {
    recordRideAffiliateEvent(raw.affiliateCode, null, 'ride_session_join');
  }

  // Stage 8: mint a 10% ride-originated discount code for this passenger.
  const discount = generateRideDiscountCode(
    sessionId,
    raw ? raw.driverUserId : null,
    raw ? raw.affiliateCode : null
  );

  return res.json({
    ok: true,
    session,
    discountCode:      discount ? discount.code      : null,
    discountExpiresAt: discount ? discount.expiresAt : null,
    discountPercent:   discount ? 10                 : null
  });
});

app.post('/api/ride-mode/session/:sessionId/host', (req, res) => {
  const { sessionId } = req.params;
  const { participantId } = req.body || {};
  if (!participantId) return res.status(400).json({ ok: false, error: 'participantId required' });
  const assigned = assignRideHost(sessionId, participantId);
  if (!assigned) return res.status(404).json({ ok: false, error: 'Session or participant not found' });
  const session = getRideSessionForViewer(sessionId, 'host', participantId);
  return res.json({ ok: true, session });
});

// Store hum capture data for the current participant, then advance.
// Body: { participantId, low, normal, high, capturedAt }
// participantId is optional; if omitted the current participant is used.
app.post('/api/ride-mode/session/:sessionId/hum', (req, res) => {
  const { sessionId } = req.params;
  const { participantId, low, normal, high, capturedAt } = req.body || {};

  // Resolve participant: use provided id or fall back to the current participant
  // from a raw getSession call so we do not expose the internal sessions object.
  let resolvedParticipantId = participantId;
  if (!resolvedParticipantId) {
    const current = getRideSession(sessionId);
    if (!current) return res.status(404).json({ ok: false, error: 'Session not found' });
    resolvedParticipantId = current.currentParticipant ? current.currentParticipant.id : null;
  }
  if (!resolvedParticipantId) {
    return res.status(400).json({ ok: false, error: 'Could not resolve current participant' });
  }

  // Store hum data
  const humPayload = {
    low:        typeof low    === 'number' ? low    : null,
    normal:     typeof normal === 'number' ? normal : null,
    high:       typeof high   === 'number' ? high   : null,
    capturedAt: capturedAt || new Date().toISOString()
  };
  const afterHum = storeRideHumData(sessionId, resolvedParticipantId, humPayload);
  if (!afterHum) return res.status(404).json({ ok: false, error: 'Session or participant not found' });

  // If storeHumData completed the session (all passengers hummed), skip advance.
  // advanceRideSession returns null when isActive is false, which would send a 422.
  // Instead return the session view directly -- the driver poll will pick up isComplete.
  if (!afterHum.isActive || afterHum.isComplete) {
    return res.json({ ok: true, session: afterHum });
  }

  // Advance the session (mark current ready, move to next participant)
  const afterAdvance = advanceRideSession(sessionId);
  if (!afterAdvance) return res.json({ ok: true, session: afterHum }); // soft fallback

  return res.json({ ok: true, session: afterAdvance });
});

// Mark the current participant ready and advance to the next one.
// Kept for backwards compatibility; /hum is preferred when hum data is available.
app.post('/api/ride-mode/session/:sessionId/advance', (req, res) => {
  const session = advanceRideSession(req.params.sessionId);
  if (!session) return res.status(404).json({ ok: false, error: 'Session not found or already complete' });
  return res.json({ ok: true, session });
});

app.post('/api/ride-mode/session/:sessionId/end', (req, res) => {
  const { sessionId } = req.params;
  const raw = getRawRideSession(sessionId);
  const session = endRideSession(sessionId);
  if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });

  // DB event store: mark completed with final counts.
  try {
    const hummedCount = raw
      ? raw.participants.filter(function(p) { return !!p.humData; }).length
      : 0;
    db.prepare(
      `UPDATE ride_sessions
         SET session_status = 'completed',
             completed_at = datetime('now'),
             hum_completed_count = ?
       WHERE session_id = ?`
    ).run(hummedCount, sessionId);
  } catch (e) {
    console.log('[ride-mode] ride_sessions end update failed:', e.message);
  }

  return res.json({ ok: true, session });
});

// Return session-aware scored results for a completed session.
// scoreResultsById uses the raw internal session (with humData intact) so scoring
// is driven by actual captured notes, not the privacy-filtered public view.
app.get('/api/ride-mode/session/:sessionId/results', (req, res) => {
  const { sessionId } = req.params;
  const sessionView = getRideSession(sessionId);
  if (!sessionView) return res.status(404).json({ ok: false, error: 'Session not found' });
  const scored = scoreRideResultsById(sessionId, 5);
  if (!scored) return res.status(404).json({ ok: false, error: 'Session not found' });
  return res.json({ ok: true, session: sessionView, scored: scored });
});

// Stage 7: upgrade-intent signal endpoint for ride-originated users. This is a
// lightweight hint — the actual checkout still goes through the existing
// /api/hummatch/checkout/:plan handler. We just return the correct upgrade
// path for a ride-originated caller and log the intent for attribution.
app.post('/api/ride-mode/session/:sessionId/upgrade-intent', (req, res) => {
  const { sessionId } = req.params;
  const { userToken } = req.body || {};

  const sessionView = getRideSession(sessionId);
  if (!sessionView) return res.status(404).json({ ok: false, error: 'Session not found' });
  const raw = getRawRideSession(sessionId);

  let userId = null;
  if (userToken) {
    try {
      const u = stmts.getUserByToken.get(userToken);
      if (u) userId = u.id;
    } catch (_) { /* ignore */ }
  }

  const affiliateCode = raw ? raw.affiliateCode : null;
  const hasStripe = !!(STRIPE_PRICES && STRIPE_PRICES.monthly);

  // Record the intent for later attribution reporting.
  if (affiliateCode) {
    recordRideAffiliateEvent(affiliateCode, userId, 'ride_upgrade_intent');
  }

  const payload = {
    ok:             true,
    upgradeUrl:     '/pricing',
    plan:           'monthly',
    sessionId,
    driverOwned:    !!(raw && raw.driverUserId),
    rideOriginated: true
  };
  if (hasStripe) payload.checkoutUrl = '/api/hummatch/checkout/monthly';

  return res.json(payload);
});

// Stage 8: Remind Me Later — store the reminder and send an email (SMS deferred).
app.post('/api/ride-mode/session/:sessionId/remind', async (req, res) => {
  const { sessionId } = req.params;
  const { channel, destination, discountCode, discountExpiresAt } = req.body || {};

  const chan = (channel || '').toString().toLowerCase();
  const dest = (destination || '').toString().trim();
  console.log('[ride-mode] reminder request', { sessionId, chan, dest: dest ? (dest.slice(0,3) + '***') : '' });
  if (!dest || (chan !== 'email' && chan !== 'sms')) {
    return res.status(400).json({ ok: false, error: 'channel (email|sms) and destination required' });
  }

  const raw = getRawRideSession(sessionId);
  const driverUserId  = raw ? raw.driverUserId  : null;
  const affiliateCode = raw ? raw.affiliateCode : null;

  // Insert the reminder record up front so we keep an attribution record even if send fails.
  let reminderId = null;
  try {
    const result = db.prepare(`
      INSERT INTO ride_reminders
        (ride_session_id, driver_user_id, affiliate_code, discount_code, discount_expires_at,
         reminder_channel, reminder_destination)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId, driverUserId, affiliateCode,
      discountCode || null, discountExpiresAt || null,
      chan, dest
    );
    reminderId = result.lastInsertRowid;
  } catch (e) {
    console.log('[ride-mode] ride_reminders insert failed:', e.message);
  }

  const params = new URLSearchParams();
  if (discountCode)   params.set('rideDiscountCode',  discountCode);
  if (sessionId)      params.set('rideSessionId',     sessionId);
  if (affiliateCode)  params.set('rideAffiliateCode', affiliateCode);
  const pricingLink = 'https://hummatch.me/pricing' + (params.toString() ? '?' + params.toString() : '');

  if (chan === 'sms') {
    // No SMS provider configured yet. Log and defer.
    console.log('[ride-mode] SMS reminder deferred for', dest, 'link=', pricingLink);
    return res.json({ ok: true, channel: 'sms', sent: false, deferred: true });
  }

  // Email path
  let expiresReadable = '';
  try {
    if (discountExpiresAt) {
      expiresReadable = new Date(discountExpiresAt).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric'
      });
    }
  } catch (_) { expiresReadable = ''; }

  const scored = scoreRideResultsForEmail(sessionId, 5);
  const results = scored && Array.isArray(scored.results) ? scored.results.slice(0, 5) : [];
  const listHtml = results.length
    ? ('<div style="margin:20px 0 18px;">' + results.map(function(song, idx) {
        var pct = typeof song.fitPct === 'number' ? (' — ' + song.fitPct + '%') : '';
        return '<div style="padding:10px 12px;border:1px solid #ece7f6;border-radius:10px;margin-bottom:8px;background:#faf7ff;">'
          + '<div style="font-weight:700;color:#1a1a1a;">' + (idx + 1) + '. ' + (song.title || 'Unknown song') + '</div>'
          + '<div style="font-size:0.92rem;color:#5b5670;">' + (song.artist || 'Unknown artist') + pct + '</div>'
          + '</div>';
      }).join('') + '</div>')
    : '<p style="font-size:0.95rem;line-height:1.5;color:#444;">Your results are waiting on HumMatch.</p>';

  const subject = 'Your HumMatch ride results are ready';
  const html = [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a1a1a;">',
    '<h1 style="font-size:1.4rem;line-height:1.2;margin:0 0 14px;">Your Ride Mode song matches are ready.</h1>',
    '<p style="font-size:1rem;line-height:1.6;margin:0 0 14px;">Here are your Top 5 songs from Ride Mode.</p>',
    listHtml,
    discountCode
      ? ('<div style="margin:20px 0;padding:16px 18px;border-radius:12px;background:#f5f3ff;border:1px solid #ddd6fe;">'
          + '<div style="font-size:0.85rem;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#7c3aed;margin-bottom:6px;">Driver courtesy offer</div>'
          + '<div style="font-size:1rem;line-height:1.5;color:#1a1a1a;">Your 10% driver courtesy code: <strong>' + discountCode + '</strong></div>'
          + (expiresReadable ? '<div style="font-size:0.9rem;color:#5b5670;margin-top:4px;">Good for 7 days — through ' + expiresReadable + '.</div>' : '<div style="font-size:0.9rem;color:#5b5670;margin-top:4px;">Good for 7 days.</div>')
          + '</div>')
      : '',
    '<p style="margin:24px 0 10px;">',
    '<a href="' + pricingLink + '" style="background:linear-gradient(135deg,#A855F7,#EC4899);color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-weight:700;display:inline-block;">See what SquadMatch unlocks</a>',
    '</p>',
    '<p style="font-size:0.92rem;color:#555;line-height:1.5;margin:0;">Your 10% Ride Mode offer will be applied on HumMatch.</p>',
    '</div>'
  ].join('');

  let sent = false;
  try {
    console.log('[ride-mode] sending reminder email to', dest.slice(0,3) + '***', 'link=', pricingLink);
    sent = !!(await sendEmail(dest, subject, html));
    console.log('[ride-mode] reminder email result: sent=', sent);
  } catch (e) {
    console.log('[ride-mode] reminder email send failed:', e.message);
  }

  if (sent && reminderId) {
    try {
      db.prepare('UPDATE ride_reminders SET reminder_sent_at = datetime(\'now\') WHERE id = ?').run(reminderId);
    } catch (_) { /* non-fatal */ }
  }

  return res.json({ ok: true, channel: 'email', sent });
});

// SPA fallback: serve index.html for unmatched routes. MUST be registered
// last so it does not shadow routes defined later in the file (notably the
// ride-mode block, which is declared after app.listen()).
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || path.extname(req.path)) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});
