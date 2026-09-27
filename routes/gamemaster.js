const express = require('express');
const db = require('../db/database');
const { requireGameMaster } = require('../middleware/auth');
const { GAME_SCORING_RULES, computeGameScoring, applyGameScoring } = require('../utils/scoring');

// Route rieng cho tai khoan "quan tro": 1 quan tro co the phu trach NHIEU tro (xem
// game_master_assignments), nen client PHAI gui kem "game" muon cham diem, nhung server luon
// doi chieu voi danh sach duoc phan cong trong session (req.session.gameMasterGames) truoc khi
// cho phep - khong bao gio tin tuong da mot cach mo, quan tro khong the tu y cham diem tro
// khong duoc giao du co sua request.
module.exports = function (io) {
  const router = express.Router();
  router.use(requireGameMaster);

  router.get('/me', (req, res) => {
    const games = req.session.gameMasterGames || [];
    res.json({
      gameMaster: {
        username: req.session.gameMasterUsername,
        assigned_games: games.map(key => ({ key, label: (GAME_SCORING_RULES[key] || {}).label || key })),
      },
    });
  });

  // Danh sach doi de quan tro chon khi nhap ket qua (chi can id/ten/mau, khong can diem tong).
  router.get('/teams', (req, res) => {
    const teams = db.prepare('SELECT id, name, color FROM teams ORDER BY name ASC').all();
    res.json({ teams });
  });

  router.post('/score', (req, res) => {
    const game = (req.body || {}).game;
    const allowed = req.session.gameMasterGames || [];
    if (!allowed.includes(game)) {
      return res.status(403).json({ error: 'Bạn không được phân công phụ trách trò này' });
    }
    const entries = Array.isArray((req.body || {}).entries) ? req.body.entries : [];
    const { results, rule, error } = computeGameScoring(game, entries);
    if (error) return res.status(400).json({ error });

    applyGameScoring(db, io, results, rule, `Quản trò: ${req.session.gameMasterUsername}`);
    res.json({ ok: true, results });
  });

  // Lich su cham diem CUA RIENG cac tro quan tro nay duoc phan cong, de xem lai minh vua cham gi.
  router.get('/history', (req, res) => {
    const allowed = req.session.gameMasterGames || [];
    const labels = allowed.map(g => (GAME_SCORING_RULES[g] || {}).label).filter(Boolean);
    if (!labels.length) return res.json({ history: [] });
    const placeholders = labels.map(() => '?').join(',');
    const history = db.prepare(`
      SELECT sh.id, sh.team_id, t.name as team_name, sh.delta, sh.reason, sh.round_name, sh.created_at, sh.created_by
      FROM score_history sh
      JOIN teams t ON t.id = sh.team_id
      WHERE sh.round_name IN (${placeholders})
      ORDER BY sh.id DESC LIMIT 100
    `).all(...labels);
    res.json({ history });
  });

  return router;
};
