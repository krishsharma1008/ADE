/**
 * Combyne AI — Agent Personas Routes
 *
 * Exposes persona files to the UI and agents.
 */
import { Router } from "express";
import {
  syncPersonas,
  getPersonaFile,
  listCachedPersonaKeys,
  readCacheManifest,
  clearPersonasCache,
} from "../services/personas.js";

export function createPersonasRouter(config: {
  supabaseUrl: string;
  supabaseAnonKey: string;
}) {
  const router = Router();

  // List all available personas (from cache manifest)
  router.get("/", async (_req, res) => {
    try {
      const manifest = readCacheManifest();
      if (!manifest) {
        // Try to sync first
        const personas = await syncPersonas({
          supabaseUrl: config.supabaseUrl,
          supabaseAnonKey: config.supabaseAnonKey,
        });
        res.json({
          plan_tier: "unknown",
          persona_keys: [...new Set(personas.map((p) => p.persona_key))],
          personas: personas.map((p) => ({
            persona_key: p.persona_key,
            file_name: p.file_name,
            version: p.version,
            updated_at: p.updated_at,
          })),
        });
        return;
      }

      res.json({
        plan_tier: manifest.planTier,
        fetched_at: manifest.fetchedAt,
        persona_keys: listCachedPersonaKeys(),
        personas: manifest.personas,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to list personas" });
    }
  });

  // Get a specific persona file
  router.get("/:personaKey/:fileName", async (req, res) => {
    try {
      const content = await getPersonaFile({
        supabaseUrl: config.supabaseUrl,
        supabaseAnonKey: config.supabaseAnonKey,
        personaKey: req.params.personaKey,
        fileName: req.params.fileName,
      });

      if (!content) {
        res.status(404).json({
          error: "Persona file not found",
          persona_key: req.params.personaKey,
          file_name: req.params.fileName,
        });
        return;
      }

      // Return as markdown or JSON based on Accept header
      if (req.accepts("text/markdown")) {
        res.type("text/markdown").send(content);
      } else {
        res.json({
          persona_key: req.params.personaKey,
          file_name: req.params.fileName,
          content,
        });
      }
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch persona file" });
    }
  });

  // Force refresh personas from Supabase
  router.post("/sync", async (_req, res) => {
    try {
      const personas = await syncPersonas({
        supabaseUrl: config.supabaseUrl,
        supabaseAnonKey: config.supabaseAnonKey,
        force: true,
      });

      res.json({
        synced: true,
        count: personas.length,
        persona_keys: [...new Set(personas.map((p) => p.persona_key))],
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to sync personas" });
    }
  });

  // Clear personas cache
  router.delete("/cache", async (_req, res) => {
    clearPersonasCache();
    res.json({ cleared: true });
  });

  return router;
}
