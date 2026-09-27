const express = require('express');
const db = require('../db/database');
const { requireTeam } = require('../middleware/auth');
const { resolveMapBackground, resolveStickerImage } = require('../utils/mapBackground');

module.exports = function (io) {
  const router = express.Router();
  router.use(requireTeam);

  // ---------------- MAP ----------------
  // Moi doi co lo trinh (schedule) rieng do ban to chuc xep: chi gom cac tro doi da duoc
  // xep lich (round_no khong NULL), theo dung thu tu round_no cua doi do.
  router.get('/map', (req, res) => {
    const teamId = req.session.teamId;
    const schedule = db.prepare(`
      SELECT s.id as stage_id, s.name, s.description, s.kind, s.x_percent, s.y_percent, s.icon, s.location_name,
             tss.status, tss.round_no, tss.note
      FROM team_stage_status tss
      JOIN stages s ON s.id = tss.stage_id
      WHERE tss.team_id = ? AND tss.round_no IS NOT NULL
      ORDER BY tss.round_no ASC
    `).all(teamId);

    const opponentStmt = db.prepare(`
      SELECT t.id, t.name, t.color FROM team_stage_opponents o
      JOIN teams t ON t.id = o.opponent_team_id
      WHERE o.team_id = ? AND o.stage_id = ?
    `);
    const scheduleWithOpponents = schedule.map(s => ({ ...s, opponents: opponentStmt.all(teamId, s.stage_id) }));

    res.json({ background_image: resolveMapBackground(), schedule: scheduleWithOpponents });
  });

  // ---------------- SCORE ----------------
  router.get('/score', (req, res) => {
    const teamId = req.session.teamId;
    const team = db.prepare('SELECT id, name, total_points FROM teams WHERE id = ?').get(teamId);
    const history = db.prepare(`
      SELECT id, delta, reason, round_name, created_at
      FROM score_history WHERE team_id = ? ORDER BY id DESC
    `).all(teamId);

    const leaderboard = db.prepare(`
      SELECT id, name, color, total_points FROM teams ORDER BY total_points DESC, name ASC
    `).all();

    res.json({ team, history, leaderboard });
  });

  // ---------------- STICKERS (thay the "Doi qua" cu) ----------------
  // Doi chi XEM kho sticker cua minh (dang giu + da dung) - viec AP DUNG sticker do BTC thuc
  // hien tren dashboard (xem routes/admin.js -> /stickers/apply), doi khong tu dung duoc.
  router.get('/stickers', (req, res) => {
    const teamId = req.session.teamId;
    const catalog = db.prepare('SELECT key, name, description, image_url FROM stickers ORDER BY id ASC').all();
    const mine = db.prepare(`
      SELECT ts.id, ts.sticker_key, ts.status, ts.awarded_at, ts.awarded_reason,
             ts.used_at, tt.name as target_team_name
      FROM team_stickers ts
      LEFT JOIN teams tt ON tt.id = ts.target_team_id
      WHERE ts.team_id = ? ORDER BY ts.id DESC
    `).all(teamId);
    const stickers = catalog.map(s => ({
      ...s,
      image_url: s.image_url || resolveStickerImage(s.key),
      available_count: mine.filter(m => m.sticker_key === s.key && m.status === 'available').length,
      history: mine.filter(m => m.sticker_key === s.key),
    }));
    res.json({ stickers });
  });

  // ---------------- FINAL ROUND ----------------
  router.get('/final/state', (req, res) => {
    res.json(req.app.get('getFinalStatePayload')());
  });

  router.post('/final/violation', (req, res) => {
    const teamId = req.session.teamId;
    const { type, detail } = req.body || {};
    if (!type) return res.status(400).json({ error: 'Thiếu loại vi phạm' });

    db.prepare('INSERT INTO violations (team_id, type, detail) VALUES (?, ?, ?)').run(teamId, type, detail || '');
    const team = db.prepare('SELECT name FROM teams WHERE id = ?').get(teamId);
    io.to('admins').emit('final:violation', {
      team_id: teamId,
      team_name: team ? team.name : '?',
      type,
      detail,
      created_at: new Date().toISOString(),
    });
    res.json({ ok: true });
  });

  return router;
};
