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

const authRoutes = require('./routes/auth');
const cwvRoutes = require('./routes/cwv');
const gscScraperRoutes = require('./routes/gsc-scraper');

app.use('/api/auth', authRoutes);
app.use('/api', cwvRoutes);
app.use('/api', gscScraperRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`CWV Backend running on http://localhost:${PORT}`);
});
