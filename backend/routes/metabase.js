const express = require('express');
const axios = require('axios');
const router = express.Router();

const METABASE_URL = 'http://analytics.ambitionbox.infoedge.com/api/dataset';
const METABASE_SESSION = process.env.METABASE_SESSION || '8fadb518-c160-4b5d-8ae3-9717dd879c08';
const METABASE_DB = 4;

const VALID_CLICK_LABELS = ['INP', 'CLS'];
const VALID_DEVICE_TYPES = ['WAP', 'WEB'];
const VALID_LOGIN_STATUSES = [0, 1];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Allow alphanumeric, underscore, hyphen, dot — covers all real page names
const PAGE_NAME_RE = /^[a-zA-Z0-9_\-.]+$/;

router.post('/metabase-query', async (req, res) => {
  const { clickLabel, entityIdFilter, pageName, fromDate, toDate, deviceTypes, loginStatuses } = req.body;

  if (!clickLabel || !pageName || !fromDate || !toDate) {
    return res.status(400).json({ error: 'Missing required parameters: clickLabel, pageName, fromDate, toDate' });
  }
  if (!VALID_CLICK_LABELS.includes(clickLabel)) {
    return res.status(400).json({ error: `clickLabel must be one of: ${VALID_CLICK_LABELS.join(', ')}` });
  }
  if (!DATE_RE.test(fromDate) || !DATE_RE.test(toDate)) {
    return res.status(400).json({ error: 'Dates must be in YYYY-MM-DD format' });
  }
  if (!PAGE_NAME_RE.test(pageName)) {
    return res.status(400).json({ error: 'pageName contains invalid characters' });
  }
  if (deviceTypes && (!Array.isArray(deviceTypes) || deviceTypes.some(d => !VALID_DEVICE_TYPES.includes(d)))) {
    return res.status(400).json({ error: `deviceTypes must be an array of: ${VALID_DEVICE_TYPES.join(', ')}` });
  }
  if (loginStatuses && (!Array.isArray(loginStatuses) || loginStatuses.some(s => !VALID_LOGIN_STATUSES.includes(Number(s))))) {
    return res.status(400).json({ error: 'loginStatuses must be an array of 0 and/or 1' });
  }

  const entityClause =
    entityIdFilter === 'not_null' ? 'AND entity IS NOT NULL ' :
    entityIdFilter === 'null'     ? 'AND entity IS NULL ' :
    '';  // 'any' — no entity filter

  const deviceClause = deviceTypes?.length
    ? `AND deviceType IN (${deviceTypes.map(d => `'${d}'`).join(', ')}) `
    : '';

  const loginClause = loginStatuses?.length
    ? `AND loginStatus IN (${loginStatuses.map(Number).join(', ')}) `
    : '';

  const query =
    `SELECT DATE(ubaCreatedOn) AS date, SUM(TotalCount) AS Count ` +
    `FROM core_web_vitals_data ` +
    `WHERE clickLabel = '${clickLabel}' ` +
    `${entityClause}` +
    `AND pageName = '${pageName}' ` +
    `${deviceClause}` +
    `${loginClause}` +
    `AND ubaCreatedOn BETWEEN '${fromDate}' AND '${toDate}' ` +
    `GROUP BY DATE(ubaCreatedOn) ` +
    `ORDER BY date`;

  try {
    const { data } = await axios.post(
      METABASE_URL,
      {
        database: METABASE_DB,
        native: { query, 'template-tags': {} },
        type: 'native',
        parameters: [],
      },
      {
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Metabase-Session': METABASE_SESSION,
        },
        timeout: 30000,
      }
    );

    const rows = data?.data?.rows || [];
    const result = rows.map(([date, count]) => ({
      date: typeof date === 'string' ? date.slice(0, 10) : date,
      count: Number(count),
    }));

    res.json({ data: result, rowCount: result.length, query });
  } catch (e) {
    const msg = e.response?.data?.message || e.response?.data?.error || e.message;
    res.status(500).json({ error: msg });
  }
});

module.exports = router;
