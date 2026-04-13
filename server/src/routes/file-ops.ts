import { Router } from "express";
import { openInIDE, revealInFinder, listAvailableIDEs, validateFilePath } from "../services/file-ops.js";

export function fileOpsRoutes(): Router {
  const router = Router();

  router.post("/file-ops/open-in-ide", async (req, res) => {
    const { filePath, ide } = req.body;
    if (!filePath || typeof filePath !== "string") {
      res.status(400).json({ error: "filePath is required" });
      return;
    }
    try {
      const resolved = validateFilePath(filePath);
      await openInIDE(resolved, ide);
      res.json({ ok: true, path: resolved });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to open" });
    }
  });

  router.post("/file-ops/reveal-in-finder", async (req, res) => {
    const { filePath } = req.body;
    if (!filePath || typeof filePath !== "string") {
      res.status(400).json({ error: "filePath is required" });
      return;
    }
    try {
      const resolved = validateFilePath(filePath);
      await revealInFinder(resolved);
      res.json({ ok: true, path: resolved });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to reveal" });
    }
  });

  router.get("/file-ops/available-ides", async (_req, res) => {
    try {
      const ides = await listAvailableIDEs();
      res.json({ ides });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to list IDEs" });
    }
  });

  return router;
}
