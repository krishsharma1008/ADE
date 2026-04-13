import fs from "node:fs";
import { combyneConfigSchema, type CombyneConfig } from "@combyne/shared";
import { resolveCombyneConfigPath } from "./paths.js";

export function readConfigFile(): CombyneConfig | null {
  const configPath = resolveCombyneConfigPath();

  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return combyneConfigSchema.parse(raw);
  } catch {
    return null;
  }
}
