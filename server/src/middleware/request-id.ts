import type { Request, Response, NextFunction } from "express";

/**
 * Echo the pino-http generated req.id back as an X-Request-Id response header
 * so browser Network-tab failures can be correlated to a server log line.
 *
 * Must be mounted AFTER httpLogger so req.id is populated.
 */
export function requestIdHeader() {
  return (req: Request, res: Response, next: NextFunction) => {
    const id = (req as { id?: string | number }).id;
    if (id !== undefined && !res.getHeader("X-Request-Id")) {
      res.setHeader("X-Request-Id", String(id));
    }
    next();
  };
}
