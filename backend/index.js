const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());

const authRoutes       = require('./routes/auth');
const cwvRoutes        = require('./routes/cwv');
const gscScraperRoutes = require('./routes/gsc-scraper');
const cwvDbRoutes      = require('./routes/cwv-db');
const metabaseRoutes   = require('./routes/metabase');

app.use('/api/auth', authRoutes);
app.use('/api', cwvRoutes);
app.use('/api', gscScraperRoutes);
app.use('/api', cwvDbRoutes);
app.use('/api', metabaseRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const { initDB } = require('./db');
initDB()
  .then(() => app.listen(PORT, () => console.log(`CWV Backend running on http://localhost:${PORT}`)))
  .catch(err => {
    console.error('DB init failed:', err.message);
    console.warn('Starting without DB — MySQL routes will fail until DB is available');
    app.listen(PORT, () => console.log(`CWV Backend running on http://localhost:${PORT} (no DB)`));
  });
