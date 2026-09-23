const express = require('express');
const db = require('../db/database');
const { requireTeam } = require('../middleware/auth');
const { resolveMapBackground } = require('../utils/mapBackground');

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

    const elements = db.prepare(`
      SELECT id, type, label, x_percent, y_percent, image_url, link_url, extra_json
      FROM map_elements
      WHERE visible = 1 AND (team_id IS NULL OR team_id = ?)
      ORDER BY id ASC
    `).all(teamId);

    res.json({ background_image: resolveMapBackground(), schedule: scheduleWithOpponents, elements });
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

  // ---------------- GIFTS ----------------
  router.get('/gifts', (req, res) => {
    const teamId = req.session.teamId;
    const gifts = db.prepare('SELECT * FROM gifts WHERE active = 1 ORDER BY cost_points ASC').all();
    const myRedemptions = db.prepare(`
      SELECT r.id, r.points_spent, r.status, r.created_at, g.name as gift_name
      FROM redemptions r JOIN gifts g ON g.id = r.gift_id
      WHERE r.team_id = ? ORDER BY r.id DESC
    `).all(teamId);
    const team = db.prepare('SELECT total_points FROM teams WHERE id = ?').get(teamId);
    res.json({ gifts, myRedemptions, total_points: team.total_points });
  });

  router.post('/gifts/:id/redeem', (req, res) => {
    const teamId = req.session.teamId;
    const giftId = Number(req.params.id);

    const gift = db.prepare('SELECT * FROM gifts WHERE id = ? AND active = 1').get(giftId);
    if (!gift) return res.status(404).json({ error: 'Không tìm thấy quà' });
    if (gift.stock <= 0) return res.status(400).json({ error: 'Quà đã hết' });

    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
    if (team.total_points < gift.cost_points) {
      return res.status(400).json({ error: 'Đội chưa đủ điểm để đổi quà này' });
    }

    let redemptionId;
    try {
      db.exec('BEGIN');
      db.prepare('UPDATE gifts SET stock = stock - 1 WHERE id = ?').run(giftId);
      db.prepare('UPDATE teams SET total_points = total_points - ? WHERE id = ?').run(gift.cost_points, teamId);
      db.prepare(`INSERT INTO score_history (team_id, delta, reason, round_name, created_by)
                  VALUES (?, ?, ?, ?, ?)`)
        .run(teamId, -gift.cost_points, `Đổi quà: ${gift.name}`, 'Đổi quà', team.code);
      const info = db.prepare(`INSERT INTO redemptions (team_id, gift_id, points_spent, status)
                  VALUES (?, ?, ?, 'pending')`).run(teamId, giftId, gift.cost_points);
      redemptionId = info.lastInsertRowid;
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (e2) { /* ignore */ }
      return res.status(500).json({ error: 'Có lỗi khi đổi quà, thử lại sau' });
    }

    const updatedTeam = db.prepare('SELECT id, total_points FROM teams WHERE id = ?').get(teamId);
    io.to(`team-${teamId}`).to('admins').emit('score:update', {
      team_id: teamId,
      total_points: updatedTeam.total_points,
    });
    io.to('admins').emit('redemption:new', { redemption_id: redemptionId, team_id: teamId });

    res.json({ ok: true, total_points: updatedTeam.total_points });
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
