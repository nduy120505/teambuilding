// Dinh nghia 4 sticker "quyen nang" dung trong vong chung ket "Ai thong minh hon sinh vien nam
// nhat". Moi sticker gan voi 1 trong 4 tro dau tien (theo order_index cua bang stages):
// Tro khoi dong -> Ke cuop, Pha vong doat bau -> Nhan doi, Ra Dau Bat Chu -> Dong bang,
// Mach Than Duoc -> Ngoi sao hi vong. Doi hoan thanh (hoac thang, neu la tro doi khang) tro do
// se duoc tu dong cong 1 sticker tuong ung - xem utils/scoring.js (applyGameScoring).
const STICKER_DEFS = {
  khoi_dong: {
    key: 'ke_cuop',
    name: 'Kẻ cướp',
    description: 'Lấy đi điểm mà một đội khác vừa trả lời đúng trong vòng chung kết.',
  },
  pha_vong_doat_bau: {
    key: 'nhan_doi',
    name: 'Nhân đôi',
    description: 'Nhân đôi số điểm đội đã ghi được trong vòng chung kết.',
  },
  ra_dau_bat_chu: {
    key: 'dong_bang',
    name: 'Đóng băng',
    description: 'Khoá quyền trả lời của đội khác trong 1 câu hỏi — quyền trả lời chuyển thẳng cho đội dùng sticker.',
  },
  mach_than_duoc: {
    key: 'ngoi_sao_hi_vong',
    name: 'Ngôi sao hi vọng',
    description: 'Giành trước quyền trả lời câu hỏi tiếp theo khi chưa được đọc lên; trả lời đúng trong thời gian quy định được cộng 7 điểm.',
  },
};

// Tra cuu nguoc key -> dinh nghia (vd 'ke_cuop' -> {key, name, description, sourceGame})
const STICKER_BY_KEY = {};
for (const [game, def] of Object.entries(STICKER_DEFS)) {
  STICKER_BY_KEY[def.key] = { ...def, sourceGame: game };
}

module.exports = { STICKER_DEFS, STICKER_BY_KEY };
