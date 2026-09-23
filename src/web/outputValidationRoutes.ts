import express from 'express';
import {
  OUTPUT_VALIDATION_PROFILES,
  OUTPUT_VALIDATION_PROFILE_TEMPLATES,
  describeOutputValidationProfileSuggestion,
  parseOutputValidationProfile,
  validateCustomOutputValidationProfiles,
  validateOutput,
  type CustomOutputValidationProfile,
  type OutputValidationProfile,
} from '../core/outputValidation';
import { listEvalTraceRuns, recordProfileFeedbackEvalRun } from '../learning/evalTrace';
import { classifyMode, type HarnessMode } from '../services/modeClassifier';

interface OutputValidationSettings {
  enabled: boolean;
  profile: OutputValidationProfile;
  autoSelect: boolean;
  skipOnLowSignal: boolean;
}

export interface OutputValidationRoutesDeps {
  projectDir: string;
  ensureSettingsLoaded: () => Promise<void>;
  getOutputValidationProfiles: () => Array<{ profile: string; label: string; description: string }>;
  getCustomOutputValidationProfiles: () => CustomOutputValidationProfile[];
  setCustomOutputValidationProfiles: (profiles: CustomOutputValidationProfile[]) => void;
  getOutputValidationSettings: () => OutputValidationSettings;
  setOutputValidationSettings: (settings: OutputValidationSettings) => void;
  sanitizeOutputValidationSettings: (value: unknown) => OutputValidationSettings;
  saveCustomOutputValidationProfiles: () => Promise<void>;
  saveSettingsToDisk: () => Promise<void>;
}

function suggestionReason(profile: OutputValidationProfile, matched = true, modeHint?: HarnessMode): string {
  if (!matched) return `No strong signal in the prompt; defaulted to ${profile}.`;
  if ((modeHint === 'research' || modeHint === 'maintain') && profile === 'oracle-prime') {
    return `Mode classifier flagged this prompt as ${modeHint}; using the analytical profile so prose answers are not graded as code changes.`;
  }
  switch (profile) {
    case 'coding-answer': return 'The prompt looks like code, tests, files, or implementation work.';
    case 'factual-answer': return 'The prompt looks like a current or factual answer that should cite evidence and uncertainty.';
    case 'tool-result-summary': return 'The prompt looks like a command, terminal, log, or tool output summary.';
    case 'oracle-prime': return 'The prompt looks like a decision, risk, strategy, or uncertainty-heavy answer.';
    default: return 'Using the current custom profile because it is selected manually.';
  }
}

function cloneTemplate(template: CustomOutputValidationProfile): CustomOutputValidationProfile {
  return JSON.parse(JSON.stringify(template)) as CustomOutputValidationProfile;
}

export function createOutputValidationRouter(deps: OutputValidationRoutesDeps): express.Router {
  const router = express.Router();

  router.get('/api/output-validation/profiles', async (_req, res) => {
    try {
      await deps.ensureSettingsLoaded();
      res.json({ profiles: deps.getOutputValidationProfiles(), customProfiles: deps.getCustomOutputValidationProfiles(), path: '.harness/output-validation-profiles.json' });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/api/output-validation/templates', async (_req, res) => {
    res.json({ templates: OUTPUT_VALIDATION_PROFILE_TEMPLATES });
  });

  router.post('/api/output-validation/suggest-profile', async (req, res) => {
    try {
      await deps.ensureSettingsLoaded();
      const input = String(req.body?.input ?? req.body?.message ?? '').slice(0, 20_000);
      // Anchor the profile suggestion to the mode classifier so research/maintain
      // prompts cannot get graded against the coding-answer rubric just because
      // they mention a file path or language name.
      const modeHint = input ? classifyMode(input).mode : undefined;
      const suggestion = describeOutputValidationProfileSuggestion(input, 'oracle-prime', { modeHint });
      const metadata = OUTPUT_VALIDATION_PROFILES.find((candidate) => candidate.profile === suggestion.profile);
      res.json({ profile: suggestion.profile, label: metadata?.label ?? suggestion.profile, reason: suggestionReason(suggestion.profile, suggestion.matched, modeHint), matched: suggestion.matched });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/api/output-validation/feedback', async (req, res) => {
    try {
      await deps.ensureSettingsLoaded();
      const profile = String(req.body?.profile ?? '').trim();
      const voteRaw = String(req.body?.vote ?? '').trim().toLowerCase();
      if (!profile) { res.status(400).json({ error: 'profile is required' }); return; }
      if (voteRaw !== 'up' && voteRaw !== 'down') { res.status(400).json({ error: 'vote must be "up" or "down"' }); return; }
      const selectionSourceRaw = String(req.body?.selectionSource ?? 'auto-selected');
      const selectionSource = selectionSourceRaw === 'manual-selected' ? 'manual-selected' : 'auto-selected';
      const run = await recordProfileFeedbackEvalRun(deps.projectDir, {
        profile,
        vote: voteRaw,
        selectionSource,
        selectionReason: req.body?.selectionReason ? String(req.body.selectionReason).slice(0, 500) : undefined,
        prompt: req.body?.prompt ? String(req.body.prompt).slice(0, 500) : undefined,
      });
      res.json({ ok: true, runId: run.id });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/api/output-validation/feedback-replay', async (_req, res) => {
    try {
      await deps.ensureSettingsLoaded();
      const runs = await listEvalTraceRuns(deps.projectDir);
    const PLACEHOLDER_TASK = 'validation profile feedback';
    const replays: Array<{ originalProfile: string; suggestedProfile: string; matched: boolean; prompt: string; createdAt: string; status: 'fixed' | 'still-misclassified' | 'no-prompt' }> = [];
    let fixed = 0;
    let stillMisclassified = 0;
    let noPrompt = 0;
    for (const run of runs) {
      for (const result of run.results) {
        if (!result.tags.includes('profile-feedback:down')) continue;
        const originalProfile = result.tags.find((tag) => tag !== 'profile-feedback'
          && tag !== 'profile-feedback:down'
          && tag !== 'auto-selected'
          && tag !== 'manual-selected') ?? 'unknown';
        const prompt = result.task && result.task !== PLACEHOLDER_TASK ? result.task : '';
        if (!prompt) {
          noPrompt++;
          replays.push({ originalProfile, suggestedProfile: originalProfile, matched: false, prompt: '', createdAt: run.createdAt, status: 'no-prompt' });
          continue;
        }
        const suggestion = describeOutputValidationProfileSuggestion(prompt, 'oracle-prime');
        const status: 'fixed' | 'still-misclassified' = suggestion.profile !== originalProfile ? 'fixed' : 'still-misclassified';
        if (status === 'fixed') fixed++; else stillMisclassified++;
        replays.push({ originalProfile, suggestedProfile: suggestion.profile, matched: suggestion.matched, prompt, createdAt: run.createdAt, status });
      }
    }
    res.json({
      generatedAt: new Date().toISOString(),
      totalDownVotes: replays.length,
      fixed,
      stillMisclassified,
      noPrompt,
      replays: replays.slice(-50).reverse(),
    });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/api/output-validation/templates/install', async (req, res) => {
    await deps.ensureSettingsLoaded();
    const requestedProfile = String(req.body?.profile ?? '').trim();
    const template = OUTPUT_VALIDATION_PROFILE_TEMPLATES.find((candidate) => candidate.profile === requestedProfile);
    if (!template) {
      res.status(404).json({ error: 'Unknown output validation template.' });
      return;
    }
    deps.setCustomOutputValidationProfiles(deps.getCustomOutputValidationProfiles().filter((profile) => profile.profile !== template.profile).concat(cloneTemplate(template)));
    deps.setOutputValidationSettings(deps.sanitizeOutputValidationSettings({ ...deps.getOutputValidationSettings(), profile: template.profile }));
    await deps.saveCustomOutputValidationProfiles();
    await deps.saveSettingsToDisk();
    res.json({ installed: template.profile, profiles: deps.getOutputValidationProfiles(), customProfiles: deps.getCustomOutputValidationProfiles(), path: '.harness/output-validation-profiles.json' });
  });

  router.post('/api/output-validation/preview', async (req, res) => {
    await deps.ensureSettingsLoaded();
    const content = String(req.body?.content ?? '').slice(0, 200_000);
    const customProfiles = deps.getCustomOutputValidationProfiles();
    const profile = parseOutputValidationProfile(req.body?.profile, customProfiles) ?? deps.getOutputValidationSettings().profile;
    res.json({ validation: validateOutput(content, profile, customProfiles) });
  });

  router.post('/api/output-validation/profiles', async (req, res) => {
    await deps.ensureSettingsLoaded();
    const validation = validateCustomOutputValidationProfiles(req.body.profiles ?? req.body);
    if (validation.errors.length > 0) {
      res.status(400).json({ error: 'Custom profile schema validation failed.', errors: validation.errors });
      return;
    }
    const profiles = validation.profiles;
    deps.setCustomOutputValidationProfiles(profiles);
    deps.setOutputValidationSettings(deps.sanitizeOutputValidationSettings(deps.getOutputValidationSettings()));
    await deps.saveCustomOutputValidationProfiles();
    res.json({ profiles: deps.getOutputValidationProfiles(), customProfiles: deps.getCustomOutputValidationProfiles(), path: '.harness/output-validation-profiles.json' });
  });

  return router;
}
