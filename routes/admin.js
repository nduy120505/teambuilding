const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const { GAME_SCORING_RULES, computeGameScoring, applyGameScoring } = require('../utils/scoring');
const { STICKER_BY_KEY } = require('../utils/stickers');
const { resolveStickerImage } = require('../utils/mapBackground');
const { clearBuzzCooldown, setBuzzCooldownTimer } = require('../utils/buzzCooldown');

module.exports = function (io) {
  const router = express.Router();
  router.use(requireAdmin);

  // ================= TEAMS =================
  // Sap xep theo diem giam dan (dung nhu "Bang xep hang") de danh sach doi luon phan anh dung thu hang.
  router.get('/teams', (req, res) => {
    const teams = db.prepare('SELECT id, code, name, color, total_points, created_at FROM teams ORDER BY total_points DESC, name ASC').all();
    res.json({ teams });
  });

  router.post('/teams', (req, res) => {
    const { code, name, password, color } = req.body || {};
    if (!code || !name || !password) return res.status(400).json({ error: 'Thiếu mã đội / tên / mật khẩu' });
    const hash = bcrypt.hashSync(password, 10);
    try {
      const info = db.prepare('INSERT INTO teams (code, password_hash, name, color) VALUES (?, ?, ?, ?)')
        .run(code.trim().toUpperCase(), hash, name.trim(), color || '#22A559');
      // Khong con tu gan lo trinh mac dinh nua - ban to chuc se xep lo trinh rieng
      // cho doi nay trong tab "Lo trinh rieng tung doi".
      res.json({ ok: true, id: info.lastInsertRowid });
    } catch (e) {
      res.status(400).json({ error: 'Mã đội đã tồn tại' });
    }
  });

  router.put('/teams/:id', (req, res) => {
    const id = Number(req.params.id);
    const { name, color, password } = req.body || {};
    if (name) db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(name, id);
    if (color) db.prepare('UPDATE teams SET color = ? WHERE id = ?').run(color, id);
    if (password) db.prepare('UPDATE teams SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), id);
    res.json({ ok: true });
  });

  router.delete('/teams/:id', (req, res) => {
    db.prepare('DELETE FROM teams WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  // Da bo tinh nang "Tai khoan BTC" (chi con dung 1 tai khoan admin duy nhat, khong can
  // them/sua/xoa tai khoan admin phu nua) - theo yeu cau user. Bang `admins` van giu nguyen
  // trong schema (van dang dung de dang nhap), chi bo route quan ly nhieu tai khoan.

  // ================= TAI KHOAN QUAN TRO (1 quan tro co the phu trach NHIEU tro) =================
  const getAssignedGames = db.prepare('SELECT game_key FROM game_master_assignments WHERE game_master_id = ?');
  const deleteAssignments = db.prepare('DELETE FROM game_master_assignments WHERE game_master_id = ?');
  const insertAssignment = db.prepare('INSERT INTO game_master_assignments (game_master_id, game_key) VALUES (?, ?)');

  router.get('/game-masters', (req, res) => {
    const gameMasters = db.prepare('SELECT id, username, display_name FROM game_masters ORDER BY id ASC').all()
      .map(gm => ({ ...gm, assigned_games: getAssignedGames.all(gm.id).map(r => r.game_key) }));
    res.json({ gameMasters, games: Object.entries(GAME_SCORING_RULES).map(([key, v]) => ({ key, label: v.label })) });
  });

  router.post('/game-masters', (req, res) => {
    const { username, display_name, password, assigned_games } = req.body || {};
    const games = Array.isArray(assigned_games) ? [...new Set(assigned_games)] : [];
    if (!username || !password || !games.length) return res.status(400).json({ error: 'Thiếu tài khoản / mật khẩu / trò phụ trách' });
    for (const g of games) {
      if (!GAME_SCORING_RULES[g]) return res.status(400).json({ error: 'Trò phụ trách không hợp lệ' });
    }
    const hash = bcrypt.hashSync(password, 10);
    try {
      // Cot assigned_game (cu, 1-tro) chi con giu tro dau tien de tuong thich nguoc, khong con
      // duoc doc de xac dinh quyen - danh sach that su nam o bang game_master_assignments.
      const info = db.prepare('INSERT INTO game_masters (username, password_hash, display_name, assigned_game) VALUES (?, ?, ?, ?)')
        .run(username.trim(), hash, (display_name || '').trim() || 'Quản trò', games[0]);
      for (const g of games) insertAssignment.run(info.lastInsertRowid, g);
      res.json({ ok: true, id: info.lastInsertRowid });
    } catch (e) {
      res.status(400).json({ error: 'Tài khoản đã tồn tại' });
    }
  });

  router.put('/game-masters/:id', (req, res) => {
    const id = Number(req.params.id);
    const { display_name, password, assigned_games } = req.body || {};
    if (Array.isArray(assigned_games)) {
      const games = [...new Set(assigned_games)];
      for (const g of games) {
        if (!GAME_SCORING_RULES[g]) return res.status(400).json({ error: 'Trò phụ trách không hợp lệ' });
      }
      deleteAssignments.run(id);
      for (const g of games) insertAssignment.run(id, g);
      if (games[0]) db.prepare('UPDATE game_masters SET assigned_game = ? WHERE id = ?').run(games[0], id);
    }
    if (display_name !== undefined) db.prepare('UPDATE game_masters SET display_name = ? WHERE id = ?').run(display_name.trim(), id);
    if (password) db.prepare('UPDATE game_masters SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), id);
    res.json({ ok: true });
  });

  router.delete('/game-masters/:id', (req, res) => {
    db.prepare('DELETE FROM game_masters WHERE id = ?').run(Number(req.params.id)); // ON DELETE CASCADE xoa luon assignments
    res.json({ ok: true });
  });

  // ================= SCORES =================
  router.post('/teams/:id/score', (req, res) => {
    const teamId = Number(req.params.id);
    const { delta, reason, round_name } = req.body || {};
    const n = Number(delta);
    if (!Number.isFinite(n) || n === 0) return res.status(400).json({ error: 'Điểm không hợp lệ' });

    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
    if (!team) return res.status(404).json({ error: 'Không tìm thấy đội' });

    db.prepare('UPDATE teams SET total_points = total_points + ? WHERE id = ?').run(n, teamId);
    db.prepare(`INSERT INTO score_history (team_id, delta, reason, round_name, created_by)
                VALUES (?, ?, ?, ?, ?)`).run(teamId, n, reason || '', round_name || '', req.session.adminUsername);

    const updated = db.prepare('SELECT total_points FROM teams WHERE id = ?').get(teamId);
    io.to(`team-${teamId}`).to('admins').emit('score:update', {
      team_id: teamId,
      total_points: updated.total_points,
      delta: n,
      reason: reason || '',
      round_name: round_name || '',
    });
    res.json({ ok: true, total_points: updated.total_points });
  });

  router.get('/scores/history', (req, res) => {
    const rows = db.prepare(`
      SELECT sh.id, sh.team_id, t.name as team_name, sh.delta, sh.reason, sh.round_name, sh.created_at, sh.created_by
      FROM score_history sh JOIN teams t ON t.id = sh.team_id
      ORDER BY sh.id DESC LIMIT 200
    `).all();
    res.json({ history: rows });
  });

  // ================= TÍNH ĐIỂM TỰ ĐỘNG THEO TRÒ =================
  // Cong thuc diem cho tung tro co dinh cua su kien - BTC (hoac quan tro, xem routes/gamemaster.js)
  // chi nhap so lieu tho (so luot thang, so lan doan dung, thoi gian...), server tinh diem va cong
  // don thang vao total_points + score_history. Logic tinh diem dung chung o utils/scoring.js.
  router.get('/scoring/games', (req, res) => {
    res.json({ games: Object.entries(GAME_SCORING_RULES).map(([key, v]) => ({ key, label: v.label })) });
  });

  router.post('/scoring/:game', (req, res) => {
    const game = req.params.game;
    const entries = Array.isArray((req.body || {}).entries) ? req.body.entries : [];
    const { results, rule, error } = computeGameScoring(game, entries);
    if (error) return res.status(400).json({ error });

    applyGameScoring(db, io, results, rule, req.session.adminUsername);
    res.json({ ok: true, results });
  });

  // ================= STAGES / MAP =================
  // "Tro" (stages) la danh sach CO DINH 4 tro dung chung (Tro 1, Tro 3, Tro 4, Chung ket...),
  // kind = doi_khang | don | chung_ket. Lo trinh (thu tu + doi thu) cua TUNG DOI xem o muc
  // "Lo trinh rieng tung doi" ben duoi.
  router.get('/stages', (req, res) => {
    res.json({ stages: db.prepare('SELECT * FROM stages ORDER BY order_index ASC').all() });
  });

  router.post('/stages', (req, res) => {
    const { name, description, order_index, x_percent, y_percent, icon, kind, location_name } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Thiếu tên trò' });
    if (kind && !['doi_khang', 'don', 'chung_ket'].includes(kind)) {
      return res.status(400).json({ error: 'Loại trò không hợp lệ' });
    }
    const info = db.prepare(`INSERT INTO stages (name, description, order_index, x_percent, y_percent, icon, kind, location_name)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(name, description || '', order_index || 0, x_percent ?? 50, y_percent ?? 50, icon || 'flag', kind || 'doi_khang', location_name || '');
    io.emit('map:update');
    res.json({ ok: true, id: info.lastInsertRowid });
  });

  router.put('/stages/:id', (req, res) => {
    const id = Number(req.params.id);
    const { name, description, order_index, x_percent, y_percent, icon, kind, location_name } = req.body || {};
    const s = db.prepare('SELECT * FROM stages WHERE id = ?').get(id);
    if (!s) return res.status(404).json({ error: 'Không tìm thấy trò' });
    if (kind && !['doi_khang', 'don', 'chung_ket'].includes(kind)) {
      return res.status(400).json({ error: 'Loại trò không hợp lệ' });
    }
    db.prepare(`UPDATE stages SET name=?, description=?, order_index=?, x_percent=?, y_percent=?, icon=?, kind=?, location_name=? WHERE id=?`)
      .run(name ?? s.name, description ?? s.description, order_index ?? s.order_index,
        x_percent ?? s.x_percent, y_percent ?? s.y_percent, icon ?? s.icon, kind ?? s.kind,
        location_name !== undefined ? location_name : s.location_name, id);
    io.emit('map:update');
    res.json({ ok: true });
  });

  router.delete('/stages/:id', (req, res) => {
    db.prepare('DELETE FROM stages WHERE id = ?').run(Number(req.params.id));
    io.emit('map:update');
    res.json({ ok: true });
  });

  // ================= LỘ TRÌNH RIÊNG TỪNG ĐỘI =================
  // Moi doi co lo trinh (thu tu cac tro + doi thu) rieng, khong con giong het nhau.
  router.get('/teams/:teamId/schedule', (req, res) => {
    const teamId = Number(req.params.teamId);
    const rows = db.prepare(`
      SELECT tss.stage_id, tss.status, tss.round_no, tss.note, tss.updated_at,
             s.name as stage_name, s.description as stage_description, s.kind as stage_kind,
             s.x_percent, s.y_percent, s.icon, s.location_name
      FROM team_stage_status tss
      JOIN stages s ON s.id = tss.stage_id
      WHERE tss.team_id = ?
      ORDER BY (tss.round_no IS NULL), tss.round_no ASC
    `).all(teamId);

    const opponentStmt = db.prepare(`
      SELECT t.id, t.name, t.color FROM team_stage_opponents o
      JOIN teams t ON t.id = o.opponent_team_id
      WHERE o.team_id = ? AND o.stage_id = ?
    `);
    const schedule = rows.map(r => ({ ...r, opponents: opponentStmt.all(teamId, r.stage_id) }));
    res.json({ schedule });
  });

  // Tao/cap nhat 1 muc lich cho 1 nhom doi (1 doi = tro don/chung ket, 2+ doi = tro doi khang/tam dau)
  router.post('/schedule', (req, res) => {
    const { stage_id, team_ids, round_no, status, note } = req.body || {};
    const stageId = Number(stage_id);
    const ids = Array.isArray(team_ids) ? [...new Set(team_ids.map(Number))].filter(Boolean) : [];
    if (!stageId || ids.length === 0) return res.status(400).json({ error: 'Thiếu trò hoặc đội' });
    const stage = db.prepare('SELECT * FROM stages WHERE id = ?').get(stageId);
    if (!stage) return res.status(404).json({ error: 'Không tìm thấy trò' });
    const st = ['locked', 'current', 'completed'].includes(status) ? status : 'locked';

    const upsertStatus = db.prepare(`
      INSERT INTO team_stage_status (team_id, stage_id, status, round_no, note, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(team_id, stage_id) DO UPDATE SET
        status = excluded.status, round_no = excluded.round_no, note = excluded.note, updated_at = excluded.updated_at
    `);
    const clearOpponents = db.prepare('DELETE FROM team_stage_opponents WHERE team_id = ? AND stage_id = ?');
    const insertOpponent = db.prepare('INSERT OR IGNORE INTO team_stage_opponents (team_id, stage_id, opponent_team_id) VALUES (?, ?, ?)');

    for (const teamId of ids) {
      upsertStatus.run(teamId, stageId, st, round_no ?? null, note || null);
      clearOpponents.run(teamId, stageId);
      for (const otherId of ids) {
        if (otherId !== teamId) insertOpponent.run(teamId, stageId, otherId);
      }
      io.to(`team-${teamId}`).emit('map:update');
    }
    io.to('admins').emit('map:update');
    res.json({ ok: true });
  });

  router.delete('/teams/:teamId/schedule/:stageId', (req, res) => {
    const teamId = Number(req.params.teamId);
    const stageId = Number(req.params.stageId);
    db.prepare('DELETE FROM team_stage_status WHERE team_id = ? AND stage_id = ?').run(teamId, stageId);
    db.prepare('DELETE FROM team_stage_opponents WHERE stage_id = ? AND (team_id = ? OR opponent_team_id = ?)')
      .run(stageId, teamId, teamId);
    io.to(`team-${teamId}`).to('admins').emit('map:update');
    res.json({ ok: true });
  });

  // Da bo tinh nang "Phan tu tu do tren ban do" theo yeu cau - khong con route map-elements nua.
  // Bang map_elements van con trong schema (khong xoa de tranh migration pha huy tren DB dang chay)
  // nhung khong con duoc doc/ghi tu dau nua.

  // Ghi chu: anh nen ban do khong con quan ly qua UI/API nua. De doi anh, chi can thay
  // file public/img/map-background.<duoi anh> truc tiep tren o dia (xem README). Server tu
  // do quet thu muc public/img/ moi khi co doi xem ban do (routes/team.js -> resolveMapBackground()).

  // ================= STICKERS (thay the "Doi qua" cu) =================
  // 4 sticker "quyen nang" co dinh dung o vong chung ket, dinh nghia day du (ten/mo ta/tro
  // nguon) o utils/stickers.js. BTC TRAO sticker cho doi thu cong sau moi tro choi (khong con
  // tu dong theo ket qua cham diem) - viec DUNG hieu ung sticker do chinh DOI thuc hien khi vao
  // vong chung ket (xem routes/team.js -> POST /stickers/use), BTC khong con ap dung ho nua.
  router.get('/stickers', (req, res) => {
    const stickers = db.prepare('SELECT * FROM stickers ORDER BY id ASC').all()
      .map(s => ({ ...s, image_url: s.image_url || resolveStickerImage(s.key) }));
    res.json({ stickers });
  });

  router.put('/stickers/:key', (req, res) => {
    const key = req.params.key;
    const s = db.prepare('SELECT * FROM stickers WHERE key = ?').get(key);
    if (!s) return res.status(404).json({ error: 'Không tìm thấy sticker' });
    const { name, description, image_url } = req.body || {};
    db.prepare(`UPDATE stickers SET name=?, description=?, image_url=? WHERE key=?`)
      .run(name ?? s.name, description ?? s.description, image_url ?? s.image_url, key);
    res.json({ ok: true });
  });

  // Kho sticker cua tat ca cac doi (dang giu + da dung) de BTC theo doi.
  router.get('/stickers/inventory', (req, res) => {
    const rows = db.prepare(`
      SELECT ts.id, ts.team_id, t.name as team_name, ts.sticker_key, s.name as sticker_name,
             ts.status, ts.awarded_at, ts.awarded_reason, ts.awarded_by, ts.used_at, ts.used_by,
             ts.target_team_id, tt.name as target_team_name
      FROM team_stickers ts
      JOIN teams t ON t.id = ts.team_id
      JOIN stickers s ON s.key = ts.sticker_key
      LEFT JOIN teams tt ON tt.id = ts.target_team_id
      ORDER BY ts.id DESC
    `).all();
    res.json({ inventory: rows });
  });

  // BTC trao 1 sticker cho 1 doi (thuong lam ngay sau khi tro tuong ung ket thuc) - khong gioi
  // han so luong hay tu dong theo diem, BTC tu quyet dinh doi nao xung dang nhan sticker gi.
  router.post('/stickers/grant', (req, res) => {
    const { team_id, sticker_key, note } = req.body || {};
    const teamId = Number(team_id);
    const def = STICKER_BY_KEY[sticker_key];
    if (!teamId || !def) return res.status(400).json({ error: 'Thiếu đội hoặc sticker không hợp lệ' });
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
    if (!team) return res.status(404).json({ error: 'Không tìm thấy đội' });

    db.prepare(`INSERT INTO team_stickers (team_id, sticker_key, awarded_reason, awarded_by) VALUES (?, ?, ?, ?)`)
      .run(teamId, sticker_key, (note || '').trim() || `BTC trao sticker ${def.name}`, req.session.adminUsername);

    io.to(`team-${teamId}`).to('admins').emit('stickers:update');
    res.json({ ok: true, message: `Đã trao sticker "${def.name}" cho đội ${team.name}` });
  });

  // Thu hồi 1 sticker trao NHẦM (chỉ cho phép khi sticker đó CHƯA được đội dùng, để không phá
  // lịch sử hiệu ứng đã áp dụng thật).
  router.delete('/stickers/inventory/:id', (req, res) => {
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM team_stickers WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Không tìm thấy' });
    if (row.status !== 'available') return res.status(400).json({ error: 'Sticker này đã được dùng, không thể thu hồi' });
    db.prepare('DELETE FROM team_stickers WHERE id = ?').run(id);
    io.to(`team-${row.team_id}`).to('admins').emit('stickers:update');
    res.json({ ok: true });
  });

  // ================= FINAL ROUND =================
  router.get('/final/questions', (req, res) => {
    res.json({ questions: db.prepare('SELECT * FROM final_questions ORDER BY order_index ASC').all() });
  });

  router.post('/final/questions', (req, res) => {
    const { question_text, answer_text, points, order_index } = req.body || {};
    if (!question_text) return res.status(400).json({ error: 'Thiếu nội dung câu hỏi' });
    const info = db.prepare(`INSERT INTO final_questions (order_index, question_text, answer_text, points)
                VALUES (?, ?, ?, ?)`).run(order_index || 0, question_text, answer_text || '', points || 10);
    res.json({ ok: true, id: info.lastInsertRowid });
  });

  router.put('/final/questions/:id', (req, res) => {
    const id = Number(req.params.id);
    const q = db.prepare('SELECT * FROM final_questions WHERE id = ?').get(id);
    if (!q) return res.status(404).json({ error: 'Không tìm thấy câu hỏi' });
    const b = req.body || {};
    db.prepare(`UPDATE final_questions SET question_text=?, answer_text=?, points=?, order_index=? WHERE id=?`)
      .run(b.question_text ?? q.question_text, b.answer_text ?? q.answer_text,
        b.points ?? q.points, b.order_index ?? q.order_index, id);
    res.json({ ok: true });
  });

  router.delete('/final/questions/:id', (req, res) => {
    db.prepare('DELETE FROM final_questions WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  // Trang thai day du (rieng cho BTC) cua vong chung ket, gom ca pending_star_team_id - CHI
  // tra ve cho admin (khong dua vao getFinalStatePayload dung chung, vi payload do cung duoc
  // gui cho cac doi choi va se lo doi nao dang giu sticker "Ngoi sao hi vong" truoc khi dung).
  router.get('/final/state', (req, res) => {
    const state = db.prepare('SELECT * FROM final_state WHERE id = 1').get();
    const pendingStarTeam = state.pending_star_team_id
      ? db.prepare('SELECT id, name, color FROM teams WHERE id = ?').get(state.pending_star_team_id)
      : null;
    res.json({ ...req.app.get('getFinalStatePayload')(), pendingStarTeam });
  });

  router.post('/final/open/:questionId', (req, res) => {
    const questionId = Number(req.params.questionId);
    const q = db.prepare('SELECT * FROM final_questions WHERE id = ?').get(questionId);
    if (!q) return res.status(404).json({ error: 'Không tìm thấy câu hỏi' });

    clearBuzzCooldown();
    const state = db.prepare('SELECT * FROM final_state WHERE id = 1').get();

    // Neu co doi da dung sticker "Ngoi sao hi vong" cho cau tiep theo (pending_star_team_id),
    // "tieu thu" no ngay tai day: doi do thang buzz luon + duoc ghi nho thuong 7 diem co dinh
    // (thay vi diem cua cau hoi) khi BTC cham diem o /final/judge ben duoi.
    if (state.pending_star_team_id) {
      db.prepare(`UPDATE final_state SET phase='buzzed', current_question_id=?, buzzer_winner_team_id=?,
                  buzz_open_at=datetime('now'), buzz_locked_at=datetime('now'),
                  pending_star_team_id=NULL, bonus_team_id=?, bonus_flat_points=7 WHERE id=1`)
        .run(questionId, state.pending_star_team_id, state.pending_star_team_id);
    } else {
      db.prepare(`UPDATE final_state SET phase='question_open', current_question_id=?, buzzer_winner_team_id=NULL,
                  buzz_open_at=datetime('now'), buzz_locked_at=NULL, bonus_team_id=NULL, bonus_flat_points=NULL WHERE id=1`).run(questionId);
    }
    db.prepare(`UPDATE final_questions SET status='active' WHERE id=?`).run(questionId);

    io.to('final-players').to('admins').emit('final:state', req.app.get('getFinalStatePayload')());
    res.json({ ok: true });
  });

  router.post('/final/reset-buzzer', (req, res) => {
    clearBuzzCooldown();
    // Xoa luon bonus (neu co) vi reset chuong nghia la mo lai cho MOI doi tranh quyen, khong
    // con rieng cho doi da giu sticker "Ngoi sao hi vong" nua.
    db.prepare(`UPDATE final_state SET phase='question_open', buzzer_winner_team_id=NULL,
                buzz_open_at=datetime('now'), buzz_locked_at=NULL, bonus_team_id=NULL, bonus_flat_points=NULL WHERE id=1`).run();
    io.to('final-players').to('admins').emit('final:state', req.app.get('getFinalStatePayload')());
    res.json({ ok: true });
  });

  router.post('/final/close', (req, res) => {
    clearBuzzCooldown();
    const state = db.prepare('SELECT * FROM final_state WHERE id = 1').get();
    if (state.current_question_id) {
      db.prepare(`UPDATE final_questions SET status='closed' WHERE id=?`).run(state.current_question_id);
    }
    db.prepare(`UPDATE final_state SET phase='idle', buzzer_winner_team_id=NULL, bonus_team_id=NULL, bonus_flat_points=NULL WHERE id=1`).run();
    io.to('final-players').to('admins').emit('final:state', req.app.get('getFinalStatePayload')());
    res.json({ ok: true });
  });

  // Cham diem cho doi da bam chuong dung/sai, dong thoi cong diem tong.
  // Dung -> tu dong dong cau hoi + reset chuong ve trang thai cho (khong mo lai).
  // Sai -> khoa chuong 2 giay (phase 'wrong_cooldown') roi TU DONG mo lai cho cung cau hoi
  //        de cac doi khac co co hoi tranh quyen tra loi, khong can admin bam "Reset chuong" tay.
  router.post('/final/judge', (req, res) => {
    const { correct } = req.body || {};
    const state = db.prepare('SELECT * FROM final_state WHERE id = 1').get();
    if (!state.buzzer_winner_team_id || !state.current_question_id) {
      return res.status(400).json({ error: 'Chưa có đội nào bấm chuông' });
    }
    const questionId = state.current_question_id;
    const q = db.prepare('SELECT * FROM final_questions WHERE id = ?').get(questionId);
    const teamId = state.buzzer_winner_team_id;
    // Doi dang choi voi sticker "Ngoi sao hi vong" (bonus_team_id = doi nay) neu tra loi DUNG
    // thi duoc cong diem thuong co dinh (bonus_flat_points, mac dinh 7) thay vi diem cua cau hoi;
    // neu tra loi sai van bi tru diem cau hoi binh thuong (sticker khong bao ve khi tra loi sai).
    const hasBonus = state.bonus_team_id === teamId && state.bonus_flat_points;
    const delta = correct ? (hasBonus ? state.bonus_flat_points : q.points) : -q.points;

    db.prepare('UPDATE teams SET total_points = total_points + ? WHERE id = ?').run(delta, teamId);
    db.prepare(`INSERT INTO score_history (team_id, delta, reason, round_name, created_by)
                VALUES (?, ?, ?, 'Chung kết', ?)`)
      .run(teamId, delta, `${correct ? 'Trả lời đúng' : 'Trả lời sai'}: ${q.question_text}`, req.session.adminUsername);

    const updated = db.prepare('SELECT total_points FROM teams WHERE id = ?').get(teamId);
    io.to(`team-${teamId}`).to('admins').emit('score:update', { team_id: teamId, total_points: updated.total_points });

    clearBuzzCooldown();

    if (correct) {
      db.prepare(`UPDATE final_questions SET status='closed' WHERE id=?`).run(q.id);
      db.prepare(`UPDATE final_state SET phase='idle', buzzer_winner_team_id=NULL, bonus_team_id=NULL, bonus_flat_points=NULL WHERE id=1`).run();
      io.to('final-players').to('admins').emit('final:state', req.app.get('getFinalStatePayload')());
    } else {
      // Khoa chuong tam thoi de cac doi kip binh tinh / MC kip thong bao, sau 2 giay tu dong mo lai.
      // Xoa bonus vi sticker "Ngoi sao hi vong" chi ap dung cho luot bam dau tien cua doi da giu sao.
      db.prepare(`UPDATE final_state SET phase='wrong_cooldown', buzzer_winner_team_id=NULL, bonus_team_id=NULL, bonus_flat_points=NULL WHERE id=1`).run();
      io.to('final-players').to('admins').emit('final:state', req.app.get('getFinalStatePayload')());

      setBuzzCooldownTimer(setTimeout(() => {
        setBuzzCooldownTimer(null);
        // Chi mo lai neu van dang o dung cau hoi nay va chua bi admin thao tac gi khac trong luc cho
        const cur = db.prepare('SELECT * FROM final_state WHERE id = 1').get();
        if (cur.phase !== 'wrong_cooldown' || cur.current_question_id !== questionId) return;
        db.prepare(`UPDATE final_state SET phase='question_open', buzzer_winner_team_id=NULL, buzz_open_at=datetime('now') WHERE id=1`).run();
        io.to('final-players').to('admins').emit('final:state', req.app.get('getFinalStatePayload')());
      }, 2000));
    }

    res.json({ ok: true, total_points: updated.total_points });
  });

  // ================= VIOLATIONS =================
  router.get('/violations', (req, res) => {
    const rows = db.prepare(`
      SELECT v.id, v.team_id, t.name as team_name, v.type, v.detail, v.created_at
      FROM violations v JOIN teams t ON t.id = v.team_id
      ORDER BY v.id DESC LIMIT 200
    `).all();
    res.json({ violations: rows });
  });

  return router;
};
