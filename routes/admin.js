const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { requireAdmin } = require('../middleware/auth');

module.exports = function (io) {
  const router = express.Router();
  router.use(requireAdmin);

  // Hen gio tu dong mo lai chuong sau khi 1 doi tra loi SAI (xem final/judge ben duoi).
  // Luu o closure vi router nay chi duoc khoi tao 1 lan cho ca app.
  let buzzCooldownTimer = null;
  function clearBuzzCooldown() {
    if (buzzCooldownTimer) { clearTimeout(buzzCooldownTimer); buzzCooldownTimer = null; }
  }

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
  // Cong thuc diem cho tung tro co dinh cua su kien - BTC chi nhap so lieu tho (so luot thang,
  // so lan doan dung, thoi gian...), server tinh diem va cong don thang vao total_points +
  // score_history (giong nhu thao tac +-Diem thu cong, nhung tu dong tinh dung cong thuc).
  const GAME_SCORING_RULES = {
    khoi_dong: { label: 'Trò khởi động' },
    pha_vong_doat_bau: { label: 'Phá vòng đoạt báu' },
    ra_dau_bat_chu: { label: 'Ra Dấu Bắt Chữ' },
    mach_than_duoc: { label: 'Mạch Thần Dược' },
    noi_vong_tay_lon: { label: 'Nối vòng tay lớn' },
    cau_hoi_doi_gio: { label: 'Câu hỏi đợi giờ' },
  };

  router.get('/scoring/games', (req, res) => {
    res.json({ games: Object.entries(GAME_SCORING_RULES).map(([key, v]) => ({ key, label: v.label })) });
  });

  router.post('/scoring/:game', (req, res) => {
    const game = req.params.game;
    const rule = GAME_SCORING_RULES[game];
    if (!rule) return res.status(400).json({ error: 'Trò không hợp lệ' });
    const entries = Array.isArray((req.body || {}).entries) ? req.body.entries : [];
    if (!entries.length) return res.status(400).json({ error: 'Thiếu dữ liệu đội' });

    let results = []; // { team_id, delta, reason }

    if (game === 'khoi_dong') {
      // Chi 1 doi ve nhat, +5 diem. entries: [{ team_id }]
      const teamId = Number(entries[0].team_id);
      if (!teamId) return res.status(400).json({ error: 'Thiếu đội về nhất' });
      results.push({ team_id: teamId, delta: 5, reason: 'Trò khởi động: về nhất' });
    } else if (game === 'pha_vong_doat_bau') {
      // 3/3 luot = 15d, 2/3 = 10d, 1/3 = 5d, 0/3 = 0d. Tru 3d/lan pham luat (xo day...).
      const ROUND_POINTS = { 0: 0, 1: 5, 2: 10, 3: 15 };
      for (const e of entries) {
        const teamId = Number(e.team_id);
        if (!teamId) continue;
        const roundsWon = Math.max(0, Math.min(3, Math.round(Number(e.rounds_won) || 0)));
        const violations = Math.max(0, Math.round(Number(e.violations) || 0));
        const delta = (ROUND_POINTS[roundsWon] ?? 0) - violations * 3;
        let reason = `Phá vòng đoạt báu: thắng ${roundsWon}/3 lượt`;
        if (violations > 0) reason += `, phạm luật ${violations} lần (-${violations * 3}đ)`;
        results.push({ team_id: teamId, delta, reason });
      }
    } else if (game === 'ra_dau_bat_chu') {
      // 2 diem / lan doan dung
      for (const e of entries) {
        const teamId = Number(e.team_id);
        if (!teamId) continue;
        const n = Math.max(0, Math.round(Number(e.correct_guesses) || 0));
        results.push({ team_id: teamId, delta: n * 2, reason: `Ra Dấu Bắt Chữ: đoán đúng ${n} lần` });
      }
    } else if (game === 'mach_than_duoc') {
      // 3 diem / qua bong
      for (const e of entries) {
        const teamId = Number(e.team_id);
        if (!teamId) continue;
        const n = Math.max(0, Math.round(Number(e.balloons) || 0));
        results.push({ team_id: teamId, delta: n * 3, reason: `Mạch Thần Dược: ${n} quả bóng` });
      }
    } else if (game === 'noi_vong_tay_lon') {
      // Xep hang theo thoi gian (nho nhat = nhanh nhat = hang 1). Diem: nhat +12, nhi +9, ba +6, tu +3, bet +0.
      const RANK_POINTS = [12, 9, 6, 3, 0];
      const withTimes = entries
        .map(e => ({ team_id: Number(e.team_id), time_seconds: Number(e.time_seconds) }))
        .filter(e => e.team_id && Number.isFinite(e.time_seconds) && e.time_seconds > 0)
        .sort((a, b) => a.time_seconds - b.time_seconds);
      withTimes.forEach((e, idx) => {
        const delta = RANK_POINTS[idx] ?? 0;
        results.push({ team_id: e.team_id, delta, reason: `Nối vòng tay lớn: hạng ${idx + 1} (${e.time_seconds}s)` });
      });
    } else if (game === 'cau_hoi_doi_gio') {
      // 2 diem / cau tra loi dung
      for (const e of entries) {
        const teamId = Number(e.team_id);
        if (!teamId) continue;
        const n = Math.max(0, Math.round(Number(e.correct_answers) || 0));
        results.push({ team_id: teamId, delta: n * 2, reason: `Câu hỏi đợi giờ: trả lời đúng ${n} câu` });
      }
    }

    if (!results.length) return res.status(400).json({ error: 'Không có đội nào hợp lệ để tính điểm' });

    for (const r of results) {
      db.prepare('UPDATE teams SET total_points = total_points + ? WHERE id = ?').run(r.delta, r.team_id);
      db.prepare(`INSERT INTO score_history (team_id, delta, reason, round_name, created_by)
                  VALUES (?, ?, ?, ?, ?)`).run(r.team_id, r.delta, r.reason, rule.label, req.session.adminUsername);
    }

    const updatedTeams = db.prepare('SELECT id, total_points FROM teams').all();
    for (const r of results) {
      const t = updatedTeams.find(x => x.id === r.team_id);
      io.to(`team-${r.team_id}`).to('admins').emit('score:update', {
        team_id: r.team_id,
        total_points: t ? t.total_points : null,
        delta: r.delta,
        reason: r.reason,
        round_name: rule.label,
      });
    }

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

  // ================= GIFTS =================
  router.get('/gifts', (req, res) => {
    res.json({ gifts: db.prepare('SELECT * FROM gifts ORDER BY id ASC').all() });
  });

  router.post('/gifts', (req, res) => {
    const { name, description, cost_points, stock, image_url } = req.body || {};
    if (!name || cost_points == null) return res.status(400).json({ error: 'Thiếu tên hoặc số điểm' });
    const info = db.prepare(`INSERT INTO gifts (name, description, cost_points, stock, image_url) VALUES (?, ?, ?, ?, ?)`)
      .run(name, description || '', Number(cost_points), Number(stock) || 0, image_url || '');
    res.json({ ok: true, id: info.lastInsertRowid });
  });

  router.put('/gifts/:id', (req, res) => {
    const id = Number(req.params.id);
    const g = db.prepare('SELECT * FROM gifts WHERE id = ?').get(id);
    if (!g) return res.status(404).json({ error: 'Không tìm thấy quà' });
    const b = req.body || {};
    db.prepare(`UPDATE gifts SET name=?, description=?, cost_points=?, stock=?, image_url=?, active=? WHERE id=?`)
      .run(b.name ?? g.name, b.description ?? g.description, b.cost_points ?? g.cost_points,
        b.stock ?? g.stock, b.image_url ?? g.image_url,
        b.active !== undefined ? (b.active ? 1 : 0) : g.active, id);
    res.json({ ok: true });
  });

  router.delete('/gifts/:id', (req, res) => {
    db.prepare('DELETE FROM gifts WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  // ================= REDEMPTIONS =================
  router.get('/redemptions', (req, res) => {
    const rows = db.prepare(`
      SELECT r.id, r.team_id, t.name as team_name, r.gift_id, g.name as gift_name,
             r.points_spent, r.status, r.created_at, r.handled_at, r.handled_by
      FROM redemptions r
      JOIN teams t ON t.id = r.team_id
      JOIN gifts g ON g.id = r.gift_id
      ORDER BY r.id DESC
    `).all();
    res.json({ redemptions: rows });
  });

  router.put('/redemptions/:id', (req, res) => {
    const id = Number(req.params.id);
    const { status } = req.body || {};
    if (!['pending', 'approved', 'rejected', 'delivered'].includes(status)) {
      return res.status(400).json({ error: 'Trạng thái không hợp lệ' });
    }
    const redemption = db.prepare('SELECT * FROM redemptions WHERE id = ?').get(id);
    if (!redemption) return res.status(404).json({ error: 'Không tìm thấy' });

    // neu tu choi -> hoan diem va hoan kho
    if (status === 'rejected' && redemption.status !== 'rejected') {
      const team = db.prepare('SELECT code FROM teams WHERE id = ?').get(redemption.team_id);
      db.prepare('UPDATE teams SET total_points = total_points + ? WHERE id = ?').run(redemption.points_spent, redemption.team_id);
      db.prepare('UPDATE gifts SET stock = stock + 1 WHERE id = ?').run(redemption.gift_id);
      db.prepare(`INSERT INTO score_history (team_id, delta, reason, round_name, created_by)
                  VALUES (?, ?, ?, ?, ?)`)
        .run(redemption.team_id, redemption.points_spent, 'Hoàn điểm do đổi quà bị từ chối', 'Đổi quà', req.session.adminUsername);
      const updated = db.prepare('SELECT total_points FROM teams WHERE id = ?').get(redemption.team_id);
      io.to(`team-${redemption.team_id}`).to('admins').emit('score:update', {
        team_id: redemption.team_id, total_points: updated.total_points,
      });
    }

    db.prepare(`UPDATE redemptions SET status = ?, handled_at = datetime('now'), handled_by = ? WHERE id = ?`)
      .run(status, req.session.adminUsername, id);

    io.to(`team-${redemption.team_id}`).to('admins').emit('redemption:update', { id, status });
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

  router.post('/final/open/:questionId', (req, res) => {
    const questionId = Number(req.params.questionId);
    const q = db.prepare('SELECT * FROM final_questions WHERE id = ?').get(questionId);
    if (!q) return res.status(404).json({ error: 'Không tìm thấy câu hỏi' });

    clearBuzzCooldown();
    db.prepare(`UPDATE final_state SET phase='question_open', current_question_id=?, buzzer_winner_team_id=NULL,
                buzz_open_at=datetime('now'), buzz_locked_at=NULL WHERE id=1`).run(questionId);
    db.prepare(`UPDATE final_questions SET status='active' WHERE id=?`).run(questionId);

    io.to('final-players').to('admins').emit('final:state', req.app.get('getFinalStatePayload')());
    res.json({ ok: true });
  });

  router.post('/final/reset-buzzer', (req, res) => {
    clearBuzzCooldown();
    db.prepare(`UPDATE final_state SET phase='question_open', buzzer_winner_team_id=NULL,
                buzz_open_at=datetime('now'), buzz_locked_at=NULL WHERE id=1`).run();
    io.to('final-players').to('admins').emit('final:state', req.app.get('getFinalStatePayload')());
    res.json({ ok: true });
  });

  router.post('/final/close', (req, res) => {
    clearBuzzCooldown();
    const state = db.prepare('SELECT * FROM final_state WHERE id = 1').get();
    if (state.current_question_id) {
      db.prepare(`UPDATE final_questions SET status='closed' WHERE id=?`).run(state.current_question_id);
    }
    db.prepare(`UPDATE final_state SET phase='idle', buzzer_winner_team_id=NULL WHERE id=1`).run();
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
    const delta = correct ? q.points : -q.points;

    db.prepare('UPDATE teams SET total_points = total_points + ? WHERE id = ?').run(delta, teamId);
    db.prepare(`INSERT INTO score_history (team_id, delta, reason, round_name, created_by)
                VALUES (?, ?, ?, 'Chung kết', ?)`)
      .run(teamId, delta, `${correct ? 'Trả lời đúng' : 'Trả lời sai'}: ${q.question_text}`, req.session.adminUsername);

    const updated = db.prepare('SELECT total_points FROM teams WHERE id = ?').get(teamId);
    io.to(`team-${teamId}`).to('admins').emit('score:update', { team_id: teamId, total_points: updated.total_points });

    clearBuzzCooldown();

    if (correct) {
      db.prepare(`UPDATE final_questions SET status='closed' WHERE id=?`).run(q.id);
      db.prepare(`UPDATE final_state SET phase='idle', buzzer_winner_team_id=NULL WHERE id=1`).run();
      io.to('final-players').to('admins').emit('final:state', req.app.get('getFinalStatePayload')());
    } else {
      // Khoa chuong tam thoi de cac doi kip binh tinh / MC kip thong bao, sau 2 giay tu dong mo lai
      db.prepare(`UPDATE final_state SET phase='wrong_cooldown', buzzer_winner_team_id=NULL WHERE id=1`).run();
      io.to('final-players').to('admins').emit('final:state', req.app.get('getFinalStatePayload')());

      buzzCooldownTimer = setTimeout(() => {
        buzzCooldownTimer = null;
        // Chi mo lai neu van dang o dung cau hoi nay va chua bi admin thao tac gi khac trong luc cho
        const cur = db.prepare('SELECT * FROM final_state WHERE id = 1').get();
        if (cur.phase !== 'wrong_cooldown' || cur.current_question_id !== questionId) return;
        db.prepare(`UPDATE final_state SET phase='question_open', buzzer_winner_team_id=NULL, buzz_open_at=datetime('now') WHERE id=1`).run();
        io.to('final-players').to('admins').emit('final:state', req.app.get('getFinalStatePayload')());
      }, 2000);
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
