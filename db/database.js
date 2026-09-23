const path = require('path');
const { DatabaseSync } = require('node:sqlite'); // module SQLite tich hop san trong Node.js (>=22.5), khong can bien dich native

const DB_PATH = path.join(__dirname, 'teambuilding.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

module.exports = db;
