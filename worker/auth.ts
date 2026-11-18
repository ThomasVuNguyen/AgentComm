import { createRemoteJWKSet, jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";
import { newSecret, now, sha256Hex } from "./lib";

export type Actor = { kind: "human" | "agent"; name: string };
export type AppEnv = { Bindings: Env; Variables: { actor: Actor } };

const jwksByTeam = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/** The owner, signed in through Cloudflare Access (or DEV_AUTH_EMAIL locally). */
async function humanFromAccess(req: Request, env: Env): Promise<Actor | null> {
  if (env.DEV_AUTH_EMAIL) return { kind: "human", name: env.DEV_AUTH_EMAIL.split("@")[0] };

  // Fail closed until Access is configured.
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.OWNER_EMAIL) return null;
  const token = req.headers.get("cf-access-jwt-assertion") ?? readCookie(req, "CF_Authorization");
  if (!token) return null;

  const team = env.ACCESS_TEAM_DOMAIN.replace(/\/$/, "");
  let jwks = jwksByTeam.get(team);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`));
    jwksByTeam.set(team, jwks);
  }
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: team, audience: env.ACCESS_AUD });
    const email = String(payload.email ?? "").toLowerCase();
    if (email !== env.OWNER_EMAIL.toLowerCase()) return null;
    return { kind: "human", name: email.split("@")[0] };
  } catch {
    return null;
  }
}

/** An agent presenting `Authorization: Bearer ac_…`. */
async function agentFromToken(req: Request, env: Env): Promise<Actor | null> {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const hash = await sha256Hex(header.slice(7).trim());
  const row = await env.DB.prepare("SELECT id, name FROM agents WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(hash)
    .first<{ id: string; name: string }>();
  if (!row) return null;
  const t = now();
  await env.DB.prepare("UPDATE agents SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)")
    .bind(t, row.id, t - 30_000)
    .run();
  return { kind: "agent", name: row.name };
}

export async function authenticate(req: Request, env: Env): Promise<Actor | null> {
  if (req.headers.has("authorization")) return agentFromToken(req, env);
  return humanFromAccess(req, env);
}

export const requireActor: MiddlewareHandler<AppEnv> = async (c, next) => {
  const actor = await authenticate(c.req.raw, c.env);
  if (!actor) return c.json({ error: "unauthorized" }, 401);
  c.set("actor", actor);
  await next();
};

export const requireHuman: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("actor").kind !== "human") return c.json({ error: "only the owner can do this" }, 403);
  await next();
};

export function newAgentToken(): string {
  return `ac_${newSecret()}`;
}
