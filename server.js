const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const { Server } = require('socket.io');

const db = require('./db/database');
require('./db/init'); // dam bao schema + seed da san sang

const authRoutes = require('./routes/auth');
const teamRoutes = require('./routes/team');
const adminRoutes = require('./routes/admin');
const { resolveLoginBackground } = require('./utils/mapBackground');

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'teambuilding-fit-secret-doi-truoc-khi-deploy-that';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 12 }, // 12h, du cho 1 su kien
});

app.use(express.json());
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

// Chia se session giua express va socket.io
io.engine.use(sessionMiddleware);

app.use('/api/auth', authRoutes);
app.use('/api/team', teamRoutes(io));
app.use('/api/admin', adminRoutes(io));

// Anh nen trang dang nhap (khong can dang nhap de xem) - dat file public/img/login-background.<duoi anh>
app.get('/api/public/login-background', (req, res) => {
  res.json({ background_image: resolveLoginBackground() });
});

// ---------------- Socket.io realtime ----------------
io.on('connection', (socket) => {
  const sess = socket.request.session;

  if (sess && sess.isAdmin) {
    socket.join('admins');
  }
  if (sess && sess.teamId) {
    socket.join(`team-${sess.teamId}`);
    socket.join('final-players'); // moi doi da dang nhap co the tham gia man hinh chung ket
  }

  // Gui trang thai chung ket hien tai ngay khi ket noi
  socket.emit('final:state', getFinalStatePayload());

  socket.on('final:buzz', () => {
    if (!sess || !sess.teamId) return;
    const state = db.prepare('SELECT * FROM final_state WHERE id = 1').get();
    if (state.phase !== 'question_open') return; // da co doi bam truoc hoac chua mo chuong

    const now = new Date().toISOString();
    db.prepare(`UPDATE final_state SET phase = 'buzzed', buzzer_winner_team_id = ?, buzz_locked_at = ? WHERE id = 1`)
      .run(sess.teamId, now);

    io.to('final-players').to('admins').emit('final:state', getFinalStatePayload());
  });

  socket.on('disconnect', () => {});
});

function getFinalStatePayload() {
  const state = db.prepare('SELECT * FROM final_state WHERE id = 1').get();
  const question = state.current_question_id
    ? db.prepare('SELECT id, order_index, question_text, points, status FROM final_questions WHERE id = ?').get(state.current_question_id)
    : null;
  const winnerTeam = state.buzzer_winner_team_id
    ? db.prepare('SELECT id, name, color FROM teams WHERE id = ?').get(state.buzzer_winner_team_id)
    : null;
  return {
    phase: state.phase,
    question,
    winnerTeam,
    buzz_open_at: state.buzz_open_at,
    buzz_locked_at: state.buzz_locked_at,
  };
}

app.set('io', io);
app.set('getFinalStatePayload', getFinalStatePayload);

server.listen(PORT, () => {
  console.log(`Teambuilding FIT dang chay tai http://localhost:${PORT}`);
});
