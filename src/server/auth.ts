import type { Request, Response, NextFunction } from "express";
import type { Tenant } from "../config.js";

declare global {
  namespace Express {
    interface Request {
      tenant?: Tenant;
    }
  }
}

export function createAuthMiddleware(tenants: Tenant[]) {
  const keyMap = new Map<string, Tenant>();
  for (const t of tenants) {
    keyMap.set(t.api_key, t);
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    // No tenants configured — allow all
    if (tenants.length === 0) {
      req.tenant = { name: "default", api_key: "" };
      next();
      return;
    }

    const apiKey =
      req.headers["x-api-key"] as string ||
      extractBearer(req.headers["authorization"] as string);

    if (!apiKey) {
      res.status(401).json({
        type: "error",
        error: { type: "authentication_error", message: "Missing API key" },
      });
      return;
    }

    const tenant = keyMap.get(apiKey);
    if (!tenant) {
      res.status(401).json({
        type: "error",
        error: { type: "authentication_error", message: "Invalid API key" },
      });
      return;
    }

    req.tenant = tenant;
    next();
  };
}

function extractBearer(header?: string): string | undefined {
  if (!header) return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}
