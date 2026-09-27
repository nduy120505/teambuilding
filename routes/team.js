const express = require('express');
const db = require('../db/database');
const { requireTeam } = require('../middleware/auth');
const { resolveMapBackground, resolveStickerImage } = require('../utils/mapBackground');
const { STICKER_BY_KEY } = require('../utils/stickers');
const { clearBuzzCooldown } = require('../utils/buzzCooldown');

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
  // BTC trao sticker cho doi thu cong sau moi tro choi (routes/admin.js -> POST /stickers/grant).
  // DOI tu dung sticker khi vao vong chung ket (khong con phai nho BTC ap dung ho nua) - xem
  // POST /stickers/use ben duoi cho 4 hieu ung.
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

  // Danh sach doi khac (khong gom minh) de chon lam muc tieu khi dung sticker "Ke cuop"/"Dong bang".
  router.get('/teams', (req, res) => {
    const teams = db.prepare('SELECT id, name, color FROM teams WHERE id != ? ORDER BY name ASC').all(req.session.teamId);
    res.json({ teams });
  });

  // Doi TU DUNG 1 sticker minh dang co - hieu ung tuy loai (giong het logic truoc day BTC ap
  // dung ho, chi doi ten nguoi thuc hien tu admin sang chinh doi):
  // - ke_cuop: tru diem doi bi nham bang dung so diem lan tra loi dung GAN NHAT cua ho o vong
  //   chung ket (khong cong lai cho doi dung sticker).
  // - nhan_doi: cong them cho doi dung sticker dung bang tong diem hien co CUA RIENG vong
  //   chung ket (tuc nhan doi so diem chung ket, khong dung tong diem toan giai).
  // - dong_bang: chi dung duoc khi cau hoi dang mo cho bam chuong (phase='question_open') -
  //   chuyen thang quyen tra loi (thang buzz) sang doi dung sticker.
  // - ngoi_sao_hi_vong: chi dung duoc khi chua mo cau hoi tiep theo (phase='idle') - danh dau
  //   truoc quyen tra loi, se duoc "tieu thu" thanh thang buzz + thuong 7 diem ngay khi BTC mo
  //   cau hoi tiep theo (xem routes/admin.js -> /final/open/:questionId va /final/judge).
  router.post('/stickers/use', (req, res) => {
    const teamId = req.session.teamId;
    const { sticker_key, target_team_id } = req.body || {};
    const def = STICKER_BY_KEY[sticker_key];
    if (!def) return res.status(400).json({ error: 'Sticker không hợp lệ' });

    const owned = db.prepare(`SELECT * FROM team_stickers WHERE team_id = ? AND sticker_key = ? AND status = 'available' ORDER BY id ASC LIMIT 1`)
      .get(teamId, sticker_key);
    if (!owned) return res.status(400).json({ error: 'Bạn không có sticker này để dùng' });

    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
    const targetId = target_team_id ? Number(target_team_id) : null;
    if (targetId === teamId) return res.status(400).json({ error: 'Không thể nhắm vào chính đội mình' });
    let resultMsg = '';

    if (sticker_key === 'ke_cuop') {
      if (!targetId) return res.status(400).json({ error: 'Thiếu đội bị lấy điểm' });
      const targetTeam = db.prepare('SELECT * FROM teams WHERE id = ?').get(targetId);
      if (!targetTeam) return res.status(404).json({ error: 'Không tìm thấy đội bị nhắm' });
      const lastCorrect = db.prepare(`
        SELECT * FROM score_history WHERE team_id = ? AND round_name = 'Chung kết' AND delta > 0
        ORDER BY id DESC LIMIT 1
      `).get(targetId);
      if (!lastCorrect) return res.status(400).json({ error: 'Đội bị nhắm chưa có lượt trả lời đúng nào ở chung kết để lấy điểm' });
      const amount = lastCorrect.delta;
      db.prepare('UPDATE teams SET total_points = total_points - ? WHERE id = ?').run(amount, targetId);
      db.prepare(`INSERT INTO score_history (team_id, delta, reason, round_name, created_by)
                  VALUES (?, ?, ?, 'Chung kết', ?)`)
        .run(targetId, -amount, `Bị đội ${team.name} dùng sticker Kẻ cướp lấy đi ${amount} điểm`, `Đội: ${team.code}`);
      const updatedTarget = db.prepare('SELECT total_points FROM teams WHERE id = ?').get(targetId);
      io.to(`team-${targetId}`).to('admins').emit('score:update', { team_id: targetId, total_points: updatedTarget.total_points });
      resultMsg = `Bạn đã lấy ${amount} điểm của đội ${targetTeam.name}`;
    } else if (sticker_key === 'nhan_doi') {
      const row = db.prepare(`SELECT COALESCE(SUM(delta), 0) as total FROM score_history WHERE team_id = ? AND round_name = 'Chung kết'`).get(teamId);
      const current = row.total || 0;
      if (current <= 0) return res.status(400).json({ error: 'Đội chưa có điểm ở vòng chung kết để nhân đôi' });
      db.prepare('UPDATE teams SET total_points = total_points + ? WHERE id = ?').run(current, teamId);
      db.prepare(`INSERT INTO score_history (team_id, delta, reason, round_name, created_by)
                  VALUES (?, ?, ?, 'Chung kết', ?)`)
        .run(teamId, current, `Dùng sticker Nhân đôi (nhân đôi ${current} điểm chung kết)`, `Đội: ${team.code}`);
      const updated = db.prepare('SELECT total_points FROM teams WHERE id = ?').get(teamId);
      io.to(`team-${teamId}`).to('admins').emit('score:update', { team_id: teamId, total_points: updated.total_points });
      resultMsg = `Bạn đã nhân đôi ${current} điểm chung kết`;
    } else if (sticker_key === 'dong_bang') {
      if (!targetId) return res.status(400).json({ error: 'Thiếu đội bị khoá quyền trả lời' });
      const targetTeam = db.prepare('SELECT * FROM teams WHERE id = ?').get(targetId);
      if (!targetTeam) return res.status(404).json({ error: 'Không tìm thấy đội bị nhắm' });
      const state = db.prepare('SELECT * FROM final_state WHERE id = 1').get();
      if (state.phase !== 'question_open') {
        return res.status(400).json({ error: 'Chỉ dùng được khi câu hỏi đang mở chuông' });
      }
      clearBuzzCooldown();
      db.prepare(`UPDATE final_state SET phase='buzzed', buzzer_winner_team_id=?, buzz_locked_at=datetime('now') WHERE id=1`).run(teamId);
      io.to('final-players').to('admins').emit('final:state', req.app.get('getFinalStatePayload')());
      resultMsg = `Bạn đã khoá quyền trả lời của đội ${targetTeam.name} và giành quyền trả lời`;
    } else if (sticker_key === 'ngoi_sao_hi_vong') {
      const state = db.prepare('SELECT * FROM final_state WHERE id = 1').get();
      if (state.phase !== 'idle') {
        return res.status(400).json({ error: 'Chỉ dùng được khi chưa mở câu hỏi tiếp theo' });
      }
      db.prepare('UPDATE final_state SET pending_star_team_id = ? WHERE id = 1').run(teamId);
      io.to('admins').emit('final:state', req.app.get('getFinalStatePayload')());
      resultMsg = 'Bạn đã giành trước quyền trả lời câu hỏi tiếp theo';
    } else {
      return res.status(400).json({ error: 'Sticker không hợp lệ' });
    }

    db.prepare(`UPDATE team_stickers SET status='used', used_at=datetime('now'), used_by=?, target_team_id=? WHERE id=?`)
      .run(team.code, targetId, owned.id);
    io.to(`team-${teamId}`).to('admins').emit('stickers:update');

    res.json({ ok: true, message: resultMsg });
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
