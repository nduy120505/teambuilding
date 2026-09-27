// Trang thai DUNG CHUNG cho timer tu-mo-lai chuong sau khi 1 doi tra loi SAI o vong chung ket
// (2 giay). Ca routes/admin.js (BTC dieu khien vong chung ket) LAN routes/team.js (doi tu dung
// sticker "Dong bang") deu can huy timer nay truoc khi doi final_state, nen tach ra module rieng
// de 2 file dung chung DUY NHAT 1 instance (require() cache theo tien trinh Node, khong phai
// moi file tu tao 1 closure/timer rieng se khong dong bo voi nhau).
let buzzCooldownTimer = null;

function clearBuzzCooldown() {
  if (buzzCooldownTimer) { clearTimeout(buzzCooldownTimer); buzzCooldownTimer = null; }
}

function setBuzzCooldownTimer(timer) {
  buzzCooldownTimer = timer;
}

module.exports = { clearBuzzCooldown, setBuzzCooldownTimer };
