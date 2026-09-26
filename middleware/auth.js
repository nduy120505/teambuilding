function requireTeam(req, res, next) {
  if (req.session && req.session.teamId) return next();
  return res.status(401).json({ error: 'Chưa đăng nhập đội chơi' });
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'Chưa đăng nhập quản trị' });
}

function requireGameMaster(req, res, next) {
  if (req.session && req.session.gameMasterId) return next();
  return res.status(401).json({ error: 'Chưa đăng nhập quản trò' });
}

module.exports = { requireTeam, requireAdmin, requireGameMaster };
