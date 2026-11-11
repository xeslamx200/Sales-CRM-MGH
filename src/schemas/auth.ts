import { z } from "zod";

/** Shared by client forms and server actions. */
export const signInSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(1).max(200),
  next: z.string().max(500).optional(),
});

export const emailSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
});

export const MIN_PASSWORD = 10;

/** Forms pass a localized mismatch message; the server uses the default. */
export const makeNewPasswordSchema = (mismatch = "mismatch") =>
  z
    .object({
      password: z.string().min(MIN_PASSWORD).max(200),
      confirm: z.string(),
    })
    .refine((v) => v.password === v.confirm, { path: ["confirm"], message: mismatch });

export const makeAcceptInviteSchema = (mismatch = "mismatch") =>
  z
    .object({
      fullName: z.string().trim().min(1).max(200),
      password: z.string().min(MIN_PASSWORD).max(200),
      confirm: z.string(),
    })
    .refine((v) => v.password === v.confirm, { path: ["confirm"], message: mismatch });

export const newPasswordSchema = makeNewPasswordSchema();
export const acceptInviteSchema = makeAcceptInviteSchema();

export const profileSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(30).nullable(),
  locale: z.enum(["ar", "en"]),
});
