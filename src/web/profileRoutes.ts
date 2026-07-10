// Express router for config profiles (.harness/profiles.json).
//
// Extracted from server.ts as slice 4 of audit Fix #7. Built-in profiles
// live in src/services/configProfiles (BUILTIN_PROFILES); this surface is
// the HTTP wrapper over list/get + persist/delete of the user's custom
// overlay file. projectDir is the only dependency the handlers need.

import express from 'express';
import {
  getProfile,
  listProfiles,
  loadCustomProfiles,
  saveCustomProfiles,
  type ConfigProfile,
} from '../services/configProfiles';

export interface ProfileRoutesDeps {
  projectDir: string;
}

export function createProfileRouter(deps: ProfileRoutesDeps): express.Router {
  const router = express.Router();
  const { projectDir } = deps;

  router.get('/api/profiles', async (_req, res) => {
    try {
      const profiles = await listProfiles(projectDir);
      res.json({ profiles });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/api/profiles/:name', async (req, res) => {
    try {
      const profile = await getProfile(req.params.name, projectDir);
      if (!profile) {
        res.status(404).json({ error: `Profile "${req.params.name}" not found.` });
        return;
      }
      res.json(profile);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/api/profiles', async (req, res) => {
    try {
      const profile = req.body as ConfigProfile;
      if (!profile?.name || !profile?.description) {
        res.status(400).json({ error: 'name and description are required.' });
        return;
      }
      const existing = await loadCustomProfiles(projectDir);
      const idx = existing.findIndex((p) => p.name === profile.name);
      if (idx >= 0) {
        existing[idx] = profile;
      } else {
        existing.push(profile);
      }
      await saveCustomProfiles(projectDir, existing);
      res.json({ saved: profile.name, total: existing.length });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete('/api/profiles/:name', async (req, res) => {
    try {
      const existing = await loadCustomProfiles(projectDir);
      const filtered = existing.filter((p) => p.name !== req.params.name);
      if (filtered.length === existing.length) {
        res.status(404).json({ error: `Custom profile "${req.params.name}" not found.` });
        return;
      }
      await saveCustomProfiles(projectDir, filtered);
      res.json({ deleted: req.params.name, remaining: filtered.length });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
