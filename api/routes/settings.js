import express from 'express';
import fs from 'node:fs.promises';
import path from 'node:path';

const SETTINGS_PATH = path.join(process.cwd(), '../../data/settings.json');
const DEFAULT_PATH = path.join(process.cwd(), '../../lib/default-settings.json');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    let data;
    try {
      data = await fs.readFile(SETTINGS_PATH, 'utf-8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err; // rethrow if it's a different error
      data = await fs.readFile(DEFAULT_PATH, 'utf-8');
    }

    const settings = JSON.parse(data);
    res.json(settings);
  } catch (error) {
    console.error("Failed to read settings:", error);
    res.status(500).json({ error: 'Failed to read settings.', message: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const settings = req.body;
    const data = JSON.stringify(settings, null, 2);
    await fs.writeFile(SETTINGS_PATH, data, 'utf-8');
    res.json({ message: 'Settings saved successfully.' });
  } catch (error) {
    console.error("Failed to save settings:", error);
    res.status(500).json({ error: 'Failed to save settings.', message: error.message });
  }
});

export default router;
