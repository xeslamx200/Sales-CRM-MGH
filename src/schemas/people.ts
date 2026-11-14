import { z } from "zod";
import { Constants } from "@/types/database";
import { MIN_PASSWORD } from "./auth";

const roles = Constants.public.Enums.app_role;
const phone = z.string().trim().max(30).nullable().or(z.literal("").transform(() => null));
const fullName = z.string().trim().min(1).max(200);
const email = z.string().trim().toLowerCase().email().max(320);
const password = z.string().min(MIN_PASSWORD).max(200);
const customRoleId = z.uuid().nullable().or(z.literal("").transform(() => null));

/** A company admin creates the account of a person: e-mail, password, name, phone, role and (optionally) team. */
export const createPersonSchema = z.object({
  companyId: z.uuid(),
  fullName,
  email,
  phone,
  role: z.enum(roles),
  customRoleId,
  password,
  teamId: z.uuid().nullable().or(z.literal("").transform(() => null)),
});

export const updatePersonSchema = z.object({
  companyId: z.uuid(),
  userId: z.uuid(),
  fullName,
  email,
  phone,
  role: z.enum(roles),
  customRoleId,
  isActive: z.boolean(),
});

export const resetPasswordSchema = z.object({ companyId: z.uuid(), userId: z.uuid(), password });
export const removePersonSchema = z.object({ companyId: z.uuid(), userId: z.uuid() });
