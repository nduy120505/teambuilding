const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');

const router = express.Router();

// ---- Dang nhap doi choi ----
router.post('/team/login', (req, res) => {
  const { code, password } = req.body || {};
  if (!code || !password) return res.status(400).json({ error: 'Thiếu mã đội hoặc mật khẩu' });

  const team = db.prepare('SELECT * FROM teams WHERE code = ?').get(code.trim().toUpperCase());
  if (!team || !bcrypt.compareSync(password, team.password_hash)) {
    return res.status(401).json({ error: 'Mã đội hoặc mật khẩu không đúng' });
  }

  req.session.teamId = team.id;
  req.session.teamCode = team.code;
  res.json({ ok: true, team: { id: team.id, code: team.code, name: team.name, color: team.color } });
});

router.post('/team/logout', (req, res) => {
  req.session.teamId = null;
  req.session.teamCode = null;
  res.json({ ok: true });
});

router.get('/team/me', (req, res) => {
  if (!req.session.teamId) return res.status(401).json({ error: 'Chưa đăng nhập' });
  const team = db.prepare('SELECT id, code, name, color, total_points FROM teams WHERE id = ?').get(req.session.teamId);
  if (!team) return res.status(401).json({ error: 'Không tìm thấy đội' });
  res.json({ team });
});

// ---- Dang nhap admin ----
router.post('/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Thiếu tài khoản hoặc mật khẩu' });

  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username.trim());
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.status(401).json({ error: 'Tài khoản hoặc mật khẩu không đúng' });
  }

  req.session.isAdmin = true;
  req.session.adminUsername = admin.username;
  res.json({ ok: true, admin: { username: admin.username, display_name: admin.display_name } });
});

router.post('/admin/logout', (req, res) => {
  req.session.isAdmin = false;
  res.json({ ok: true });
});

router.get('/admin/me', (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ error: 'Chưa đăng nhập' });
  res.json({ admin: { username: req.session.adminUsername } });
});

module.exports = router;
