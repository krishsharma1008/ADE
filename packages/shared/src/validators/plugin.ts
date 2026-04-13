import { z } from "zod";
import {
  PLUGIN_STATUSES,
  PLUGIN_CATEGORIES,
  PLUGIN_CAPABILITIES,
  PLUGIN_UI_SLOT_TYPES,
  PLUGIN_UI_SLOT_ENTITY_TYPES,
  PLUGIN_RESERVED_COMPANY_ROUTE_SEGMENTS,
  PLUGIN_LAUNCHER_PLACEMENT_ZONES,
  PLUGIN_LAUNCHER_ACTIONS,
  PLUGIN_LAUNCHER_BOUNDS,
  PLUGIN_LAUNCHER_RENDER_ENVIRONMENTS,
  PLUGIN_STATE_SCOPE_KINDS,
} from "../constants.js";

// ---------------------------------------------------------------------------
// JSON Schema placeholder -- a permissive validator for JSON Schema objects
// ---------------------------------------------------------------------------

/**
 * Permissive validator for JSON Schema objects. Accepts any `Record<string, unknown>`
 * that contains at least a `type`, `$ref`, or composition keyword (`oneOf`/`anyOf`/`allOf`).
 * Empty objects are also accepted.
 */
export const jsonSchemaSchema = z.record(z.unknown()).refine(
  (val) => {
    if (Object.keys(val).length === 0) return true;
    return typeof val.type === "string" || val.$ref !== undefined || val.oneOf !== undefined || val.anyOf !== undefined || val.allOf !== undefined;
  },
  { message: "Must be a valid JSON Schema object (requires at least a 'type', '$ref', or composition keyword)" },
);

// ---------------------------------------------------------------------------
// Manifest sub-type schemas
// ---------------------------------------------------------------------------

const CRON_FIELD_PATTERN = /^(\*(?:\/[0-9]+)?|[0-9]+(?:-[0-9]+)?(?:\/[0-9]+)?)(?:,(\*(?:\/[0-9]+)?|[0-9]+(?:-[0-9]+)?(?:\/[0-9]+)?))*$/;

function isValidCronExpression(expression: string): boolean {
  const trimmed = expression.trim();
  if (!trimmed) return false;
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((f) => CRON_FIELD_PATTERN.test(f));
}

export const pluginJobDeclarationSchema = z.object({
  jobKey: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  schedule: z.string().refine(
    (val) => isValidCronExpression(val),
    { message: "schedule must be a valid 5-field cron expression (e.g. '*/15 * * * *')" },
  ).optional(),
});

export type PluginJobDeclarationInput = z.infer<typeof pluginJobDeclarationSchema>;

export const pluginWebhookDeclarationSchema = z.object({
  endpointKey: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
});

export type PluginWebhookDeclarationInput = z.infer<typeof pluginWebhookDeclarationSchema>;

export const pluginToolDeclarationSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1),
  parametersSchema: jsonSchemaSchema,
});

export type PluginToolDeclarationInput = z.infer<typeof pluginToolDeclarationSchema>;

export const pluginUiSlotDeclarationSchema = z.object({
  type: z.enum(PLUGIN_UI_SLOT_TYPES),
  id: z.string().min(1),
  displayName: z.string().min(1),
  exportName: z.string().min(1),
  entityTypes: z.array(z.enum(PLUGIN_UI_SLOT_ENTITY_TYPES)).optional(),
  routePath: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, {
    message: "routePath must be a lowercase single-segment slug (letters, numbers, hyphens)",
  }).optional(),
  order: z.number().int().optional(),
}).superRefine((value, ctx) => {
  const entityScopedTypes = ["detailTab", "taskDetailView", "contextMenuItem", "commentAnnotation", "commentContextMenuItem", "projectSidebarItem"];
  if (
    entityScopedTypes.includes(value.type)
    && (!value.entityTypes || value.entityTypes.length === 0)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${value.type} slots require at least one entityType`,
      path: ["entityTypes"],
    });
  }
  if (value.type === "projectSidebarItem" && value.entityTypes && !value.entityTypes.includes("project")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "projectSidebarItem slots require entityTypes to include \"project\"",
      path: ["entityTypes"],
    });
  }
  if (value.type === "commentAnnotation" && value.entityTypes && !value.entityTypes.includes("comment")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "commentAnnotation slots require entityTypes to include \"comment\"",
      path: ["entityTypes"],
    });
  }
  if (value.type === "commentContextMenuItem" && value.entityTypes && !value.entityTypes.includes("comment")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "commentContextMenuItem slots require entityTypes to include \"comment\"",
      path: ["entityTypes"],
    });
  }
  if (value.routePath && value.type !== "page") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "routePath is only supported for page slots",
      path: ["routePath"],
    });
  }
  if (value.routePath && PLUGIN_RESERVED_COMPANY_ROUTE_SEGMENTS.includes(value.routePath as (typeof PLUGIN_RESERVED_COMPANY_ROUTE_SEGMENTS)[number])) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `routePath "${value.routePath}" is reserved by the host`,
      path: ["routePath"],
    });
  }
});

export type PluginUiSlotDeclarationInput = z.infer<typeof pluginUiSlotDeclarationSchema>;

const entityScopedLauncherPlacementZones = [
  "detailTab",
  "taskDetailView",
  "contextMenuItem",
  "commentAnnotation",
  "commentContextMenuItem",
  "projectSidebarItem",
] as const;

const launcherBoundsByEnvironment: Record<
  (typeof PLUGIN_LAUNCHER_RENDER_ENVIRONMENTS)[number],
  readonly (typeof PLUGIN_LAUNCHER_BOUNDS)[number][]
> = {
  hostInline: ["inline", "compact", "default"],
  hostOverlay: ["compact", "default", "wide", "full"],
  hostRoute: ["default", "wide", "full"],
  external: [],
  iframe: ["compact", "default", "wide", "full"],
};

export const pluginLauncherActionDeclarationSchema = z.object({
  type: z.enum(PLUGIN_LAUNCHER_ACTIONS),
  target: z.string().min(1),
  params: z.record(z.unknown()).optional(),
}).superRefine((value, ctx) => {
  if (value.type === "performAction" && value.target.includes("/")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "performAction launchers must target an action key, not a route or URL",
      path: ["target"],
    });
  }

  if (value.type === "navigate" && /^https?:\/\//.test(value.target)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "navigate launchers must target a host route, not an absolute URL",
      path: ["target"],
    });
  }
});

export type PluginLauncherActionDeclarationInput =
  z.infer<typeof pluginLauncherActionDeclarationSchema>;

export const pluginLauncherRenderDeclarationSchema = z.object({
  environment: z.enum(PLUGIN_LAUNCHER_RENDER_ENVIRONMENTS),
  bounds: z.enum(PLUGIN_LAUNCHER_BOUNDS).optional(),
}).superRefine((value, ctx) => {
  if (!value.bounds) {
    return;
  }

  const supportedBounds = launcherBoundsByEnvironment[value.environment];
  if (!supportedBounds.includes(value.bounds)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `bounds "${value.bounds}" is not supported for render environment "${value.environment}"`,
      path: ["bounds"],
    });
  }
});

export type PluginLauncherRenderDeclarationInput =
  z.infer<typeof pluginLauncherRenderDeclarationSchema>;

export const pluginLauncherDeclarationSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  placementZone: z.enum(PLUGIN_LAUNCHER_PLACEMENT_ZONES),
  exportName: z.string().min(1).optional(),
  entityTypes: z.array(z.enum(PLUGIN_UI_SLOT_ENTITY_TYPES)).optional(),
  order: z.number().int().optional(),
  action: pluginLauncherActionDeclarationSchema,
  render: pluginLauncherRenderDeclarationSchema.optional(),
}).superRefine((value, ctx) => {
  if (
    entityScopedLauncherPlacementZones.some((zone) => zone === value.placementZone)
    && (!value.entityTypes || value.entityTypes.length === 0)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${value.placementZone} launchers require at least one entityType`,
      path: ["entityTypes"],
    });
  }

  if (
    value.placementZone === "projectSidebarItem"
    && value.entityTypes
    && !value.entityTypes.includes("project")
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "projectSidebarItem launchers require entityTypes to include \"project\"",
      path: ["entityTypes"],
    });
  }

  if (value.action.type === "performAction" && value.render) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "performAction launchers cannot declare render hints",
      path: ["render"],
    });
  }

  if (
    ["openModal", "openDrawer", "openPopover"].includes(value.action.type)
    && !value.render
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${value.action.type} launchers require render metadata`,
      path: ["render"],
    });
  }

  if (value.action.type === "openModal" && value.render?.environment === "hostInline") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "openModal launchers cannot use the hostInline render environment",
      path: ["render", "environment"],
    });
  }

  if (
    value.action.type === "openDrawer"
    && value.render
    && !["hostOverlay", "iframe"].includes(value.render.environment)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "openDrawer launchers must use hostOverlay or iframe render environments",
      path: ["render", "environment"],
    });
  }

  if (value.action.type === "openPopover" && value.render?.environment === "hostRoute") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "openPopover launchers cannot use the hostRoute render environment",
      path: ["render", "environment"],
    });
  }
});

export type PluginLauncherDeclarationInput = z.infer<typeof pluginLauncherDeclarationSchema>;

// ---------------------------------------------------------------------------
// Plugin Manifest V1 schema
// ---------------------------------------------------------------------------

export const pluginManifestV1Schema = z.object({
  id: z.string().min(1).regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "Plugin id must start with a lowercase alphanumeric and contain only lowercase letters, digits, dots, hyphens, or underscores",
  ),
  apiVersion: z.literal(1),
  version: z.string().min(1).regex(
    /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/,
    "Version must follow semver (e.g. 1.0.0 or 1.0.0-beta.1)",
  ),
  displayName: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  author: z.string().min(1).max(200),
  categories: z.array(z.enum(PLUGIN_CATEGORIES)).min(1),
  minimumHostVersion: z.string().regex(
    /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/,
    "minimumHostVersion must follow semver (e.g. 1.0.0)",
  ).optional(),
  minimumCombyneVersion: z.string().regex(
    /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/,
    "minimumCombyneVersion must follow semver (e.g. 1.0.0)",
  ).optional(),
  capabilities: z.array(z.enum(PLUGIN_CAPABILITIES)).min(1),
  entrypoints: z.object({
    worker: z.string().min(1),
    ui: z.string().min(1).optional(),
  }),
  instanceConfigSchema: jsonSchemaSchema.optional(),
  jobs: z.array(pluginJobDeclarationSchema).optional(),
  webhooks: z.array(pluginWebhookDeclarationSchema).optional(),
  tools: z.array(pluginToolDeclarationSchema).optional(),
  launchers: z.array(pluginLauncherDeclarationSchema).optional(),
  ui: z.object({
    slots: z.array(pluginUiSlotDeclarationSchema).min(1).optional(),
    launchers: z.array(pluginLauncherDeclarationSchema).optional(),
  }).optional(),
}).superRefine((manifest, ctx) => {
  const hasUiSlots = (manifest.ui?.slots?.length ?? 0) > 0;
  const hasUiLaunchers = (manifest.ui?.launchers?.length ?? 0) > 0;
  if ((hasUiSlots || hasUiLaunchers) && !manifest.entrypoints.ui) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "entrypoints.ui is required when ui.slots or ui.launchers are declared",
      path: ["entrypoints", "ui"],
    });
  }

  if (
    manifest.minimumHostVersion
    && manifest.minimumCombyneVersion
    && manifest.minimumHostVersion !== manifest.minimumCombyneVersion
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "minimumHostVersion and minimumCombyneVersion must match when both are declared",
      path: ["minimumHostVersion"],
    });
  }

  if (manifest.tools && manifest.tools.length > 0) {
    if (!manifest.capabilities.includes("agent.tools.register")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Capability 'agent.tools.register' is required when tools are declared",
        path: ["capabilities"],
      });
    }
  }

  if (manifest.jobs && manifest.jobs.length > 0) {
    if (!manifest.capabilities.includes("jobs.schedule")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Capability 'jobs.schedule' is required when jobs are declared",
        path: ["capabilities"],
      });
    }
  }

  if (manifest.webhooks && manifest.webhooks.length > 0) {
    if (!manifest.capabilities.includes("webhooks.receive")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Capability 'webhooks.receive' is required when webhooks are declared",
        path: ["capabilities"],
      });
    }
  }

  if (manifest.jobs) {
    const jobKeys = manifest.jobs.map((j) => j.jobKey);
    const duplicates = jobKeys.filter((key, i) => jobKeys.indexOf(key) !== i);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate job keys: ${[...new Set(duplicates)].join(", ")}`,
        path: ["jobs"],
      });
    }
  }

  if (manifest.webhooks) {
    const endpointKeys = manifest.webhooks.map((w) => w.endpointKey);
    const duplicates = endpointKeys.filter((key, i) => endpointKeys.indexOf(key) !== i);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate webhook endpoint keys: ${[...new Set(duplicates)].join(", ")}`,
        path: ["webhooks"],
      });
    }
  }

  if (manifest.tools) {
    const toolNames = manifest.tools.map((t) => t.name);
    const duplicates = toolNames.filter((name, i) => toolNames.indexOf(name) !== i);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate tool names: ${[...new Set(duplicates)].join(", ")}`,
        path: ["tools"],
      });
    }
  }

  if (manifest.ui) {
    if (manifest.ui.slots) {
      const slotIds = manifest.ui.slots.map((s) => s.id);
      const duplicates = slotIds.filter((id, i) => slotIds.indexOf(id) !== i);
      if (duplicates.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate UI slot ids: ${[...new Set(duplicates)].join(", ")}`,
          path: ["ui", "slots"],
        });
      }
    }
  }

  const allLaunchers = [
    ...(manifest.launchers ?? []),
    ...(manifest.ui?.launchers ?? []),
  ];
  if (allLaunchers.length > 0) {
    const launcherIds = allLaunchers.map((launcher) => launcher.id);
    const duplicates = launcherIds.filter((id, i) => launcherIds.indexOf(id) !== i);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate launcher ids: ${[...new Set(duplicates)].join(", ")}`,
        path: manifest.ui?.launchers ? ["ui", "launchers"] : ["launchers"],
      });
    }
  }
});

export type PluginManifestV1Input = z.infer<typeof pluginManifestV1Schema>;

// ---------------------------------------------------------------------------
// Plugin installation / registration request
// ---------------------------------------------------------------------------

export const installPluginSchema = z.object({
  packageName: z.string().min(1),
  version: z.string().min(1).optional(),
  packagePath: z.string().min(1).optional(),
});

export type InstallPlugin = z.infer<typeof installPluginSchema>;

// ---------------------------------------------------------------------------
// Plugin config (instance configuration) schemas
// ---------------------------------------------------------------------------

export const upsertPluginConfigSchema = z.object({
  configJson: z.record(z.unknown()),
});

export type UpsertPluginConfig = z.infer<typeof upsertPluginConfigSchema>;

export const patchPluginConfigSchema = z.object({
  configJson: z.record(z.unknown()),
});

export type PatchPluginConfig = z.infer<typeof patchPluginConfigSchema>;

// ---------------------------------------------------------------------------
// Plugin status update
// ---------------------------------------------------------------------------

export const updatePluginStatusSchema = z.object({
  status: z.enum(PLUGIN_STATUSES),
  lastError: z.string().nullable().optional(),
});

export type UpdatePluginStatus = z.infer<typeof updatePluginStatusSchema>;

// ---------------------------------------------------------------------------
// Plugin uninstall
// ---------------------------------------------------------------------------

export const uninstallPluginSchema = z.object({
  removeData: z.boolean().optional().default(false),
});

export type UninstallPlugin = z.infer<typeof uninstallPluginSchema>;

// ---------------------------------------------------------------------------
// Plugin state (key-value storage) schemas
// ---------------------------------------------------------------------------

export const pluginStateScopeKeySchema = z.object({
  scopeKind: z.enum(PLUGIN_STATE_SCOPE_KINDS),
  scopeId: z.string().min(1).optional(),
  namespace: z.string().min(1).optional(),
  stateKey: z.string().min(1),
});

export type PluginStateScopeKey = z.infer<typeof pluginStateScopeKeySchema>;

export const setPluginStateSchema = z.object({
  scopeKind: z.enum(PLUGIN_STATE_SCOPE_KINDS),
  scopeId: z.string().min(1).optional(),
  namespace: z.string().min(1).optional(),
  stateKey: z.string().min(1),
  value: z.unknown(),
});

export type SetPluginState = z.infer<typeof setPluginStateSchema>;

export const listPluginStateSchema = z.object({
  scopeKind: z.enum(PLUGIN_STATE_SCOPE_KINDS).optional(),
  scopeId: z.string().min(1).optional(),
  namespace: z.string().min(1).optional(),
});

export type ListPluginState = z.infer<typeof listPluginStateSchema>;
