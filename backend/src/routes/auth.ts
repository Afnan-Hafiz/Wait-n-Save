import { Router, Request, Response, NextFunction } from "express";
import bcrypt from "bcrypt";
import jwt, { type SignOptions } from "jsonwebtoken";
import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { query } from "../db/client";
import { requireAuth } from "../middleware/auth";
import { config } from "../config";
import { getTransport } from "../services/mailer";

const RESET_EXPIRY_HOURS = 1;
const resetEmailTemplate = readFileSync(
  join(__dirname, "../templates/passwordReset.html"),
  "utf8"
);

const jwtOptions: SignOptions = { expiresIn: config.jwtExpiresIn as SignOptions["expiresIn"] };

const router = Router();

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// ── POST /api/auth/register ───────────────────────────────────────────────────
router.post(
  "/register",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password } = RegisterSchema.parse(req.body);
      const passwordHash = await bcrypt.hash(password, 12);

      const rows = await query<{ id: string; email: string }>(
        `INSERT INTO users (email, password_hash)
         VALUES ($1, $2)
         RETURNING id, email`,
        [email.toLowerCase(), passwordHash]
      );

      const user = rows[0];
      const token = jwt.sign(
        { userId: user.id, email: user.email },
        config.jwtSecret,
        jwtOptions
      );

      res.status(201).json({ token, user: { id: user.id, email: user.email } });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post(
  "/login",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password } = LoginSchema.parse(req.body);

      const rows = await query<{ id: string; email: string; password_hash: string }>(
        `SELECT id, email, password_hash FROM users WHERE email = $1`,
        [email.toLowerCase()]
      );

      const user = rows[0];
      if (!user) {
        res.status(401).json({ error: "Invalid credentials" });
        return;
      }

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        res.status(401).json({ error: "Invalid credentials" });
        return;
      }

      const token = jwt.sign(
        { userId: user.id, email: user.email },
        config.jwtSecret,
        jwtOptions
      );

      res.json({ token, user: { id: user.id, email: user.email } });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
router.get(
  "/me",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await query<{ id: string; email: string; created_at: string }>(
        `SELECT id, email, created_at FROM users WHERE id = $1`,
        [req.auth!.userId]
      );
      if (!rows[0]) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      res.json({ user: rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/auth/forgot-password ───────────────────────────────────────────
const ForgotSchema = z.object({ email: z.string().email() });

router.post(
  "/forgot-password",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email } = ForgotSchema.parse(req.body);

      // Always respond 200 — don't reveal if the email exists
      const users = await query<{ id: string; email: string }>(
        `SELECT id, email FROM users WHERE email = $1`,
        [email.toLowerCase()]
      );

      if (users[0]) {
        const token = randomBytes(32).toString("hex");
        const expires = new Date(Date.now() + RESET_EXPIRY_HOURS * 60 * 60 * 1000);

        await query(
          `UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3`,
          [token, expires.toISOString(), users[0].id]
        );

        const html = resetEmailTemplate
          .replace(/{{EMAIL}}/g, users[0].email)
          .replace(/{{RESET_TOKEN}}/g, token);

        const transport = getTransport();
        await transport.sendMail({
          from: `"${config.email.fromName}" <${config.email.gmailUser || "noreply@waitnsave.app"}>`,
          to: users[0].email,
          subject: "Reset your Wait-n-Save password",
          html,
        });
      }

      // Generic response regardless of whether email matched
      res.json({ message: "If that email is registered, a reset token has been sent." });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/auth/reset-password ────────────────────────────────────────────
const ResetSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

router.post(
  "/reset-password",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token, password } = ResetSchema.parse(req.body);

      const users = await query<{ id: string; email: string; reset_token_expires: string }>(
        `SELECT id, email, reset_token_expires
         FROM users
         WHERE reset_token = $1`,
        [token]
      );

      const user = users[0];

      if (!user) {
        res.status(400).json({ error: "Invalid or expired reset token." });
        return;
      }

      if (new Date(user.reset_token_expires) < new Date()) {
        res.status(400).json({ error: "Reset token has expired. Please request a new one." });
        return;
      }

      const passwordHash = await bcrypt.hash(password, 12);

      await query(
        `UPDATE users
         SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL
         WHERE id = $2`,
        [passwordHash, user.id]
      );

      res.json({ message: "Password updated successfully. You can now sign in." });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
