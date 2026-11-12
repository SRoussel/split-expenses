// The whole backend: a small JSON API on top of D1. Static files are served by
// Cloudflare before this runs; only /api/* reaches this Worker.
// The routes live in auth.ts, passkeys.ts, household.ts, entries.ts, recurring.ts, spending.ts
// and desktop.ts (the desktop app, with its own kind of key).

import { changePassword, login, logout, me, signup } from "./auth";
import { desktopBudgets, desktopHousehold, desktopImport, desktopRemove, revokeDesktopKey } from "./desktop";
import { addEntry, editEntry, unvoidEntry, voidEntry } from "./entries";
import { createHousehold, getHousehold, joinHousehold, purgeVoided, resetHousehold, setSplit } from "./household";
import {
  confirm,
  confirmOptions,
  deletePasskey,
  disablePassword,
  enablePassword,
  getAccount,
  loginOptions,
  loginVerify,
  registerOptions,
  registerVerify,
} from "./passkeys";
import { assertSameOrigin, type Env, HttpError, json } from "./http";
import { createRecurring, stopRecurring, updateRecurring } from "./recurring";
import { deleteBatch, getSpending, importStatement, moveSpending } from "./spending";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method;
    try {
      // The desktop app: a desktop key, never a cookie (see desktop.ts).
      if (pathname.startsWith("/api/desktop/")) {
        if (method === "GET" && pathname === "/api/desktop/household") return await desktopHousehold(request, env);
        if (method === "POST" && pathname === "/api/desktop/import") return await desktopImport(request, env);
        if (method === "POST" && pathname === "/api/desktop/budgets") return await desktopBudgets(request, env);
        const u = pathname.match(/^\/api\/desktop\/uploads\/([\w-]+)\/remove$/);
        if (method === "POST" && u) return await desktopRemove(request, env, u[1]);
        throw new HttpError(404, "Not found.");
      }
      if (method === "GET" && pathname === "/api/me") return await me(request, env);
      if (method === "GET" && pathname === "/api/household") return await getHousehold(request, env);
      if (method === "GET" && pathname === "/api/spending") return await getSpending(request, env);
      if (method === "GET" && pathname === "/api/account") return await getAccount(request, env);
      if (method === "POST") {
        assertSameOrigin(request);
        if (pathname === "/api/password") return await changePassword(request, env);
        if (pathname === "/api/signup") return await signup(request, env);
        if (pathname === "/api/login") return await login(request, env);
        if (pathname === "/api/logout") return await logout(request, env);
        if (pathname === "/api/passkeys/register/options") return await registerOptions(request, env);
        if (pathname === "/api/passkeys/register/verify") return await registerVerify(request, env);
        if (pathname === "/api/passkeys/login/options") return await loginOptions(request, env);
        if (pathname === "/api/passkeys/login/verify") return await loginVerify(request, env);
        if (pathname === "/api/confirm/options") return await confirmOptions(request, env);
        if (pathname === "/api/confirm") return await confirm(request, env);
        if (pathname === "/api/password/disable") return await disablePassword(request, env);
        if (pathname === "/api/password/enable") return await enablePassword(request, env);
        const dk = pathname.match(/^\/api\/desktop-keys\/([\w-]+)\/delete$/);
        if (dk) return await revokeDesktopKey(request, env, dk[1]);
        const pk = pathname.match(/^\/api\/passkeys\/([\w-]+)\/delete$/);
        if (pk) return await deletePasskey(request, env, pk[1]);
        if (pathname === "/api/household") return await createHousehold(request, env);
        if (pathname === "/api/household/join") return await joinHousehold(request, env);
        if (pathname === "/api/household/split") return await setSplit(request, env);
        if (pathname === "/api/household/purge-voided") return await purgeVoided(request, env);
        if (pathname === "/api/household/reset") return await resetHousehold(request, env);
        if (pathname === "/api/statements/import") return await importStatement(request, env);
        if (pathname === "/api/spending/move") return await moveSpending(request, env);
        const b = pathname.match(/^\/api\/statements\/([\w-]+)\/delete$/);
        if (b) return await deleteBatch(request, env, b[1]);
        if (pathname === "/api/recurring") return await createRecurring(request, env);
        const r = pathname.match(/^\/api\/recurring\/([\w-]+)\/(update|stop)$/);
        if (r?.[2] === "update") return await updateRecurring(request, env, r[1]);
        if (r?.[2] === "stop") return await stopRecurring(request, env, r[1]);
        if (pathname === "/api/entries") return await addEntry(request, env);
        const m = pathname.match(/^\/api\/entries\/([\w-]+)\/(void|unvoid|edit)$/);
        if (m?.[2] === "void") return await voidEntry(request, env, m[1]);
        if (m?.[2] === "unvoid") return await unvoidEntry(request, env, m[1]);
        if (m?.[2] === "edit") return await editEntry(request, env, m[1]);
      }
      throw new HttpError(404, "Not found.");
    } catch (err) {
      if (err instanceof HttpError)
        return json({ error: err.message, ...(err.code && { code: err.code }) }, err.status);
      console.error(err);
      return json({ error: "Something went wrong on the server." }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
