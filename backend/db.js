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
        population  INT,
        lcp         VARCHAR(20),
        cls         VARCHAR(20),
        inp         VARCHAR(20),
        row_status  VARCHAR(30),
        gsc_date    VARCHAR(30),
        scraped_at  DATETIME      NOT NULL,
        created_at  DATETIME      DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_lookup   (site_url(255), device, status, scraped_at),
        INDEX idx_date     (scraped_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('[db] cwv_url_groups table ready');
  } finally {
    conn.release();
  }
}

module.exports = { pool, initDB };
