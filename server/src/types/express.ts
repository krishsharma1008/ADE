type CombyneActor = {
  type: "board" | "agent" | "none";
  source: string;
  userId?: string;
  companyIds?: string[];
  isInstanceAdmin?: boolean;
  agentId?: string;
  companyId?: string;
  keyId?: string;
  runId?: string;
  [key: string]: unknown;
};

declare global {
  namespace Express {
    interface Request {
      actor: CombyneActor;
    }
  }
}

export {};
