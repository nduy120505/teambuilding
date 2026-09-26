// Khoi tao schema + du lieu mau cho Teambuilding FIT
const bcrypt = require('bcryptjs');
const db = require('./database');

function migrate() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT DEFAULT 'Ban to chuc'
  );

  -- Tai khoan "quan tro": moi tai khoan phu trach DUY NHAT 1 tro (assigned_game, xem
  -- utils/scoring.js -> GAME_SCORING_RULES). Quan tro tu nhap ket qua/cong diem cho tro
  -- cua minh, BTC (admin) chi theo doi qua trinh chu khong can tu cong diem nua.
  CREATE TABLE IF NOT EXISTS game_masters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT DEFAULT 'Quản trò',
    assigned_game TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#5B8DEF',
    total_points INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS score_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    delta INTEGER NOT NULL,
    reason TEXT,
    round_name TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    created_by TEXT
  );

  CREATE TABLE IF NOT EXISTS stages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    order_index INTEGER NOT NULL DEFAULT 0,
    x_percent REAL NOT NULL DEFAULT 50,
    y_percent REAL NOT NULL DEFAULT 50,
    icon TEXT DEFAULT 'flag',
    kind TEXT NOT NULL DEFAULT 'doi_khang', -- doi_khang | don | chung_ket
    location_name TEXT DEFAULT '' -- ten dia diem de nguoi doc (vd "Tòa nhà A2"), thay cho toa do x/y
  );

  -- Lich thi dau (lo trinh) rieng cua tung doi: moi doi co 1 dong cho moi "tro" ma doi do
  -- se tham gia, kem so luot (round_no) de sap xep thu tu rieng cho tung doi.
  CREATE TABLE IF NOT EXISTS team_stage_status (
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    stage_id INTEGER NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'locked', -- locked | current | completed
    round_no INTEGER, -- so luot (1,2,3,...) trong lo trinh rieng cua doi nay - NULL = chua duoc xep lich
    note TEXT, -- ghi chu tuy chinh (vd "Làn 2", "Tam đấu: A, B, E") - de trong se tu sinh tu doi thu
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (team_id, stage_id)
  );

  -- Doi thu cua 1 doi trong 1 "tro" doi khang (co the nhieu doi thu cung luc = tam dau)
  CREATE TABLE IF NOT EXISTS team_stage_opponents (
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    stage_id INTEGER NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
    opponent_team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    PRIMARY KEY (team_id, stage_id, opponent_team_id)
  );

  -- Cac element tu do tren map, de danh cho => chen them sau (mo ta, hinh anh, link,...)
  CREATE TABLE IF NOT EXISTS map_elements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE, -- NULL = hien thi cho tat ca doi
    type TEXT NOT NULL DEFAULT 'marker', -- marker | image | note | custom
    label TEXT,
    x_percent REAL NOT NULL DEFAULT 50,
    y_percent REAL NOT NULL DEFAULT 50,
    image_url TEXT,
    link_url TEXT,
    extra_json TEXT,
    visible INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS map_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    background_image TEXT DEFAULT '/img/map-placeholder.svg'
  );

  CREATE TABLE IF NOT EXISTS gifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    cost_points INTEGER NOT NULL,
    stock INTEGER NOT NULL DEFAULT 0,
    image_url TEXT,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS redemptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    gift_id INTEGER NOT NULL REFERENCES gifts(id),
    points_spent INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | delivered
    created_at TEXT DEFAULT (datetime('now')),
    handled_at TEXT,
    handled_by TEXT
  );

  CREATE TABLE IF NOT EXISTS final_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_index INTEGER NOT NULL DEFAULT 0,
    question_text TEXT NOT NULL,
    answer_text TEXT,
    points INTEGER NOT NULL DEFAULT 10,
    status TEXT NOT NULL DEFAULT 'pending' -- pending | active | closed
  );

  CREATE TABLE IF NOT EXISTS final_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    phase TEXT NOT NULL DEFAULT 'idle', -- idle | question_open | buzzed | reveal
    current_question_id INTEGER REFERENCES final_questions(id),
    buzzer_winner_team_id INTEGER REFERENCES teams(id),
    buzz_open_at TEXT,
    buzz_locked_at TEXT
  );

  CREATE TABLE IF NOT EXISTS violations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    detail TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  `);

  // Singletons
  db.prepare(`INSERT OR IGNORE INTO map_settings (id, background_image) VALUES (1, '/img/map-placeholder.svg')`).run();
  db.prepare(`INSERT OR IGNORE INTO final_state (id, phase) VALUES (1, 'idle')`).run();

  // Migrate them cot moi cho database CU da ton tai truoc do (khong lam mat du lieu),
  // vi node:sqlite khong ho tro "ALTER TABLE ... ADD COLUMN IF NOT EXISTS".
  tryAddColumn('stages', 'kind', `TEXT NOT NULL DEFAULT 'doi_khang'`);
  tryAddColumn('stages', 'location_name', `TEXT DEFAULT ''`);
  tryAddColumn('team_stage_status', 'round_no', 'INTEGER');
  tryAddColumn('team_stage_status', 'note', 'TEXT');
}

function tryAddColumn(table, column, definition) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (e) {
    // cot da ton tai roi -> bo qua
  }
}

function seed() {
  const teamCount = db.prepare('SELECT COUNT(*) c FROM teams').get().c;
  if (teamCount === 0) {
    const insertTeam = db.prepare(`INSERT INTO teams (code, password_hash, name, color) VALUES (?, ?, ?, ?)`);
    const demoTeams = [
      ['DOI01', 'Đội Sư Tử', '#E85D5D'],
      ['DOI02', 'Đội Đại Bàng', '#5B8DEF'],
      ['DOI03', 'Đội Hổ Mang', '#4CAF7D'],
      ['DOI04', 'Đội Gấu Trúc', '#B07DEF'],
    ];
    for (const [code, name, color] of demoTeams) {
      const hash = bcrypt.hashSync('123456', 10);
      insertTeam.run(code, hash, name, color);
    }
  }

  const adminCount = db.prepare('SELECT COUNT(*) c FROM admins').get().c;
  if (adminCount === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare(`INSERT INTO admins (username, password_hash, display_name) VALUES (?, ?, ?)`)
      .run('admin', hash, 'Ban tổ chức');
  }

  // 4 tro co dinh: 2 doi khang + 1 don + 1 chung ket. Lo trinh (thu tu, doi thu) cua
  // tung doi duoc ban to chuc xep RIENG trong tab "Lo trinh rieng tung doi" o trang admin,
  // khong con gan mac dinh giong nhau cho tat ca cac doi nhu truoc.
  const stageCount = db.prepare('SELECT COUNT(*) c FROM stages').get().c;
  if (stageCount === 0) {
    const insertStage = db.prepare(`INSERT INTO stages (name, description, order_index, x_percent, y_percent, icon, kind, location_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    // 6 tro co dinh cua su kien (dung ten & cong thuc trong utils/scoring.js) + Chung ket.
    // Tat ca deu la kind='don' (moi doi tu tinh diem doc lap, khong ghep doi thu truc tiep).
    const demoStages = [
      ['Trò khởi động', 'Đội về nhất được cộng điểm', 1, 12, 75, 'flag', 'don', ''],
      ['Phá vòng đoạt báu', 'Tính điểm theo số lượt thắng, trừ điểm nếu phạm luật', 2, 30, 55, 'star', 'don', ''],
      ['Ra Dấu Bắt Chữ', 'Tính điểm theo số lần đoán đúng', 3, 48, 35, 'puzzle', 'don', ''],
      ['Mạch Thần Dược', 'Tính điểm theo số bóng', 4, 62, 60, 'custom', 'don', ''],
      ['Nối vòng tay lớn', 'Xếp hạng theo thời gian hoàn thành', 5, 78, 40, 'obstacle', 'don', ''],
      ['Câu hỏi đợi giờ', 'Tính điểm theo số câu trả lời đúng', 6, 88, 70, 'note', 'don', ''],
      ['Chung kết', 'Vòng chung kết — Đường lên đỉnh Olympia', 7, 95, 20, 'trophy', 'chung_ket', ''],
    ];
    for (const s of demoStages) insertStage.run(...s);
  }

  const giftCount = db.prepare('SELECT COUNT(*) c FROM gifts').get().c;
  if (giftCount === 0) {
    const insertGift = db.prepare(`INSERT INTO gifts (name, description, cost_points, stock, image_url) VALUES (?, ?, ?, ?, ?)`);
    const demoGifts = [
      ['Bình giữ nhiệt', 'Bình giữ nhiệt in logo sự kiện', 50, 10, ''],
      ['Túi tote sự kiện', 'Túi vải canvas kỷ niệm', 30, 15, ''],
      ['Voucher cafe', 'Voucher 50k tại quầy cafe sự kiện', 20, 20, ''],
      ['Loa bluetooth mini', 'Quà đặc biệt dành cho đội xuất sắc', 150, 3, ''],
    ];
    for (const g of demoGifts) insertGift.run(...g);
  }

  // Khong tao san cau hoi mau cho vong "Ai thông minh hơn sinh viên năm nhất" nua -
  // ban to chuc se tu nhap cau hoi + dap an (A/B/C/D hoac cau tra loi ngan) truc tiep
  // trong tab Quan tri > Ngan hang cau hoi.
}

function reseedIfRequested() {
  if (process.argv.includes('--reseed')) {
    console.log('Reseeding: xoa toan bo du lieu cu...');
    db.exec(`
      DELETE FROM violations;
      DELETE FROM redemptions;
      DELETE FROM final_questions;
      DELETE FROM final_state;
      DELETE FROM team_stage_opponents;
      DELETE FROM team_stage_status;
      DELETE FROM map_elements;
      DELETE FROM stages;
      DELETE FROM gifts;
      DELETE FROM score_history;
      DELETE FROM teams;
      DELETE FROM admins;
      DELETE FROM game_masters;
    `);
    db.prepare(`INSERT OR IGNORE INTO final_state (id, phase) VALUES (1, 'idle')`).run();
  }
}

reseedIfRequested();
migrate();
seed();

console.log('Da khoi tao database + du lieu mau.');
console.log('Tai khoan admin: admin / admin123 (doi lai truoc khi dung that!)');
console.log('Tai khoan doi mau: DOI01..DOI04 / mat khau: 123456');

module.exports = { migrate, seed };
