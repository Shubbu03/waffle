import { expect, test } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";
import { waitForDatabase } from "../src/startup.ts";

function transportFailure(code: string) {
  return new DrizzleQueryError("SELECT restricted login facts", [], Object.assign(new Error("private"), { code }));
}

test("startup waits through DNS failures and verifies the login after connectivity recovers", async () => {
  let attempts = 0;
  const waits: number[] = [];
  const retries: unknown[] = [];
  await waitForDatabase(
    async () => {
      if (++attempts <= 2) throw transportFailure("ENOTFOUND");
    },
    { onRetry: (status) => retries.push(status), wait: async (ms) => waits.push(ms) },
  );
  expect(attempts).toBe(3);
  expect(waits).toEqual([2000, 4000]);
  expect(retries).toEqual([
    { code: "ENOTFOUND", attempt: 1, retryInMs: 2000 },
    { code: "ENOTFOUND", attempt: 2, retryInMs: 4000 },
  ]);
});

test("startup recovery caps delay at 30 seconds without giving up on a temporary outage", async () => {
  let attempts = 0;
  const waits: number[] = [];
  await waitForDatabase(
    async () => {
      if (++attempts <= 7) throw transportFailure("EAI_AGAIN");
    },
    { onRetry: () => {}, wait: async (ms) => waits.push(ms) },
  );
  expect(waits).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test("invalid roles, authentication and SQL errors fail immediately without retry", async () => {
  for (const error of [
    new Error("Login must be a non-owner member of waffle_api only"),
    transportFailure("28P01"),
    transportFailure("42P01"),
    Object.assign(new Error("provider DNS"), { code: "ENOTFOUND" }),
  ]) {
    let attempts = 0;
    await expect(
      waitForDatabase(
        async () => {
          attempts++;
          throw error;
        },
        {
          onRetry: () => {
            throw new Error("unexpected retry");
          },
        },
      ),
    ).rejects.toBe(error);
    expect(attempts).toBe(1);
  }
});
