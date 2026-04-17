require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host:     process.env.MYSQL_HOST     || 'localhost',
  port:     process.env.MYSQL_PORT     || 3306,
  user:     process.env.MYSQL_USER     || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'cwv',
  waitForConnections: true,
  connectionLimit: 10,
  timezone: '+00:00',
});

async function initDB() {
  const conn = await pool.getConnection();
  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS cwv_url_groups (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        site_url    VARCHAR(500)  NOT NULL,
        device      VARCHAR(20)   NOT NULL,
        status      VARCHAR(30)   NOT NULL,
        example_url TEXT          NOT NULL,
        url_pattern VARCHAR(500)  DEFAULT NULL,
        population  INT,
        lcp         VARCHAR(20),
        cls         VARCHAR(20),
        inp         VARCHAR(20),
        row_status  VARCHAR(30),
        issue_label VARCHAR(200)  DEFAULT '',
        gsc_date    VARCHAR(30),
        scraped_at  DATETIME      NOT NULL,
        created_at  DATETIME      DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_lookup   (site_url(255), device, status, scraped_at),
        INDEX idx_date     (scraped_at),
        INDEX idx_pattern  (site_url(255), url_pattern(255), device, status, gsc_date(10))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Migrate existing tables that are missing url_pattern / issue_label columns
    try {
      await conn.execute(`ALTER TABLE cwv_url_groups ADD COLUMN url_pattern VARCHAR(500) DEFAULT NULL`);
      console.log('[db] Added url_pattern column');
    } catch (e) { /* already exists */ }

    try {
      await conn.execute(`ALTER TABLE cwv_url_groups ADD COLUMN issue_label VARCHAR(200) DEFAULT ''`);
      console.log('[db] Added issue_label column');
    } catch (e) { /* already exists */ }

    try {
      await conn.execute(`ALTER TABLE cwv_url_groups ADD INDEX idx_pattern (site_url(255), url_pattern(255), device, status, gsc_date(10))`);
      console.log('[db] Added idx_pattern index');
    } catch (e) { /* already exists */ }

    try {
      await conn.execute(`ALTER TABLE cwv_url_groups ADD COLUMN pattern_version TINYINT DEFAULT NULL`);
      console.log('[db] Added pattern_version column');
    } catch (e) { /* already exists */ }

    console.log('[db] cwv_url_groups table ready');
  } finally {
    conn.release();
  }
}

module.exports = { pool, initDB };
