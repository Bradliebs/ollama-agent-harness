import express from 'express';
import { createMycelialRouter } from '../mycelium/router';
import { logger } from '../core/logger';

export interface MyceliumRoutesDeps {
  projectDir: string;
}

export function createMyceliumRouter(deps: MyceliumRoutesDeps): express.Router {
  const router = express.Router();
  const { projectDir } = deps;

  router.get('/api/mycelium', async (_req, res) => {
    try {
      const { loadMyceliumGraph: load } = await import('../mycelium/graph');
      const graph = await load(projectDir);
      res.json({
        stats: graph.stats(),
        nodes: graph.listNodes(),
        edges: graph.listEdges(),
        episodes: graph.listEpisodes(20),
        archivedEdges: graph.listArchivedEdges().slice(-20),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // Last episode + its selection reasons / route ordering for the UI.
  router.get('/api/mycelium/last-route', async (_req, res) => {
    try {
      const { loadMyceliumGraph: load } = await import('../mycelium/graph');
      const graph = await load(projectDir);
      const episodes = graph.listEpisodes(1);
      const lastEpisode = episodes[episodes.length - 1] ?? null;
      if (!lastEpisode) {
        res.json({ episode: null, nodes: [], edges: [] });
        return;
      }
      const nodes = lastEpisode.route
        .map((id) => graph.getNode(id))
        .filter((n): n is NonNullable<typeof n> => Boolean(n));
      const idSet = new Set(lastEpisode.route);
      const edges = graph.listEdges().filter((e) => idSet.has(e.source) && idSet.has(e.target));
      res.json({ episode: lastEpisode, nodes, edges });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // Reward learning curve: did the reinforcement loop actually improve over
  // time? Computed from the durable reward ledger, not the rolling episode cap.
  router.get('/api/mycelium/learning-curve', async (_req, res) => {
    try {
      const { readRewardEntries, summarizeLearningCurve } = await import('../core/rewardLedger');
      const entries = await readRewardEntries(projectDir);
      res.json(summarizeLearningCurve(entries));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  router.delete('/api/mycelium', async (_req, res) => {
    try {
      const { MyceliumGraph, saveMyceliumGraph: save } = await import('../mycelium/graph');
      await save(projectDir, new MyceliumGraph());
      logger.info('Mycelium', 'Graph reset');
      res.json({ reset: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // Apply explicit user feedback (👍 / 👎) to the most recent route. The
  // feedback is recorded as a fresh episode tagged with userFeedback so the
  // router learns from human judgment, not just the heuristic verifier.
  router.post('/api/mycelium/feedback', async (req, res) => {
    const vote = req.body?.vote;
    const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
    const episodeId = typeof req.body?.episodeId === 'string' ? req.body.episodeId : undefined;
    if (vote !== 'up' && vote !== 'down' && vote !== 'neutral') {
      res.status(400).json({ error: 'vote must be "up", "down", or "neutral"' });
      return;
    }
    try {
      const mycelialRouter = await createMycelialRouter(projectDir);
      // Attach the vote to the exact episode the user rated when an episodeId
      // is supplied; otherwise fall back to the most recent episode (legacy
      // clients). Without this, a vote on response A can land on a concurrent
      // response B that finished first and became "most recent".
      const graph = mycelialRouter.getGraph();
      const targetEpisode = episodeId
        ? graph.getEpisodeById(episodeId)
        : graph.listEpisodes(1)[0];
      if (!targetEpisode) {
        res.status(404).json({
          error: episodeId ? 'episode not found' : 'no recent episode to apply feedback to',
        });
        return;
      }
      // The router doesn't expose setLastRoute; reconstruct via a private cast.
      (mycelialRouter as unknown as { lastRoute: string[] }).lastRoute = targetEpisode.route;
      (mycelialRouter as unknown as { lastQuery: string }).lastQuery = targetEpisode.query;
      const result = mycelialRouter.applyUserFeedback(vote, note);
      await mycelialRouter.save();
      res.json(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn('Mycelium', 'Feedback failed', { error: msg });
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
