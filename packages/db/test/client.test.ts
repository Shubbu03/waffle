import { expect, test } from "bun:test";
import { isRestrictedApiLogin } from "../src/client.ts";

test("API login excludes owner and bypass privileges", () => {
  const restricted = {
    canLogin: true,
    superuser: false,
    bypassRls: false,
    createRole: false,
    ownsAppTables: false,
    apiRoleUsable: true,
    watcherMember: false,
    deliveryMember: false,
  };
  expect(isRestrictedApiLogin(restricted)).toBe(true);
  for (const flag of [
    "superuser",
    "bypassRls",
    "createRole",
    "ownsAppTables",
    "watcherMember",
    "deliveryMember",
  ] as const) {
    expect(isRestrictedApiLogin({ ...restricted, [flag]: true })).toBe(false);
  }
  expect(isRestrictedApiLogin({ ...restricted, apiRoleUsable: false })).toBe(false);
  expect(isRestrictedApiLogin({ ...restricted, canLogin: false })).toBe(false);
});

test("watcher login excludes ownership, bypass privileges and other application roles", async () => {
  const { isRestrictedWatcherLogin } = await import("../src/watcher.ts");
  const restricted = {
    canLogin: true,
    superuser: false,
    bypassRls: false,
    createRole: false,
    ownsAppTables: false,
    watcherRoleUsable: true,
    apiMember: false,
    deliveryMember: false,
  };
  expect(isRestrictedWatcherLogin(restricted)).toBe(true);
  for (const flag of [
    "superuser",
    "bypassRls",
    "createRole",
    "ownsAppTables",
    "apiMember",
    "deliveryMember",
  ] as const) {
    expect(isRestrictedWatcherLogin({ ...restricted, [flag]: true })).toBe(false);
  }
  expect(isRestrictedWatcherLogin({ ...restricted, watcherRoleUsable: false })).toBe(false);
  expect(isRestrictedWatcherLogin({ ...restricted, canLogin: false })).toBe(false);
});
