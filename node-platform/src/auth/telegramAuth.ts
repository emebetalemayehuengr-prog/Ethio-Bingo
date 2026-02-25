import crypto from "crypto";
import jwt, { SignOptions } from "jsonwebtoken";

export interface TelegramUserPayload {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export function validateTelegramInitData(initData: string, botToken: string): { ok: boolean; user?: TelegramUserPayload } {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false };

  const fields: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === "hash") continue;
    fields.push(`${key}=${value}`);
  }
  fields.sort();
  const checkString = fields.join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calculated = crypto.createHmac("sha256", secretKey).update(checkString).digest("hex");

  const a = Buffer.from(calculated, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length) return { ok: false };
  if (!crypto.timingSafeEqual(a, b)) return { ok: false };

  const userRaw = params.get("user");
  if (!userRaw) return { ok: true };

  try {
    return { ok: true, user: JSON.parse(userRaw) as TelegramUserPayload };
  } catch {
    return { ok: true };
  }
}

export function issueJwtSession(input: { userId: string; jwtSecret: string; expiresIn: SignOptions["expiresIn"] }) {
  const options: SignOptions = {
    algorithm: "HS256",
    expiresIn: input.expiresIn,
    jwtid: crypto.randomUUID(),
  };
  return jwt.sign({ sub: input.userId, scope: "player" }, input.jwtSecret, options);
}
