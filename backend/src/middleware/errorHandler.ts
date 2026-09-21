import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";

export interface AppError extends Error {
  statusCode?: number;
}

export function errorHandler(
  err: AppError,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  // Zod validation errors → 400
  if (err instanceof ZodError) {
    res.status(400).json({
      error: "Validation error",
      details: err.flatten().fieldErrors,
    });
    return;
  }

  // Known application errors with explicit status codes
  if (err.statusCode) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  // Unique constraint violations from Postgres
  if ((err as unknown as { code?: string }).code === "23505") {
    res.status(409).json({ error: "Resource already exists" });
    return;
  }

  // Unexpected errors — don't leak internals in production
  console.error("[Unhandled Error]", err);
  res.status(500).json({ error: "Internal server error" });
}

/** Helper to create errors with a status code attached */
export function createError(message: string, statusCode: number): AppError {
  const err: AppError = new Error(message);
  err.statusCode = statusCode;
  return err;
}
