const express = require('express');
const db = require('../db/database');
const { requireGameMaster } = require('../middleware/auth');
const { GAME_SCORING_RULES, computeGameScoring, applyGameScoring } = require('../utils/scoring');

// Route rieng cho tai khoan "quan tro": moi quan tro chi thao tac duoc VOI TRO CUA MINH
// (req.session.gameMasterGame) - khong nhan game tu client de tranh quan tro tu y cham
// diem tro cua nguoi khac.
module.exports = function (io) {
  const router = express.Router();
  router.use(requireGameMaster);

  router.get('/me', (req, res) => {
    const rule = GAME_SCORING_RULES[req.session.gameMasterGame];
    res.json({
      gameMaster: {
        username: req.session.gameMasterUsername,
        assigned_game: req.session.gameMasterGame,
        assigned_game_label: rule ? rule.label : req.session.gameMasterGame,
      },
    });
  });

  // Danh sach doi de quan tro chon khi nhap ket qua (chi can id/ten/mau, khong can diem tong).
  router.get('/teams', (req, res) => {
    const teams = db.prepare('SELECT id, name, color FROM teams ORDER BY name ASC').all();
    res.json({ teams });
  });

  router.post('/score', (req, res) => {
    const game = req.session.gameMasterGame; // luon lay tu session, bo qua game client gui len (neu co)
    const entries = Array.isArray((req.body || {}).entries) ? req.body.entries : [];
    const { results, rule, error } = computeGameScoring(game, entries);
    if (error) return res.status(400).json({ error });

    applyGameScoring(db, io, results, rule, `Quản trò: ${req.session.gameMasterUsername}`);
    res.json({ ok: true, results });
  });

  // Lich su cham diem CUA RIENG tro nay, de quan tro xem lai minh vua cham gi.
  router.get('/history', (req, res) => {
    const rule = GAME_SCORING_RULES[req.session.gameMasterGame];
    const label = rule ? rule.label : req.session.gameMasterGame;
    const history = db.prepare(`
      SELECT sh.id, sh.team_id, t.name as team_name, sh.delta, sh.reason, sh.created_at, sh.created_by
      FROM score_history sh
      JOIN teams t ON t.id = sh.team_id
      WHERE sh.round_name = ?
      ORDER BY sh.id DESC LIMIT 100
    `).all(label);
    res.json({ history });
  });

  return router;
};
