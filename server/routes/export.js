const express = require('express');
const prisma = require('../lib/prisma');
const { authMiddleware } = require('../middleware/auth');
const attachTenant = require('../middleware/tenant');
const router = express.Router();
router.use(authMiddleware);
router.use(attachTenant);

router.get('/csv/:id', async (req, res, next) => {
  try {
    const record = await prisma.project.findFirst({
      where: { id: req.params.id, userId: req.user.id }
    });
    if (!record) return res.status(404).json({ error: 'Not found' });
    if (!record.reportJson) return res.status(400).json({ error: 'No report to export' });

    // Quote + escape every cell, and neutralize CSV/formula injection (Excel/Sheets
    // execute cells starting with = + - @). Applies to keys AND values.
    const csvCell = (v) => {
      let s = String(v == null ? '' : v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return `"${s.replace(/"/g, '""').slice(0, 500)}"`;
    };

    const report = JSON.parse(record.reportJson);
    let csv = 'Section,Details\n';
    csv += `Name,${csvCell(record.projectName)}\n`;
    csv += `Status,${csvCell(record.status)}\n`;
    csv += `Risk,${csvCell(record.overallRisk || 'N/A')}\n`;
    csv += `Score,${csvCell(record.riskScore == null ? 'N/A' : record.riskScore)}\n`;
    csv += `Date,${csvCell(record.createdAt)}\n`;

    if (report.findings) {
      for (const [key, val] of Object.entries(report.findings)) {
        csv += `${csvCell('Finding: ' + key)},${csvCell(val)}\n`;
      }
    }

    if (report.gaps) {
      for (const gap of report.gaps) {
        csv += `Gap,${csvCell(gap)}\n`;
      }
    }

    // Sanitize the filename for the Content-Disposition header (prevent header/CRLF injection).
    const safeName = String(record.projectName || 'report').replace(/[^A-Za-z0-9 ._-]/g, '_').slice(0, 80);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}-report.csv"`);
    res.send(csv);
  } catch (err) { next(err); }
});

router.get('/json/:id', async (req, res, next) => {
  try {
    const record = await prisma.project.findFirst({
      where: { id: req.params.id, userId: req.user.id }
    });
    if (!record) return res.status(404).json({ error: 'Not found' });
    if (!record.reportJson) return res.status(400).json({ error: 'No report to export' });

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${record.projectName}-report.json"`);
    res.send(record.reportJson);
  } catch (err) { next(err); }
});

module.exports = router;

