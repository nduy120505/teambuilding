// Cong thuc tinh diem cho 6 tro co dinh cua su kien - dung chung cho ca route
// admin (/api/admin/scoring/:game) va route quan tro (/api/gamemaster/score), de tranh
// viet trung logic va lech cong thuc giua 2 noi.

const GAME_SCORING_RULES = {
  khoi_dong: { label: 'Trò khởi động' },
  pha_vong_doat_bau: { label: 'Phá vòng đoạt báu' },
  ra_dau_bat_chu: { label: 'Ra Dấu Bắt Chữ' },
  mach_than_duoc: { label: 'Mạch Thần Dược' },
  noi_vong_tay_lon: { label: 'Nối vòng tay lớn' },
  cau_hoi_doi_gio: { label: 'Câu hỏi đợi giờ' },
};

// Tra ve { results, error } - results la mang { team_id, delta, reason }, error la string neu co loi.
function computeGameScoring(game, entries) {
  const rule = GAME_SCORING_RULES[game];
  if (!rule) return { error: 'Trò không hợp lệ' };
  if (!Array.isArray(entries) || !entries.length) return { error: 'Thiếu dữ liệu đội' };

  let results = [];

  if (game === 'khoi_dong') {
    const teamId = Number(entries[0].team_id);
    if (!teamId) return { error: 'Thiếu đội về nhất' };
    results.push({ team_id: teamId, delta: 5, reason: 'Trò khởi động: về nhất' });
  } else if (game === 'pha_vong_doat_bau') {
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
    for (const e of entries) {
      const teamId = Number(e.team_id);
      if (!teamId) continue;
      const n = Math.max(0, Math.round(Number(e.correct_guesses) || 0));
      results.push({ team_id: teamId, delta: n * 2, reason: `Ra Dấu Bắt Chữ: đoán đúng ${n} lần` });
    }
  } else if (game === 'mach_than_duoc') {
    for (const e of entries) {
      const teamId = Number(e.team_id);
      if (!teamId) continue;
      const n = Math.max(0, Math.round(Number(e.balloons) || 0));
      results.push({ team_id: teamId, delta: n * 3, reason: `Mạch Thần Dược: ${n} quả bóng` });
    }
  } else if (game === 'noi_vong_tay_lon') {
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
    for (const e of entries) {
      const teamId = Number(e.team_id);
      if (!teamId) continue;
      const n = Math.max(0, Math.round(Number(e.correct_answers) || 0));
      results.push({ team_id: teamId, delta: n * 2, reason: `Câu hỏi đợi giờ: trả lời đúng ${n} câu` });
    }
  }

  if (!results.length) return { error: 'Không có đội nào hợp lệ để tính điểm' };
  return { results, rule };
}

// Ghi ket qua vao DB (total_points + score_history) va bao realtime qua socket.
// db, io: lay tu caller. createdBy: ten nguoi thuc hien (admin username hoac quan tro username).
function applyGameScoring(db, io, results, rule, createdBy) {
  for (const r of results) {
    db.prepare('UPDATE teams SET total_points = total_points + ? WHERE id = ?').run(r.delta, r.team_id);
    db.prepare(`INSERT INTO score_history (team_id, delta, reason, round_name, created_by)
                VALUES (?, ?, ?, ?, ?)`).run(r.team_id, r.delta, r.reason, rule.label, createdBy);
  }

  const updatedTeams = db.prepare('SELECT id, total_points FROM teams').all();
  for (const r of results) {
    const t = updatedTeams.find(x => x.id === r.team_id);
    io.to(`team-${r.team_id}`).to('admins').to('gamemasters').emit('score:update', {
      team_id: r.team_id,
      total_points: t ? t.total_points : null,
      delta: r.delta,
      reason: r.reason,
      round_name: rule.label,
    });
  }
}

module.exports = { GAME_SCORING_RULES, computeGameScoring, applyGameScoring };
