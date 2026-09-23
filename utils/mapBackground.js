const fs = require('fs');
const path = require('path');

// Cac anh nen (ban do, trang dang nhap) duoc quan ly truc tiep bang file, khong qua giao dien quan tri.
// Chi can luu 1 file dung ten quy uoc (vd "map-background.<duoi anh>") vao thu muc public/img/
// (thay the neu da co san) la ap dung ngay, khong can sua code hay dang nhap admin.
const IMG_DIR = path.join(__dirname, '..', 'public', 'img');

function findImageByBasename(basename) {
  try {
    const files = fs.readdirSync(IMG_DIR);
    const match = files.find(f => f.toLowerCase().startsWith(basename + '.'));
    if (match) return `/img/${match}`;
  } catch (e) {
    // thu muc chua ton tai hoac loi doc
  }
  return null;
}

// Anh nen ban do: luon co gia tri tra ve (fallback ve anh mau san co neu chua tao file rieng)
function resolveMapBackground() {
  return findImageByBasename('map-background') || '/img/map-placeholder.svg';
}

// Anh nen trang dang nhap (doi + admin): tuy chon, tra ve null neu chua co file -> frontend giu giao dien mac dinh
function resolveLoginBackground() {
  return findImageByBasename('login-background');
}

module.exports = { resolveMapBackground, resolveLoginBackground };
